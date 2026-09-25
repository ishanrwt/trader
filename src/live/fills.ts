import { LAMPORTS_PER_SOL } from "../config/validate.js";
import { USDC_DECIMALS, USDC_MINT } from "./programs.js";
import { asArray, asObject, asString, asU64, SimulationShapeError } from "./simulation.js";
import { TOKEN_PROGRAMS } from "./programs.js";

/**
 * SPEC.md section 16.3 (A2): what a confirmed transaction actually did to our
 * wallet, from getTransaction (jsonParsed, maxSupportedTransactionVersion 0).
 * Never the quote. Fails closed (throws) on any unexpected shape.
 */
export interface ConfirmedEffects {
  err: unknown;
  feeLamports: bigint;
  blockTime: number | null;
  slot: number | null;
  walletLamportDelta: bigint;
  /** Change in our total balance per mint, raw units (accounts owned by the wallet on either side). */
  tokenDeltas: Map<string, bigint>;
  /** Lamports now held by accounts of ours that didn't exist before (token-account rent paid). */
  rentPaidLamports: bigint;
  /** Lamports previously held by accounts of ours that the transaction closed (rent reclaimed). */
  rentReclaimedLamports: bigint;
  /** Our token accounts after the transaction, e.g. the new token account and its program. */
  ourPostTokenAccounts: Array<{ address: string; mint: string; program: string; amount: bigint }>;
}

export function extractConfirmedEffects(raw: unknown, wallet: string): ConfirmedEffects {
  const txr = asObject(raw, "getTransaction result");
  const meta = asObject(txr.meta, "meta");
  const transaction = asObject(txr.transaction, "transaction");
  const message = asObject(transaction.message, "transaction.message");
  const keys = asArray(message.accountKeys, "message.accountKeys").map((k, i) =>
    typeof k === "string" ? k : asString(asObject(k, `accountKeys[${i}]`).pubkey, `accountKeys[${i}].pubkey`),
  );
  const pre = asArray(meta.preBalances, "meta.preBalances");
  const post = asArray(meta.postBalances, "meta.postBalances");
  if (pre.length !== keys.length || post.length !== keys.length) throw new SimulationShapeError("meta balances don't match the account keys");

  const lamports = new Map<string, { pre: bigint; post: bigint }>();
  keys.forEach((k, i) => lamports.set(k, { pre: asU64(pre[i], `preBalances[${i}]`), post: asU64(post[i], `postBalances[${i}]`) }));
  const w = lamports.get(wallet);
  if (!w) throw new SimulationShapeError("the wallet is not in the transaction");

  type Tok = { mint: string; owner: string; program: string; amount: bigint };
  const tokens = new Map<string, { pre: Tok | null; post: Tok | null }>();
  for (const side of ["preTokenBalances", "postTokenBalances"] as const) {
    for (const [i, e] of asArray(meta[side], `meta.${side}`).entries()) {
      const o = asObject(e, `${side}[${i}]`);
      const idx = o.accountIndex;
      if (typeof idx !== "number" || idx < 0 || idx >= keys.length) throw new SimulationShapeError(`${side}[${i}].accountIndex out of range`);
      const program = asString(o.programId, `${side}[${i}].programId`);
      if (!TOKEN_PROGRAMS.has(program)) throw new SimulationShapeError(`${side}[${i}] has unknown token program ${program}`);
      const t: Tok = {
        mint: asString(o.mint, `${side}[${i}].mint`),
        owner: asString(o.owner, `${side}[${i}].owner`),
        program,
        amount: asU64(asObject(o.uiTokenAmount, `${side}[${i}].uiTokenAmount`).amount, `${side}[${i}].amount`),
      };
      const addr = keys[idx]!;
      const cur = tokens.get(addr) ?? { pre: null, post: null };
      tokens.set(addr, side === "preTokenBalances" ? { ...cur, pre: t } : { ...cur, post: t });
    }
  }

  const tokenDeltas = new Map<string, bigint>();
  const ourPostTokenAccounts: ConfirmedEffects["ourPostTokenAccounts"] = [];
  let rentPaid = 0n;
  let rentReclaimed = 0n;
  for (const [addr, t] of tokens) {
    if (t.pre?.owner === wallet) tokenDeltas.set(t.pre.mint, (tokenDeltas.get(t.pre.mint) ?? 0n) - t.pre.amount);
    if (t.post?.owner === wallet) {
      tokenDeltas.set(t.post.mint, (tokenDeltas.get(t.post.mint) ?? 0n) + t.post.amount);
      ourPostTokenAccounts.push({ address: addr, mint: t.post.mint, program: t.post.program, amount: t.post.amount });
    }
    const l = lamports.get(addr);
    if (!l) continue;
    if (l.pre === 0n && l.post > 0n && t.post?.owner === wallet) rentPaid += l.post;
    if (l.pre > 0n && l.post === 0n && t.pre?.owner === wallet) rentReclaimed += l.pre;
  }

  return {
    err: meta.err ?? null,
    feeLamports: asU64(meta.fee, "meta.fee"),
    blockTime: typeof txr.blockTime === "number" ? txr.blockTime : null,
    slot: typeof txr.slot === "number" ? txr.slot : null,
    walletLamportDelta: w.post - w.pre,
    tokenDeltas,
    rentPaidLamports: rentPaid,
    rentReclaimedLamports: rentReclaimed,
    ourPostTokenAccounts,
  };
}

