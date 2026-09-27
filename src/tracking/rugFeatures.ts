import { base58Decode32, base58Encode, findProgramAddress } from "../encoding/solanaAddress.js";
import { fetchJson } from "../clients/http.js";
import type { SolanaRpcClient } from "../clients/rpc.js";
import type { Logger } from "../logger/index.js";
import type { StateStore } from "../storage/state.js";
import { tradingDayKey } from "../time.js";

/**
 * SPEC.md section 11.6: rug-risk features recorded once per mint at its first
 * READY. Data collection only: nothing here is read by the gate, selection,
 * entries or exits, and every lookup fails safe (null value + a reason code).
 *
 * Layouts come from pump.fun's published IDLs (pump-public-docs, idl/pump.json
 * and idl/pump_amm.json): account data starts with an 8-byte discriminator.
 */

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const POOL_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188];
const BONDING_CURVE_DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96];
const DEFAULT_PUBKEY = "11111111111111111111111111111111";
/** Max early transactions fetched for the sniper share (the result is then a lower bound, flagged). */
export const SNIPER_MAX_TXS = 40;

export type RugReason =
  | "rpc_error"
  | "budget"
  | "too_many_txs"
  | "unsupported"
  | "layout_unverified"
  | "concentrated_or_position"
  | "not_found"
  | "implausible"
  | "no_creator"
  | "disabled";

export type RugFeatureName = "pool" | "pumpMigrated" | "lp" | "holderCount" | "sniperShare" | "creatorHolding" | "rugcheck";

export interface RugFeatures {
  poolProgram: string | null;
  poolCanonical: boolean | null;
  pumpMigrated: boolean | null;
  /** Raw PumpSwap numbers, kept so the burned % can be re-derived: the pool's lp_supply field and the LP mint's current supply. */
  lpSupplyPool: string | null;
  lpMintSupply: string | null;
  lpStatus: "burned" | "withdrawable" | null;
  lpBurnedPct: number | null;
  lpLockedPct: number | null;
  lpWithdrawablePct: number | null;
  holderCount: number | null;
  sniperSharePct: number | null;
  sniperSlots: number | null;
  sniperTxs: number | null;
  /** True when more than SNIPER_MAX_TXS early transactions existed: the share is then a lower bound. */
  sniperCapped: boolean | null;
  creator: string | null;
  creatorHoldingPct: number | null;
  rugcheckScore: number | null;
  rugcheckScoreNormalised: number | null;
  rugcheckLpLockedPct: number | null;
  rugcheckRisks: unknown;
  /** Why a feature is null. */
  reasons: Partial<Record<RugFeatureName, RugReason>>;
  creditsUsed: number;
}

export interface PumpSwapPool {
  index: number;
  creator: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  /** The pool's token account for the base mint: where migration puts the curve's remaining tokens. */
  poolBaseTokenAccount: string;
  lpSupply: bigint;
  coinCreator: string | null;
}

export interface BondingCurve {
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: string;
}

const pubkeyAt = (b: Uint8Array, off: number) => base58Encode(b.subarray(off, off + 32));
const u64At = (b: Uint8Array, off: number) => new DataView(b.buffer, b.byteOffset + off, 8).getBigUint64(0, true);
const hasDiscriminator = (b: Uint8Array, d: number[]) => b.length >= 8 && d.every((x, i) => b[i] === x);

/** PumpSwap `Pool` (pump_amm IDL): bump u8 @8, index u16 @9, creator @11, base_mint @43, quote_mint @75, lp_mint @107, pool vaults @139/@171, lp_supply u64 @203, coin_creator @211. */
export function decodePumpSwapPool(b: Uint8Array): PumpSwapPool | null {
  if (!hasDiscriminator(b, POOL_DISCRIMINATOR) || b.length < 243) return null;
  const coinCreator = pubkeyAt(b, 211);
  return {
    index: new DataView(b.buffer, b.byteOffset + 9, 2).getUint16(0, true),
    creator: pubkeyAt(b, 11),
    baseMint: pubkeyAt(b, 43),
    quoteMint: pubkeyAt(b, 75),
    lpMint: pubkeyAt(b, 107),
    poolBaseTokenAccount: pubkeyAt(b, 139),
    lpSupply: u64At(b, 203),
    coinCreator: coinCreator === DEFAULT_PUBKEY ? null : coinCreator,
  };
}

