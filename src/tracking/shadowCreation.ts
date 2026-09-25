import { computePositionSizeUsd } from "../selection/index.js";
import type { ShadowsStore } from "../storage/shadows.js";
import type { DexPair } from "../types.js";
import { shadowEntry, type ShadowCostConfig } from "./shadows.js";

export interface ShadowCreationConfig {
  enabled: boolean;
  mode: string;
  maxOpen: number;
  positionUsd: number;
  maxPositionPctOfLiq: number;
  targetProfitPct: number;
  holdMinutes: number;
  cost: ShadowCostConfig;
}

export type ShadowCreationResult = "created" | "exists" | "cap" | "disabled" | "no_price";

/**
 * SPEC.md section 11.2: called whenever a mint becomes READY (discovery calls
 * it on every pending -> READY transition, which can happen more than once per
 * mint). Creates the mint's one shadow for this mode at its first READY with
 * room under SHADOW_MAX_OPEN; a mint that already has one, in any outcome, is
 * left alone, and that check comes before the cap so it's never counted as
 * skipped. The unique index behind insertIfAbsent also covers two processes
 * racing on the same mint.
 */
export function createShadowOnReady(
  store: ShadowsStore,
  cfg: ShadowCreationConfig,
  mint: string,
  pair: DexPair,
  now: number,
  onCapSkip: () => void,
): ShadowCreationResult {
  if (!cfg.enabled) return "disabled";
  if (store.getForMint(mint, cfg.mode)) return "exists";
  if (store.countOpen() >= cfg.maxOpen) {
    onCapSkip();
    return "cap";
  }
  const priceUsd = Number(pair.priceUsd ?? "0");
  const liquidityUsd = pair.liquidity?.usd ?? 0;
  if (priceUsd <= 0 || liquidityUsd <= 0) return "no_price";
  const sizeUsd = computePositionSizeUsd(cfg.positionUsd, liquidityUsd, cfg.maxPositionPctOfLiq);
  const entry = shadowEntry(sizeUsd, priceUsd, liquidityUsd, cfg.cost);
  const id = store.insertIfAbsent({
    mint,
    symbol: pair.baseToken.symbol ?? null,
    pairAddress: pair.pairAddress,
    outcome: "open",
    mode: cfg.mode,
    entryTime: now,
    costBasis: entry.costBasis,
    tokenAmount: entry.tokens,
    entryLiquidityUsd: liquidityUsd,
    entryPriceUsd: entry.entryPrice,
    score: null,
    scoreComponents: null,
    peakPnl: 0,
    currentTarget: cfg.targetProfitPct,
    targetExtensions: 0,
    timerRestarts: 0,
    lastRestartAt: null,
    deadline: now + cfg.holdMinutes * 60_000,
    trailArmed: false,
    fastStreak: 0,
    lowLiqStreak: 0,
    noRouteSince: null,
    exitTime: null,
    exitReason: null,
    proceeds: null,
    netPnlUsd: null,
    netPnlPct: null,
  });
  return id === null ? "exists" : "created";
}

/**
 * SPEC.md section 11.2: a position opened for the mint marks its shadow
 * selected, whatever the shadow's lifecycle state (an open one keeps being
 * priced; one that already closed is still classified). Unsellable wins:
 * such a mint can't be bought anyway.
 */
export function markShadowSelected(store: ShadowsStore, mint: string, mode: string): void {
  const shadow = store.getForMint(mint, mode);
  if (shadow && shadow.classification !== "unsellable") store.update(shadow.id, { classification: "selected" });
}

/** SPEC.md section 11.2: a mint that fails the sellability check marks its shadow unsellable (excluded from comparisons). */
export function markShadowUnsellable(store: ShadowsStore, mint: string, mode: string): void {
  const shadow = store.getForMint(mint, mode);
  if (shadow) store.update(shadow.id, { classification: "unsellable" });
}