export function lamportsToUsd(lamports: bigint, solPriceUsd: number): number {
  return (Number(lamports) / LAMPORTS_PER_SOL) * solPriceUsd;
}

export function usdcRawToUsd(raw: bigint): number {
  return Number(raw) / 10 ** USDC_DECIMALS;
}

export interface BuyFill {
  tokensRaw: bigint;
  usdcSpentRaw: bigint;
  feeLamports: bigint;
  rentPaidLamports: bigint;
  costBasisUsd: number;
  feeUsd: number;
  rentUsd: number;
  tokenAccount: { address: string; program: string } | null;
}

/** Buy: cost basis = USDC spent + (network fee + rent paid for the new token account) in USD (section 16.3). */
export function buyFillFromEffects(e: ConfirmedEffects, mint: string, solPriceUsd: number): BuyFill {
  const tokensRaw = e.tokenDeltas.get(mint) ?? 0n;
  const usdcSpentRaw = -(e.tokenDeltas.get(USDC_MINT) ?? 0n);
  if (tokensRaw <= 0n) throw new SimulationShapeError("the confirmed buy didn't increase our token balance");
  if (usdcSpentRaw <= 0n) throw new SimulationShapeError("the confirmed buy didn't spend USDC");
  const feeUsd = lamportsToUsd(e.feeLamports, solPriceUsd);
  const rentUsd = lamportsToUsd(e.rentPaidLamports, solPriceUsd);
  const acct = e.ourPostTokenAccounts.find((a) => a.mint === mint) ?? null;
  return {
    tokensRaw,
    usdcSpentRaw,
    feeLamports: e.feeLamports,
    rentPaidLamports: e.rentPaidLamports,
    costBasisUsd: usdcRawToUsd(usdcSpentRaw) + feeUsd + rentUsd,
    feeUsd,
    rentUsd,
    tokenAccount: acct ? { address: acct.address, program: acct.program } : null,
  };
}

export interface SellFill {
  tokensSoldRaw: bigint;
  usdcReceivedRaw: bigint;
  feeLamports: bigint;
  rentReclaimedLamports: bigint;
  proceedsUsd: number;
  feeUsd: number;
  rentReclaimedUsd: number;
}

/** Sell: proceeds = USDC received + (rent reclaimed − network fee) in USD (section 16.3). */
export function sellFillFromEffects(e: ConfirmedEffects, mint: string, solPriceUsd: number): SellFill {
  const tokensSoldRaw = -(e.tokenDeltas.get(mint) ?? 0n);
  const usdcReceivedRaw = e.tokenDeltas.get(USDC_MINT) ?? 0n;
  if (tokensSoldRaw <= 0n) throw new SimulationShapeError("the confirmed sell didn't decrease our token balance");
  if (usdcReceivedRaw < 0n) throw new SimulationShapeError("the confirmed sell decreased our USDC");
  const feeUsd = lamportsToUsd(e.feeLamports, solPriceUsd);
  const rentReclaimedUsd = lamportsToUsd(e.rentReclaimedLamports, solPriceUsd);
  return {
    tokensSoldRaw,
    usdcReceivedRaw,
    feeLamports: e.feeLamports,
    rentReclaimedLamports: e.rentReclaimedLamports,
    proceedsUsd: usdcRawToUsd(usdcReceivedRaw) + rentReclaimedUsd - feeUsd,
    feeUsd,
    rentReclaimedUsd,
  };
}

/** smoke-live leg 1: SOL actually received = wallet lamport change + fee + rent paid − rent reclaimed. */
export function solReceivedFromEffects(e: ConfirmedEffects): bigint {
  return e.walletLamportDelta + e.feeLamports + e.rentPaidLamports - e.rentReclaimedLamports;
}