/** pump.fun `BondingCurve` (pump IDL): five u64 reserves/supply @8..48 (token_total_supply @40), complete bool @48, creator @49. */
export function decodeBondingCurve(b: Uint8Array): BondingCurve | null {
  if (!hasDiscriminator(b, BONDING_CURVE_DISCRIMINATOR) || b.length < 81) return null;
  return { tokenTotalSupply: u64At(b, 40), complete: b[48] === 1, creator: pubkeyAt(b, 49) };
}

/** pump.fun bonding curve PDA: seeds ["bonding-curve", mint] under the pump program (pump IDL). */
export async function bondingCurvePda(mint: string): Promise<string> {
  return findProgramAddress([new TextEncoder().encode("bonding-curve"), base58Decode32(mint)], PUMP_PROGRAM).address;
}

/**
 * PumpSwap LP split, interpreting the IDL's `lp_supply` ("True circulating
 * supply without burns and lock-ups") as the LP amount minted, which burns
 * don't reduce, against the LP mint's current supply, which burns do reduce.
 * No PumpSwap LP locker is documented, so locked = 0. Implausible inputs
 * (lp_supply 0, or more LP in circulation than lp_supply) give null.
 */
export function pumpSwapLpSplit(lpSupplyPool: bigint, lpMintSupply: bigint): { burnedPct: number; lockedPct: number; withdrawablePct: number } | null {
  if (lpSupplyPool <= 0n || lpMintSupply < 0n || lpMintSupply > lpSupplyPool) return null;
  const withdrawablePct = (Number(lpMintSupply) / Number(lpSupplyPool)) * 100;
  return { burnedPct: 100 - withdrawablePct, lockedPct: 0, withdrawablePct };
}

// ---------------------------------------------------------------------------

/** The read-only RPC calls the collector makes, with their Helius credit cost. */
export interface RugRpc {
  /** { owner, data } or null if the account doesn't exist. 1 credit. */
  getAccount(pubkey: string): Promise<{ owner: string; data: Uint8Array } | null>;
  /** Raw supply. 1 credit. */
  getTokenSupplyRaw(mint: string): Promise<bigint>;
  /** Raw amounts of every token account for `mint` under `tokenProgram`. 10 credits. */
  getTokenAccountAmounts(tokenProgram: string, mint: string): Promise<bigint[]>;
  /** Newest first, up to 1000. 1 credit. */
  getSignatures(addr: string, before?: string): Promise<Array<{ signature: string; slot: number; failed: boolean }>>;
  /** Positive changes of `mint` balances in one transaction, excluding accounts owned by any of `excludeOwners`. 1 credit. */
  getTokenBuys(signature: string, mint: string, excludeOwners: readonly string[]): Promise<bigint>;
  /** Raw balance of `mint` held by `owner` across its token accounts. 1 credit. */
  getOwnerBalance(owner: string, mint: string): Promise<bigint>;
}

export const CREDITS = { account: 1, supply: 1, programAccounts: 10, signatures: 1, transaction: 1, ownerBalance: 1 } as const;

/** RUG_FEATURES_MAX_CREDITS_PER_DAY, counted per mode and trading day in `state`. */
export class CreditMeter {
  used = 0;
  constructor(
    private readonly state: Pick<StateStore, "get" | "set"> | null,
    private readonly mode: string,
    private readonly dailyCap: number,
    private readonly tz: string,
    private readonly now: () => number,
  ) {}
  private key() {
    return `rugFeatureCredits:${this.mode}`;
  }
  usedToday(): number {
    if (!this.state) return this.used;
    const cur = this.state.get<{ day: string; used: number } | null>(this.key(), null);
    return cur && cur.day === tradingDayKey(this.now(), this.tz) ? cur.used : 0;
  }
  /** Whether a lookup that may spend up to `worst` credits still fits under today's cap. */
  canSpend(worst: number): boolean {
    return this.usedToday() + worst <= this.dailyCap;
  }
  spend(n: number): void {
    this.used += n;
    if (!this.state) return;
    this.state.set(this.key(), { day: tradingDayKey(this.now(), this.tz), used: this.usedToday() + n });
  }
}

export interface RugCheckSummary {
  score: number | null;
  scoreNormalised: number | null;
  lpLockedPct: number | null;
  risks: unknown;
}

