import { SPL_TOKEN_2022_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from "../constants.js";
import type { DexPair } from "../types.js";

export type GateCheckId =
  | "duplicate"
  | "pair"
  | "liquidity"
  | "entryWindow"
  | "momentum"
  | "buyPressure"
  | "mintSafety"
  | "holders";

export interface Phase1GateInput {
  now: number;
  /** Checks 1-4 only (SPEC.md section 15); checks 5-8 need positions/trades/RPC data that don't exist until Phase 2. */
  isHeld: boolean;
  wasTradedBefore: boolean;
  reentryEnabled: boolean;
  /** Already selected via clients/dexscreener.ts selectPair(), or null if none valid. */
  pair: DexPair | null;
  minLiquidityUsd: number;
  /** Persisted on the pending row; null until liquidity first passes. */
  firstEligibleAt: number | null;
  entryWindowMin: number;
}

export type Phase1GateResult =
  | { outcome: "permanent_fail"; check: GateCheckId; reason: string; firstEligibleAt: number | null }
  | { outcome: "temporary_fail"; check: GateCheckId; reason: string; firstEligibleAt: number | null }
  /** Cleared checks 1-4. Stays "pending" — Phase 1 has no checks 5-8, so READY is never reached. */
  | { outcome: "passed"; firstEligibleAt: number };

/**
 * SPEC.md section 5, checks 1-4, evaluated in order; the first failure wins.
 * Checks 5-8 (momentum, buy pressure, mint safety, holders) are Phase 2.
 */
export function evaluatePhase1Gate(input: Phase1GateInput): Phase1GateResult {
  // 1. Duplicate (permanent)
  if (input.isHeld || (input.wasTradedBefore && !input.reentryEnabled)) {
    return {
      outcome: "permanent_fail",
      check: "duplicate",
      reason: input.isHeld
        ? "mint is currently held"
        : "mint was traded before and REENTRY_ENABLED is false",
      firstEligibleAt: input.firstEligibleAt,
    };
  }

  // 2. Pair (temporary)
  if (!input.pair) {
    return {
      outcome: "temporary_fail",
      check: "pair",
      reason: "no valid pair under the pair selection rule",
      firstEligibleAt: input.firstEligibleAt,
    };
  }

  // 3. Liquidity (temporary)
  const liquidityUsd = input.pair.liquidity?.usd ?? 0;
  if (liquidityUsd < input.minLiquidityUsd) {
    return {
      outcome: "temporary_fail",
      check: "liquidity",
      reason: `liquidity $${liquidityUsd} < MIN_LIQUIDITY_USD $${input.minLiquidityUsd}`,
      firstEligibleAt: input.firstEligibleAt,
    };
  }
  const firstEligibleAt = input.firstEligibleAt ?? input.now;

  // 4. Entry window (permanent)
  const ageMs = input.now - firstEligibleAt;
  const windowMs = input.entryWindowMin * 60_000;
  if (ageMs > windowMs) {
    return {
      outcome: "permanent_fail",
      check: "entryWindow",
      reason: `entry window of ${input.entryWindowMin}m expired ${Math.round((ageMs - windowMs) / 1000)}s ago`,
      firstEligibleAt,
    };
  }

  return { outcome: "passed", firstEligibleAt };
}

export type Check56Result =
  | { passed: true }
  | { passed: false; check: "momentum" | "buyPressure"; reason: string };

export interface MomentumBuyPressureConfig {
  minM5ChangePct: number;
  minH1ChangePct: number;
  minH24ChangePct: number;
  /** 0 = disabled. */
  maxH1ChangePct: number;
  minM5Txns: number;
  minM5BuySellRatio: number;
  minM5VolumeUsd: number;
}

/**
 * SPEC.md section 5, checks 5-6 (both temporary). Pair-data only, no RPC —
 * safe to run for every READY candidate on every recheck.
 */
export function evaluateMomentumAndBuyPressure(pair: DexPair, cfg: MomentumBuyPressureConfig): Check56Result {
  const m5 = pair.priceChange?.m5;
  const h1 = pair.priceChange?.h1;
  const h24 = pair.priceChange?.h24;
  if (m5 === undefined || h1 === undefined || h24 === undefined) {
    return { passed: false, check: "momentum", reason: "missing priceChange field(s)" };
  }
  if (m5 <= cfg.minM5ChangePct) {
    return { passed: false, check: "momentum", reason: `m5 change ${m5}% <= MIN_M5_CHANGE_PCT ${cfg.minM5ChangePct}%` };
  }
  if (h1 <= cfg.minH1ChangePct) {
    return { passed: false, check: "momentum", reason: `h1 change ${h1}% <= MIN_H1_CHANGE_PCT ${cfg.minH1ChangePct}%` };
  }
  if (h24 <= cfg.minH24ChangePct) {
    return { passed: false, check: "momentum", reason: `h24 change ${h24}% <= MIN_H24_CHANGE_PCT ${cfg.minH24ChangePct}%` };
  }
  if (cfg.maxH1ChangePct > 0 && h1 > cfg.maxH1ChangePct) {
    return { passed: false, check: "momentum", reason: `h1 change ${h1}% > MAX_H1_CHANGE_PCT ${cfg.maxH1ChangePct}%` };
  }

  const buys = pair.txns?.m5?.buys;
  const sells = pair.txns?.m5?.sells;
  const volume = pair.volume?.m5;
  if (buys === undefined || sells === undefined || volume === undefined) {
    return { passed: false, check: "buyPressure", reason: "missing txns/volume field(s)" };
  }
  if (buys + sells < cfg.minM5Txns) {
    return { passed: false, check: "buyPressure", reason: `m5 txns ${buys + sells} < MIN_M5_TXNS ${cfg.minM5Txns}` };
  }
  if (buys < cfg.minM5BuySellRatio * sells) {
    return {
      passed: false,
      check: "buyPressure",
      reason: `m5 buys ${buys} < MIN_M5_BUY_SELL_RATIO ${cfg.minM5BuySellRatio} * sells ${sells}`,
    };
  }
  if (volume < cfg.minM5VolumeUsd) {
    return { passed: false, check: "buyPressure", reason: `m5 volume $${volume} < MIN_M5_VOLUME_USD $${cfg.minM5VolumeUsd}` };
  }

  return { passed: true };
}

export interface MintAccountInfo {
  owner: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Token-2022 extension names present on the mint (e.g. "metadataPointer"), empty for plain SPL Token mints. */
  extensions: string[];
}

/** Maps a raw `getAccountInfo` (jsonParsed) `value` into the shape evaluateMintSafety needs, or null if the account doesn't exist / isn't a parsed mint. */
export function parseMintAccountInfo(raw: unknown): MintAccountInfo | null {
  const value = raw as {
    owner?: string;
    data?: { parsed?: { type?: string; info?: { mintAuthority?: string | null; freezeAuthority?: string | null; extensions?: Array<{ extension?: string }> } } };
  } | null;
  if (!value || typeof value.owner !== "string") return null;
  const info = value.data?.parsed?.info;
  if (value.data?.parsed?.type !== "mint" || !info) return null;
  return {
    owner: value.owner,
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    extensions: (info.extensions ?? []).map((e) => e.extension).filter((e): e is string => typeof e === "string"),
  };
}

export interface MintSafetyConfig {
  requireMintRevoked: boolean;
  requireFreezeRevoked: boolean;
  allowedToken2022Extensions: readonly string[];
}

export interface MintSafetyResult {
  passed: boolean;
  reason: string;
}

/** SPEC.md section 5, check 7 (permanent, cached forever per mint). */
export function evaluateMintSafety(info: MintAccountInfo | null, cfg: MintSafetyConfig): MintSafetyResult {
  if (!info) return { passed: false, reason: "mint account not found or not a parsed mint" };
  if (cfg.requireMintRevoked && info.mintAuthority !== null) {
    return { passed: false, reason: "mint authority not revoked" };
  }
  if (cfg.requireFreezeRevoked && info.freezeAuthority !== null) {
    return { passed: false, reason: "freeze authority not revoked" };
  }
  if (info.owner !== SPL_TOKEN_PROGRAM_ID && info.owner !== SPL_TOKEN_2022_PROGRAM_ID) {
    return { passed: false, reason: `owner ${info.owner} is not the SPL Token or Token-2022 program` };
  }
  if (info.owner === SPL_TOKEN_2022_PROGRAM_ID) {
    const disallowed = info.extensions.filter((e) => !cfg.allowedToken2022Extensions.includes(e));
    if (disallowed.length > 0) {
      return { passed: false, reason: `disallowed Token-2022 extension(s): ${disallowed.join(", ")}` };
    }
  }
  return { passed: true, reason: "ok" };
}

export interface TokenAccountBalance {
  address: string;
  uiAmount: number | null;
}

export interface HoldersConfig {
  maxTop1Pct: number;
  maxTop10Pct: number;
  /** Percent tolerance for matching an account's balance against a pool's liquidity.base to exclude it as a vault. */
  poolVaultTolerancePct: number;
  burnAddresses: readonly string[];
}

export interface HoldersResult {
  passed: boolean;
  reason: string;
  top1Pct: number;
  top10Pct: number;
}

/** SPEC.md section 5, check 8 (temporary, cached HOLDERS_CACHE_MIN). */
export function evaluateHolders(
  largestAccounts: readonly TokenAccountBalance[],
  totalSupplyUiAmount: number,
  validPairs: readonly DexPair[],
  cfg: HoldersConfig,
): HoldersResult {
  const poolVaultBalances = validPairs
    .map((p) => p.liquidity?.base)
    .filter((b): b is number => b !== undefined && b > 0);
  const isPoolVault = (uiAmount: number) =>
    poolVaultBalances.some((b) => Math.abs(uiAmount - b) <= b * (cfg.poolVaultTolerancePct / 100));

  const filtered = largestAccounts.filter((a) => {
    if (cfg.burnAddresses.includes(a.address)) return false;
    const amt = a.uiAmount ?? 0;
    if (amt > 0 && isPoolVault(amt)) return false;
    return true;
  });
  const sorted = [...filtered].sort((a, b) => (b.uiAmount ?? 0) - (a.uiAmount ?? 0));

  const top1 = sorted[0]?.uiAmount ?? 0;
  const top10 = sorted.slice(0, 10).reduce((sum, a) => sum + (a.uiAmount ?? 0), 0);
  const top1Pct = totalSupplyUiAmount > 0 ? (top1 / totalSupplyUiAmount) * 100 : 0;
  const top10Pct = totalSupplyUiAmount > 0 ? (top10 / totalSupplyUiAmount) * 100 : 0;

  if (top1Pct > cfg.maxTop1Pct) {
    return { passed: false, reason: `top1 ${top1Pct.toFixed(2)}% > MAX_TOP1_PCT ${cfg.maxTop1Pct}%`, top1Pct, top10Pct };
  }
  if (top10Pct > cfg.maxTop10Pct) {
    return { passed: false, reason: `top10 ${top10Pct.toFixed(2)}% > MAX_TOP10_PCT ${cfg.maxTop10Pct}%`, top1Pct, top10Pct };
  }
  return { passed: true, reason: "ok", top1Pct, top10Pct };
}
