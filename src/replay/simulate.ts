import { initialExitState, type ExitReason } from "../monitor/stateMachine.js";
import { computePositionSizeUsd } from "../selection/index.js";
import { shadowEntry, shadowStep, shadowValue } from "../tracking/shadows.js";
import type { PricePathPoint } from "../storage/pricePaths.js";
import type { ReplayParams } from "./config.js";

/**
 * Offline replay of one price path (SPEC.md section 11.5) through the real
 * exit state machine (section 8.3), priced with the shadow cost model
 * (section 11.2). Pure: no database, no network.
 */

export type ReplayExitReason = ExitReason | "written_off" | "path_end";

export interface ReplayTrade {
  entryTime: number;
  exitTime: number;
  exitReason: ReplayExitReason;
  sizeUsd: number;
  costBasis: number;
  proceeds: number;
  netPnlUsd: number;
  netPnlPct: number;
  peakPnl: number;
}

export interface SimulateOptions {
  /** The position is entered at the first priced point at or after this time (plus PAPER_LATENCY_SEC unless skipLatency). */
  entryAt: number;
  skipEntryLatency?: boolean;
  /** Use these instead of sizing from POSITION_USD and adding the fee (the cross-check passes a real trade's). */
  sizeUsd?: number;
  costBasis?: number;
}

function priced(p: PricePathPoint): p is PricePathPoint & { priceUsd: number; liquidityUsd: number } {
  return p.gap === null && p.priceUsd !== null && p.liquidityUsd !== null && p.priceUsd > 0 && p.liquidityUsd > 0;
}

/** Returns null when no priced point exists to enter at. */
export function simulatePath(points: readonly PricePathPoint[], params: ReplayParams, opts: SimulateOptions): ReplayTrade | null {
  const latencyMs = opts.skipEntryLatency ? 0 : params.latencySec * 1000;
  const entryIdx = points.findIndex((p) => p.t >= opts.entryAt + latencyMs && priced(p));
  if (entryIdx < 0) return null;
  const entryPoint = points[entryIdx]! as PricePathPoint & { priceUsd: number; liquidityUsd: number };

  const sizeUsd = opts.sizeUsd ?? computePositionSizeUsd(params.positionUsd, entryPoint.liquidityUsd, params.maxPositionPctOfLiq);
  const entry = shadowEntry(sizeUsd, entryPoint.priceUsd, entryPoint.liquidityUsd, params.cost);
  const costBasis = opts.costBasis ?? entry.costBasis;
  const tokens = entry.tokens;
  // A gap row, or a point without price or liquidity, is no route at that instant.
  const mark = (p: PricePathPoint): number | null =>
    priced(p) ? ((shadowValue(tokens, p.priceUsd, p.liquidityUsd, params.cost) - costBasis) / costBasis) * 100 : null;

  let state = initialExitState({
    entryTime: entryPoint.t,
    entryLiquidity: entryPoint.liquidityUsd,
    targetProfitPct: params.targetProfitPct,
    holdMinutes: params.exit.holdMinutes,
    entryPnlPct: mark(entryPoint),
  });
  let lastLiqAt = entryPoint.t;

  const close = (exitTime: number, exitReason: ReplayExitReason, proceeds: number): ReplayTrade => {
    const netPnlUsd = proceeds - costBasis;
    const netPnlPct = (netPnlUsd / costBasis) * 100;
    return { entryTime: entryPoint.t, exitTime, exitReason, sizeUsd, costBasis, proceeds, netPnlUsd, netPnlPct, peakPnl: Math.max(state.peakPnl, netPnlPct) };
  };

  for (let i = entryIdx + 1; i < points.length; i++) {
    const p = points[i]!;
    const pnlPct = mark(p);
    // Liquidity is a separate LIQ_CHECK_SECONDS reading in the bot, so only pass one that often.
    let liquidityUsd: number | undefined;
    if (priced(p) && p.t - lastLiqAt >= params.liqCheckSeconds * 1000) {
      liquidityUsd = p.liquidityUsd;
      lastLiqAt = p.t;
    }
    const res = shadowStep(state, { now: p.t, pnlPct, ...(liquidityUsd !== undefined ? { liquidityUsd } : {}) }, params.exit);
    state = res.newState;
    if (res.action !== "SELL") continue;

    // Section 7 exit fill: the first priced point PAPER_LATENCY_SEC after the decision; section 8.4 write-off if none in time.
    const fillAt = p.t + params.latencySec * 1000;
    const writeOffAt = p.t + params.stuckWriteOffMin * 60_000;
    const fill = points.slice(i).find((q) => q.t >= fillAt && priced(q));
    if (!fill || fill.t - p.t > params.stuckWriteOffMin * 60_000) return close(fill ? writeOffAt : p.t, "written_off", 0);
    return close(fill.t, res.reason, shadowValue(tokens, fill.priceUsd!, fill.liquidityUsd!, params.cost));
  }

  // Still open when the path ended: marked at its last priced point.
  const last = [...points].reverse().find(priced);
  if (!last || last.t < entryPoint.t) return close(entryPoint.t, "written_off", 0);
  return close(last.t, "path_end", shadowValue(tokens, last.priceUsd!, last.liquidityUsd!, params.cost));
}

/** Section 11.5's schedule: the number of points a full path records. */
export function pathSchedule(params: Pick<ReplayParams, "pathFastSeconds" | "pathFastWindowMin" | "shadowPollSeconds">, durationMs: number) {
  const fastMs = params.pathFastSeconds * 1000;
  const slowMs = params.shadowPollSeconds * 1000;
  const fastWindowMs = params.pathFastWindowMin * 60_000;
  const intervalAt = (offsetMs: number) => (offsetMs < fastWindowMs ? fastMs : slowMs);
  let expected = 0;
  for (let t = 0; t < durationMs; t += intervalAt(t)) expected++;
  return { expected };
}

export interface Completeness {
  complete: boolean;
  points: number;
  expected: number;
  /** Longest stretch without any point (collector down), ms. */
  maxGapMs: number;
  reason: string | null;
}

/**
 * A path is incomplete if it has fewer than 90% of the expected points, or a
 * stretch with no point (including before ends_at) longer than 3x the slow
 * interval: the collector was down, which shows as missing timestamps, not
 * gap rows. Normal loop jitter (a 5 s point arriving at 26 s, the first slow
 * point at 17 s) stays well under that.
 */
export function pathCompleteness(
  path: { startedAt: number; endsAt: number },
  points: readonly PricePathPoint[],
  params: Pick<ReplayParams, "pathFastSeconds" | "pathFastWindowMin" | "shadowPollSeconds">,
): Completeness {
  const { expected } = pathSchedule(params, path.endsAt - path.startedAt);
  const maxAllowedMs = 3 * Math.max(params.pathFastSeconds, params.shadowPollSeconds) * 1000;
  let maxGapMs = 0;
  let prev = path.startedAt;
  for (const t of [...points.map((q) => q.t), path.endsAt]) {
    maxGapMs = Math.max(maxGapMs, t - prev);
    prev = t;
  }
  let reason: string | null = null;
  if (points.length < expected * 0.9) reason = `${points.length}/${expected} points`;
  else if (maxGapMs > maxAllowedMs) reason = `no points for ${Math.round(maxGapMs / 1000)}s`;
  return { complete: reason === null, points: points.length, expected, maxGapMs, reason };
}
