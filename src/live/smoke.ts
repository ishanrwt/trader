import type { KeyPairSigner } from "@solana/kit";
import type { JupiterBuildParams, JupiterBuildResponse } from "../clients/jupiter.js";
import type { Config } from "../config/index.js";
import { BASE_FEE_LAMPORTS, LAMPORTS_PER_SOL } from "../config/validate.js";
import type { IntentsStore } from "../storage/intents.js";
import type { ConfirmationPool, TxOutcome } from "./confirm.js";
import { extractConfirmedEffects, lamportsToUsd, solReceivedFromEffects, usdcRawToUsd } from "./fills.js";
import { buildVerifySign, type PipelineResult } from "./pipeline.js";
import { JUPITER_AGGREGATOR_PROGRAM, USDC_MINT, WSOL_MINT } from "./programs.js";
import { parseAccount } from "./simulation.js";
import type { TxRpc } from "./txRpc.js";

/** SPEC.md section 16 constants: smoke-live swaps exactly 1 USDC. */
export const SMOKE_USDC_RAW = 1_000_000n;
export const SMOKE_CONFIRM_PHRASE = "send 1 usdc";
import { HEARTBEAT_FRESH_MS } from "../startup/instanceGuard.js";
/** A heartbeat younger than this means a bot is running from this same folder (shared with the bot's startup guard). */
export { HEARTBEAT_FRESH_MS };

export interface SmokeDeps {
  config: Config;
  signer: KeyPairSigner;
  rpc: Pick<TxRpc, "simulate" | "getMultipleAccounts" | "sendTransaction" | "getTransaction">;
  jupiter: { build(p: JupiterBuildParams): Promise<JupiterBuildResponse> };
  pool: Pick<ConfirmationPool, "track">;
  intents: IntentsStore;
  /** This folder's database heartbeat (lastAliveAt), or null. */
  lastAliveAt: number | null;
  send: boolean;
  isTTY: boolean;
  ask: (prompt: string) => Promise<string>;
  print: (line: string) => void;
  solPriceUsd: number | null;
  now: () => number;
}

/**
 * `npm run smoke-live` (SPEC.md section 16.8, A5). Default: dry run (build,
 * simulate, verify both legs, print; never sends). With --send: after the
 * typed confirmation in an interactive terminal, 1 USDC -> SOL, confirm,
 * measure the SOL actually received, sell exactly that back to USDC, print
 * the accounting. Only USDC and SOL are ever touched; no positions or trades.
 * Returns the process exit code.
 */
export async function runSmoke(d: SmokeDeps): Promise<number> {
  const wallet = d.signer.address;
  if (d.lastAliveAt !== null && d.now() - d.lastAliveAt < HEARTBEAT_FRESH_MS) {
    d.print("Refusing: this folder's database heartbeat is less than 2 minutes old, so a bot is probably running from this folder. Stop it first.");
    d.print("(This check can't see a bot running from another folder: stop the paper bot yourself before running smoke-live.)");
    return 1;
  }
  const maxFeeLamports = BigInt(BASE_FEE_LAMPORTS + d.config.maxPriorityFeeLamports);
  d.print(`Wallet (public address): ${wallet}`);
  d.print(`Mode: ${d.send ? "SEND (real transactions)" : "dry run (nothing is sent)"}`);
  d.print(`Leg 1: ${usdcRawToUsd(SMOKE_USDC_RAW)} USDC -> SOL. Leg 2: the SOL received -> USDC. Max network fee per leg: ${Number(maxFeeLamports) / LAMPORTS_PER_SOL} SOL.`);

  if (d.send) {
    if (!d.isTTY) {
      d.print("Refusing: --send needs an interactive terminal to type the confirmation.");
      return 1;
    }
    const answer = (await d.ask(`Type "${SMOKE_CONFIRM_PHRASE}" to send real transactions: `)).trim();
    if (answer !== SMOKE_CONFIRM_PHRASE) {
      d.print("Confirmation not given. Nothing was sent.");
      return 1;
    }
  }

  // ---- Leg 1: USDC -> SOL ----
  const leg1 = await prepareLeg(d, "leg1", { inputMint: USDC_MINT, outputMint: WSOL_MINT, amountRaw: SMOKE_USDC_RAW });
  if (!leg1.result.ok) return 1;
  if (!d.send) {
    d.intents.resolve(leg1.intentId, "abandoned", d.now(), { error: "dry run" });
    const quotedSol = leg1.result.outAmountRaw;
    const [acct] = await d.rpc.getMultipleAccounts([wallet], "tx");
    const lamports = parseAccount(acct ?? null, "wallet")?.lamports ?? 0n;
    if (lamports < quotedSol + maxFeeLamports) {
      d.print(`Leg 2 not verified: the wallet holds ${Number(lamports) / LAMPORTS_PER_SOL} SOL, less than leg 1's quoted output plus fees; in a real run leg 2 sells the SOL leg 1 actually received.`);
    } else {
      const leg2 = await prepareLeg(d, "leg2", { inputMint: WSOL_MINT, outputMint: USDC_MINT, amountRaw: quotedSol });
      if (leg2.result.ok) d.intents.resolve(leg2.intentId, "abandoned", d.now(), { error: "dry run" });
      else return 1;
    }
    d.print("Dry run complete. Nothing was sent.");
    return 0;
  }

  const out1 = await sendLeg(d, leg1.intentId, leg1.result, SMOKE_USDC_RAW);
  if (out1.outcome !== "landed" || !out1.tx) {
    d.print(`Leg 1 ${out1.outcome}. Stopping; leg 2 was not attempted.`);
    return 1;
  }
  const e1 = extractConfirmedEffects(out1.tx, wallet);
  const solReceived = solReceivedFromEffects(e1);
  const usdcIn = -(e1.tokenDeltas.get(USDC_MINT) ?? 0n);
  d.print(`Leg 1 landed: ${out1.signature}. Spent ${usdcRawToUsd(usdcIn)} USDC, received ${Number(solReceived) / LAMPORTS_PER_SOL} SOL, fee ${e1.feeLamports} lamports.`);

  // ---- Leg 2: exactly the SOL received -> USDC ----
  const leg2 = await prepareLeg(d, "leg2", { inputMint: WSOL_MINT, outputMint: USDC_MINT, amountRaw: solReceived });
  if (!leg2.result.ok) return 1;
  const out2 = await sendLeg(d, leg2.intentId, leg2.result, solReceived);
  if (out2.outcome !== "landed" || !out2.tx) {
    d.print(`Leg 2 ${out2.outcome}. You now hold the SOL from leg 1; no other tokens were touched.`);
    return 1;
  }
  const e2 = extractConfirmedEffects(out2.tx, wallet);
  const usdcOut = e2.tokenDeltas.get(USDC_MINT) ?? 0n;
  const fees = e1.feeLamports + e2.feeLamports;
  const price = d.solPriceUsd;
  d.print(`Leg 2 landed: ${out2.signature}. Sold ${Number(solReceived) / LAMPORTS_PER_SOL} SOL, received ${usdcRawToUsd(usdcOut)} USDC, fee ${e2.feeLamports} lamports.`);
  d.print("Accounting:");
  d.print(`  USDC in ${usdcRawToUsd(usdcIn)}, USDC out ${usdcRawToUsd(usdcOut)}, difference ${usdcRawToUsd(usdcOut - usdcIn).toFixed(6)} USDC`);
  d.print(`  fees: leg 1 ${e1.feeLamports} + leg 2 ${e2.feeLamports} = ${fees} lamports${price !== null ? ` ($${lamportsToUsd(fees, price).toFixed(4)} at $${price.toFixed(2)}/SOL)` : ""}`);
  if (price !== null) d.print(`  net cost: $${(usdcRawToUsd(usdcIn - usdcOut) + lamportsToUsd(fees, price)).toFixed(4)}`);
  return 0;
}

