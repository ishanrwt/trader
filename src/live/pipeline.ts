import type { Instruction, KeyPairSigner, Transaction } from "@solana/kit";
import type { JupiterBuildResponse } from "../clients/jupiter.js";
import { DuplicateIntentError, type IntentsStore } from "../storage/intents.js";
import {
  blockhashOf,
  compileV0,
  computeBudgetInstructions,
  CU_LIMIT_MAX,
  decodeForVerification,
  jupiterCuPrice,
  jupiterInstructions,
  lookupTables,
  signatureOf,
  signWith,
  wireBase64,
} from "./assemble.js";
import { decodeAta, maxCuPriceFor } from "./instructions.js";
import { ASSOCIATED_TOKEN_PROGRAM } from "./programs.js";
import { buildFallbackSimulation } from "./simFallback.js";
import { hasBalanceFields, normalizeSimulation, SimulationShapeError, type NormalizedSimulation } from "./simulation.js";
import type { TxRpc } from "./txRpc.js";
import { checkBuildResponse, verifyTransaction, type VerifyCheck } from "./verify.js";

export interface PipelineDeps {
  rpc: Pick<TxRpc, "simulate" | "getMultipleAccounts">;
  signer: KeyPairSigner;
  intents: IntentsStore;
  jupiterProgram: string;
  maxPriorityFeeLamports: bigint;
  hardMaxUsdcRaw: bigint;
  /**
   * Remembers whether this RPC omits the simulation balance fields. The first
   * time it does, the transaction is simulated again after the pre-read, so
   * the fallback's pre-state is always read immediately before a simulation.
   */
  balanceFields: { missing: boolean };
}

export interface PipelineInput {
  /** The `pending` intent reserved for this position/side before building (the guard, SPEC.md section 16.4). */
  intentId: number;
  build: JupiterBuildResponse;
  request: { inputMint: string; outputMint: string; amountRaw: bigint };
  tradedMint: string;
  /** Instructions appended after Jupiter's (the full sell's closeAccount). */
  after: Instruction[];
}

export type PipelineResult =
  | {
      ok: true;
      tx: Transaction;
      base64: string;
      signature: string;
      lastValidBlockHeight: number;
      minOutRaw: bigint;
      outAmountRaw: bigint;
      priorityFeeLamports: bigint;
      cuLimit: number;
      source: NormalizedSimulation["source"];
    }
  | { ok: false; stage: "response" | "simulation" | "refused" | "guard"; check?: VerifyCheck; reason: string };

/**
 * SPEC.md section 16.2 steps 1-5 for one transaction: check the /build
 * response; estimate compute units by simulation; clamp the compute-unit
 * price so the priority fee stays within MAX_PRIORITY_FEE_SOL; assemble;
 * re-check the one-transaction guard; sign; simulate the SIGNED bytes;
 * verify. Never sends. Any unexpected shape is a refusal (fail closed).
 */