export interface CollectDeps {
  rpc: RugRpc;
  meter: CreditMeter;
  /** RUGCHECK_ENABLED: GET /v1/tokens/{mint}/report/summary; absent when disabled. */
  rugcheck?: (mint: string) => Promise<RugCheckSummary>;
  sniperSlots: number;
  sniperMaxPages: number;
}

export interface CollectInput {
  mint: string;
  /** The selected DexScreener pair's address: the pool account. */
  pairAddress: string;
  /** DexScreener pair labels, e.g. ["CLMM"], ["DYN2"], ["DLMM"]. */
  pairLabels: readonly string[];
  /** From the mint-safety check's cache; read from the mint account if unknown. */
  tokenProgram: string | null;
}

/**
 * Collects every feature for one mint. Never throws: each lookup is separate,
 * and a failure stores null plus a reason code.
 */
export async function collectRugFeatures(deps: CollectDeps, input: CollectInput): Promise<RugFeatures> {
  const f: RugFeatures = {
    poolProgram: null, poolCanonical: null, pumpMigrated: null, lpSupplyPool: null, lpMintSupply: null, lpStatus: null, lpBurnedPct: null,
    lpLockedPct: null, lpWithdrawablePct: null, holderCount: null, sniperSharePct: null, sniperSlots: null, sniperTxs: null, sniperCapped: null,
    creator: null, creatorHoldingPct: null, rugcheckScore: null, rugcheckScoreNormalised: null, rugcheckLpLockedPct: null, rugcheckRisks: null,
    reasons: {}, creditsUsed: 0,
  };
  const { rpc, meter } = deps;
  const spend = (n: number) => {
    meter.spend(n);
    f.creditsUsed += n;
  };
  const guard = async <T>(name: RugFeatureName, worst: number, run: () => Promise<T>): Promise<T | null> => {
    if (!meter.canSpend(worst)) {
      f.reasons[name] = "budget";
      return null;
    }
    try {
      return await run();
    } catch {
      f.reasons[name] = "rpc_error";
      return null;
    }
  };

  // Pool account and the pump.fun bonding curve (both cheap, always attempted).
  let pool: PumpSwapPool | null = null;
  await guard("pool", 1, async () => {
    spend(CREDITS.account);
    const acc = await rpc.getAccount(input.pairAddress);
    if (!acc) return (f.reasons.pool = "not_found");
    f.poolProgram = acc.owner;
    if (acc.owner !== PUMPSWAP_PROGRAM) return;
    pool = decodePumpSwapPool(acc.data);
    if (!pool) return (f.reasons.pool = "implausible");
    f.poolCanonical = pool.index === 0;
  });
  const curveAddr = await bondingCurvePda(input.mint);
  let curve: BondingCurve | null = null;
  await guard("pumpMigrated", 1, async () => {
    spend(CREDITS.account);
    const acc = await rpc.getAccount(curveAddr);
    curve = acc && acc.owner === PUMP_PROGRAM ? decodeBondingCurve(acc.data) : null;
    // Migrated = a completed pump.fun curve whose liquidity sits in the canonical PumpSwap pool.
    f.pumpMigrated = curve !== null && curve.complete && f.poolProgram === PUMPSWAP_PROGRAM && f.poolCanonical === true;
  });

  // LP status: native for PumpSwap only.
  const labels = input.pairLabels.map((l) => l.toUpperCase());
  if (f.poolProgram === null && !f.reasons.lp) f.reasons.lp = f.reasons.pool ?? "rpc_error";
  else if (f.poolProgram !== PUMPSWAP_PROGRAM) {
    f.reasons.lp = labels.some((l) => ["CLMM", "DLMM", "DYN2", "DAMM V2"].includes(l)) ? "concentrated_or_position" : "layout_unverified";
  } else if (!pool) {
    f.reasons.lp = "implausible";
  } else {
    const p: PumpSwapPool = pool;
    await guard("lp", 1, async () => {
      spend(CREDITS.supply);
      const lpMintSupply = await rpc.getTokenSupplyRaw(p.lpMint);
      f.lpSupplyPool = p.lpSupply.toString();
      f.lpMintSupply = lpMintSupply.toString();
      const split = pumpSwapLpSplit(p.lpSupply, lpMintSupply);
      if (!split) return (f.reasons.lp = "implausible");
      f.lpBurnedPct = split.burnedPct;
      f.lpLockedPct = split.lockedPct;
      f.lpWithdrawablePct = split.withdrawablePct;
      f.lpStatus = split.burnedPct >= 99 ? "burned" : "withdrawable";
    });
  }

  // Holder count: non-zero token accounts for the mint.
  await guard("holderCount", CREDITS.programAccounts + 1, async () => {
    let program = input.tokenProgram;
    if (!program) {
      spend(CREDITS.account);
      program = (await rpc.getAccount(input.mint))?.owner ?? null;
      if (!program) return (f.reasons.holderCount = "not_found");
    }
    spend(CREDITS.programAccounts);
    const amounts = await rpc.getTokenAccountAmounts(program, input.mint);
    f.holderCount = amounts.filter((a) => a > 0n).length;
  });

  // Supply for the share-of-supply features: the curve's total if pump.fun, else the mint's.
  let totalSupply: bigint | null = (curve as BondingCurve | null)?.tokenTotalSupply ?? null;
  const supply = async () => {
    if (totalSupply === null) {
      spend(CREDITS.supply);
      totalSupply = await rpc.getTokenSupplyRaw(input.mint);
    }
    return totalSupply;
  };

  // Sniper share: buys in the bonding curve's first SNIPER_SLOTS slots after LAUNCH. The curve is
  // created when the token launches on pump.fun; the PumpSwap pool only comes later, at migration.
  if (!curve) {
    f.reasons.sniperShare = f.reasons.pumpMigrated ?? "unsupported";
  } else {
    await guard("sniperShare", deps.sniperMaxPages + SNIPER_MAX_TXS, async () => {
      const sigs: Array<{ signature: string; slot: number; failed: boolean }> = [];
      let before: string | undefined;
      let reachedLaunch = false;
      for (let page = 0; page < deps.sniperMaxPages; page++) {
        spend(CREDITS.signatures);
        const batch = await rpc.getSignatures(curveAddr, before);
        sigs.push(...batch);
        if (batch.length < 1000) {
          reachedLaunch = true;
          break;
        }
        before = batch[batch.length - 1]!.signature;
      }
      if (!reachedLaunch || sigs.length === 0) return (f.reasons.sniperShare = "too_many_txs");
      const launchSlot = Math.min(...sigs.map((s) => s.slot));
      const early = sigs.filter((s) => !s.failed && s.slot < launchSlot + deps.sniperSlots).sort((a, b) => a.slot - b.slot);
      const fetched = early.slice(0, SNIPER_MAX_TXS);
      let bought = 0n;
      for (const s of fetched) {
        spend(CREDITS.transaction);
        // Not buys: tokens the curve holds, and the curve's remainder moving into the PumpSwap pool's
        // vault (owned by the pool) when a curve completes and migrates within the window.
        bought += await rpc.getTokenBuys(s.signature, input.mint, [curveAddr, input.pairAddress]);
      }
      const total = await supply();
      if (total <= 0n) return (f.reasons.sniperShare = "implausible");
      const share = (Number(bought) / Number(total)) * 100;
      if (share > 100) return (f.reasons.sniperShare = "implausible");
      f.sniperSharePct = share;
      f.sniperSlots = deps.sniperSlots;
      f.sniperTxs = fetched.length;
      f.sniperCapped = early.length > SNIPER_MAX_TXS;
    });
  }

  // Creator's current holding: PumpSwap coin_creator if set, else the pump.fun curve's creator.
  f.creator = (pool as PumpSwapPool | null)?.coinCreator ?? (curve as BondingCurve | null)?.creator ?? null;
  if (!f.creator) {
    f.reasons.creatorHolding = "no_creator";
  } else {
    const creator = f.creator;
    await guard("creatorHolding", 2, async () => {
      spend(CREDITS.ownerBalance);
      const held = await rpc.getOwnerBalance(creator, input.mint);
      const total = await supply();
      if (total <= 0n) return (f.reasons.creatorHolding = "implausible");
      f.creatorHoldingPct = (Number(held) / Number(total)) * 100;
    });
  }

  // RugCheck (optional; no RPC credits).
  if (!deps.rugcheck) {
    f.reasons.rugcheck = "disabled";
  } else {
    try {
      const r = await deps.rugcheck(input.mint);
      f.rugcheckScore = r.score;
      f.rugcheckScoreNormalised = r.scoreNormalised;
      f.rugcheckLpLockedPct = r.lpLockedPct;
      f.rugcheckRisks = r.risks;
    } catch {
      f.reasons.rugcheck = "rpc_error";
    }
  }
  return f;
}