async function prepareLeg(
  d: SmokeDeps,
  leg: "leg1" | "leg2",
  req: { inputMint: string; outputMint: string; amountRaw: bigint },
): Promise<{ intentId: number; result: PipelineResult }> {
  const intentId = d.intents.reserve({
    kind: "smoke",
    mode: "live",
    mint: WSOL_MINT,
    positionId: null,
    refKey: `smoke:${leg}`,
    side: req.inputMint === USDC_MINT ? "buy" : "sell",
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    now: d.now(),
  });
  let result: PipelineResult;
  try {
    const build = await d.jupiter.build({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: req.amountRaw.toString(),
      taker: d.signer.address,
      slippageBps: d.config.BUY_SLIPPAGE_BPS,
      computeUnitPricePercentile: d.config.priorityFeePercentile,
    });
    result = await buildVerifySign(
      {
        rpc: d.rpc,
        signer: d.signer,
        intents: d.intents,
        jupiterProgram: JUPITER_AGGREGATOR_PROGRAM,
        maxPriorityFeeLamports: BigInt(d.config.maxPriorityFeeLamports),
        hardMaxUsdcRaw: BigInt(d.config.hardMaxPositionUsd) * 1_000_000n,
        balanceFields: { missing: false },
      },
      { intentId, build, request: req, tradedMint: WSOL_MINT, after: [] },
    );
  } catch (err) {
    result = { ok: false, stage: "response", reason: String(err instanceof Error ? err.message : err) };
  }
  if (result.ok) {
    const fee = BigInt(BASE_FEE_LAMPORTS) + result.priorityFeeLamports;
    d.print(`${leg}: verification PASSED (balance source: ${result.source}); compute-unit limit ${result.cuLimit}, fee ${fee} lamports (${Number(fee) / LAMPORTS_PER_SOL} SOL), quoted out ${result.outAmountRaw}, minimum out ${result.minOutRaw}.`);
  } else {
    d.intents.resolve(intentId, "abandoned", d.now(), { error: `${result.stage}: ${result.reason}` });
    d.print(`${leg}: NOT sent (${result.stage}${result.check ? `, check ${result.check}` : ""}): ${result.reason}`);
  }
  return { intentId, result };
}

async function sendLeg(
  d: SmokeDeps,
  intentId: number,
  r: Extract<PipelineResult, { ok: true }>,
  expectedInRaw: bigint,
): Promise<{ outcome: TxOutcome; signature: string; tx: Record<string, unknown> | null }> {
  d.intents.markSigned(
    intentId,
    { signature: r.signature, signedTxB64: r.base64, lastValidBlockHeight: r.lastValidBlockHeight, expectedInRaw: expectedInRaw.toString(), expectedOutRaw: r.outAmountRaw.toString(), minOutRaw: r.minOutRaw.toString() },
    d.now(),
  );
  await d.rpc.sendTransaction(r.base64);
  d.intents.markSent(intentId, d.now());
  const outcome = await d.pool.track({ signature: r.signature, signedTxB64: r.base64, lastValidBlockHeight: r.lastValidBlockHeight });
  let tx: Record<string, unknown> | null = null;
  if (outcome !== "expired") {
    for (let i = 0; i < 5 && !tx; i++) tx = await d.rpc.getTransaction(r.signature).catch(() => null);
  }
  d.intents.resolve(intentId, outcome === "landed" ? "applied" : outcome, d.now(), tx ? { feeLamports: Number(extractConfirmedEffects(tx, d.signer.address).feeLamports) } : {});
  return { outcome, signature: r.signature, tx };
}