export async function buildVerifySign(deps: PipelineDeps, input: PipelineInput): Promise<PipelineResult> {
  const wallet = deps.signer.address;
  const response = checkBuildResponse(input.build, { ...input.request }, deps.hardMaxUsdcRaw);
  if (!response.ok) return { ok: false, stage: "response", reason: response.reason };
  if (typeof input.build.outAmount !== "string" || !/^\d+$/.test(input.build.outAmount)) return { ok: false, stage: "response", reason: "outAmount is missing" };

  let jupPrice: bigint;
  let parts: ReturnType<typeof jupiterInstructions>;
  let alts: ReturnType<typeof lookupTables>;
  let lifetime: ReturnType<typeof blockhashOf>;
  try {
    jupPrice = jupiterCuPrice(input.build);
    parts = jupiterInstructions(input.build);
    alts = lookupTables(input.build.addressesByLookupTableAddress);
    lifetime = blockhashOf(input.build);
  } catch (err) {
    return { ok: false, stage: "response", reason: String(err instanceof Error ? err.message : err) };
  }
  const body = [...parts.setup, parts.swap, ...parts.cleanup, ...parts.other, ...input.after];

  // Step 2: compute-unit estimate (unsigned, replaceRecentBlockhash; nothing here can be sent).
  const estimateTx = compileV0([...computeBudgetInstructions(CU_LIMIT_MAX, jupPrice), ...body], wallet, lifetime, alts);
  const estimate = await deps.rpc.simulate(wireBase64(estimateTx), { sigVerify: false, replaceRecentBlockhash: true });
  if (estimate.err !== null) return { ok: false, stage: "simulation", reason: `simulation failed: ${JSON.stringify(estimate.err)}` };
  if (typeof estimate.unitsConsumed !== "number" || estimate.unitsConsumed <= 0) return { ok: false, stage: "simulation", reason: "simulation returned no unitsConsumed" };
  const cuLimit = Math.min(Math.ceil(estimate.unitsConsumed * 1.2), CU_LIMIT_MAX);
  const cap = maxCuPriceFor(deps.maxPriorityFeeLamports, cuLimit);
  const cuPrice = jupPrice < cap ? jupPrice : cap;

  const unsigned = compileV0([...computeBudgetInstructions(cuLimit, cuPrice), ...body], wallet, lifetime, alts);
  let decodedAll: ReturnType<typeof decodeForVerification>;
  try {
    decodedAll = decodeForVerification(unsigned, alts);
  } catch (err) {
    return { ok: false, stage: "refused", check: "shape", reason: String(err instanceof Error ? err.message : err) };
  }

  // The guard, again, right before signing (addition A).
  try {
    deps.intents.assertSoleUnresolved(input.intentId);
  } catch (err) {
    if (err instanceof DuplicateIntentError) return { ok: false, stage: "guard", reason: err.message };
    throw err;
  }
  const signed = await signWith(deps.signer, unsigned);
  const base64 = wireBase64(signed);

  // Step 4: simulate the exact signed bytes; step 5: verify.
  const created = decodedAll.decoded.instructions
    .filter((ix) => ix.programId === ASSOCIATED_TOKEN_PROGRAM && decodeAta(ix.data).kind === "create")
    .map((ix) => ix.accounts[1]?.address)
    .filter((a): a is string => typeof a === "string");
  const addresses = decodedAll.writable;

  let sim: NormalizedSimulation;
  try {
    sim = await simulateAndNormalize(deps, base64, addresses, decodedAll.accountKeys, wallet, created);
  } catch (err) {
    if (err instanceof SimulationShapeError && /simulation returned an error/.test(err.message)) {
      return { ok: false, stage: "simulation", reason: err.message };
    }
    return { ok: false, stage: "refused", check: "shape", reason: String(err instanceof Error ? err.message : err) };
  }

  const verdict = verifyTransaction(
    {
      wallet,
      inputMint: input.request.inputMint,
      outputMint: input.request.outputMint,
      requestedInRaw: input.request.amountRaw,
      minOutRaw: response.minOutRaw,
      tradedMint: input.tradedMint,
      maxPriorityFeeLamports: deps.maxPriorityFeeLamports,
      hardMaxUsdcRaw: deps.hardMaxUsdcRaw,
      jupiterProgram: deps.jupiterProgram,
    },
    decodedAll.decoded,
    sim,
  );
  if (!verdict.ok) return { ok: false, stage: "refused", check: verdict.check, reason: verdict.reason };

  return {
    ok: true,
    tx: signed,
    base64,
    signature: signatureOf(signed),
    lastValidBlockHeight: Number(lifetime.lastValidBlockHeight),
    minOutRaw: response.minOutRaw,
    outAmountRaw: BigInt(input.build.outAmount),
    priorityFeeLamports: verdict.priorityFeeLamports,
    cuLimit: verdict.cuLimit,
    source: verdict.source,
  };
}

async function simulateAndNormalize(
  deps: PipelineDeps,
  base64: string,
  addresses: string[],
  accountKeys: string[],
  wallet: string,
  created: string[],
): Promise<NormalizedSimulation> {
  if (!deps.balanceFields.missing) {
    const value = await deps.rpc.simulate(base64, { sigVerify: true, replaceRecentBlockhash: false, accounts: addresses });
    if (hasBalanceFields(value)) return normalizeSimulation(value, accountKeys, addresses);
    if (value.err !== null) throw new SimulationShapeError(`simulation returned an error: ${JSON.stringify(value.err)}`);
    deps.balanceFields.missing = true; // from now on, pre-read before every simulation
  }
  // Fallback (SPEC.md 16.2 b): read the pre-state immediately before simulating, then simulate.
  const preAccounts = await deps.rpc.getMultipleAccounts(addresses, "tx");
  const value = await deps.rpc.simulate(base64, { sigVerify: true, replaceRecentBlockhash: false, accounts: addresses });
  return buildFallbackSimulation({ wallet, addresses, preAccounts, simValue: value, created });
}