// ---------------------------------------------------------------------------

function b64(v: unknown): Uint8Array {
  const arr = v as [string, string];
  return Uint8Array.from(Buffer.from(arr[0], "base64"));
}

/** The collector's RPC calls on top of the shared read-only client (and its RPC_MAX_RPS limiter). */
export function makeRugRpc(rpc: SolanaRpcClient): RugRpc {
  return {
    async getAccount(pubkey) {
      const res = (await rpc.getAccountInfoBase64(pubkey)) as { value: { owner: string; data: unknown } | null };
      return res.value ? { owner: res.value.owner, data: b64(res.value.data) } : null;
    },
    async getTokenSupplyRaw(mint) {
      const res = (await rpc.getTokenSupply(mint)) as { value: { amount: string } };
      return BigInt(res.value.amount);
    },
    async getTokenAccountAmounts(tokenProgram, mint) {
      const filters: unknown[] = [{ memcmp: { offset: 0, bytes: mint } }];
      // SPL Token accounts are exactly 165 bytes; Token-2022 accounts can carry extensions.
      if (tokenProgram === SPL_TOKEN_PROGRAM) filters.unshift({ dataSize: 165 });
      const res = (await rpc.getProgramAccounts(tokenProgram, { encoding: "base64", filters, dataSlice: { offset: 64, length: 8 } })) as Array<{ account: { data: unknown } }>;
      return res.map((a) => {
        const d = b64(a.account.data);
        return d.length >= 8 ? new DataView(d.buffer, d.byteOffset, 8).getBigUint64(0, true) : 0n;
      });
    },
    async getSignatures(addr, before) {
      const res = (await rpc.getSignaturesForAddress(addr, { limit: 1000, ...(before ? { before } : {}) })) as Array<{ signature: string; slot: number; err: unknown }>;
      return res.map((s) => ({ signature: s.signature, slot: s.slot, failed: s.err !== null && s.err !== undefined }));
    },
    async getTokenBuys(signature, mint, excludeOwners) {
      const tx = (await rpc.getTransactionJsonParsed(signature)) as {
        meta: { preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
      } | null;
      return tokenBuysFromMeta(tx?.meta ?? null, mint, excludeOwners);
    },
    async getOwnerBalance(owner, mint) {
      const res = (await rpc.getTokenAccountsByOwnerForMint(owner, mint)) as {
        value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }>;
      };
      return res.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    },
  };
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

/** Sum of positive balance changes of `mint` in one transaction, per token account, excluding accounts owned by any of `excludeOwners` (the curve, the pool). */
export function tokenBuysFromMeta(meta: { preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null, mint: string, excludeOwners: readonly string[]): bigint {
  if (!meta) return 0n;
  const pre = new Map((meta.preTokenBalances ?? []).filter((b) => b.mint === mint).map((b) => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
  let bought = 0n;
  for (const b of meta.postTokenBalances ?? []) {
    if (b.mint !== mint || (b.owner !== undefined && excludeOwners.includes(b.owner))) continue;
    const delta = BigInt(b.uiTokenAmount.amount) - (pre.get(b.accountIndex) ?? 0n);
    if (delta > 0n) bought += delta;
  }
  return bought;
}

/**
 * RUGCHECK_ENABLED only: GET https://api.rugcheck.xyz/v1/tokens/{mint}/report/summary
 * (no auth per RugCheck's Swagger spec; fields score, score_normalised,
 * lpLockedPct, risks). One call per READY mint, no retries; a 429 or any
 * failure throws, which the collector records as null with a reason.
 */
export function makeRugCheck(opts: { logger: Logger; fetchImpl?: typeof fetch; timeoutMs?: number }): (mint: string) => Promise<RugCheckSummary> {
  return async (mint) => {
    const r = await fetchJson<{ score?: unknown; score_normalised?: unknown; lpLockedPct?: unknown; risks?: unknown }>(
      `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report/summary`,
      {
        headers: { accept: "application/json", "user-agent": "trends-trader (data collection; one request per new token)" },
        timeoutMs: opts.timeoutMs ?? 8000,
        retries: 0,
        logger: opts.logger,
        label: "RugCheck report summary",
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      },
    );
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return { score: n(r.score), scoreNormalised: n(r.score_normalised), lpLockedPct: n(r.lpLockedPct), risks: r.risks ?? null };
  };
}
