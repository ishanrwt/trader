export interface HistoryPoint {
  t: number;
  pnl: number;
}

export interface ExitState {
  entryTime: number;
  entryLiquidity: number;
  peakPnl: number;
  currentTarget: number;
  targetExtensions: number;
  timerRestarts: number;
  lastRestartAt: number | null;
  deadline: number;
  trailArmed: boolean;
  fastStreak: number;
  lowLiqStreak: number;
  noRouteSince: number | null;
  history: HistoryPoint[];
}

export type ExitReason =
  | "no_route"
  | "liq_pull"
  | "stop"
  | "breakeven"
  | "target"
  | "trail"
  | "max_hold"
  | "time_flat"
  | "time_exit";

export interface ExitStateMachineInputs {
  now: number;
  /** null if there's no quote or route this poll. */
  pnlPct: number | null;
  /** A second exit-lane quote, fetched only after a NEED_CONFIRM. */
  confirmPnlPct?: number;
  /** A fresh LIQ_CHECK_SECONDS reading; undefined means "no new reading this call" (section 8.3 step 2). */
  liquidityUsd?: number;
}

export type ExitStepResult =
  | { action: "HOLD"; newState: ExitState; logs: string[] }
  | { action: "SELL"; reason: ExitReason; newState: ExitState; logs: string[] }
  /**
   * The caller must fetch one more exit-lane quote and call step() again on
   * the ORIGINAL pre-poll state (not this result's newState) with the same
   * inputs plus confirmPnlPct set, so steps 1-2's mutations (noRouteSince,
   * lowLiqStreak) are applied exactly once, not once here and once again on
   * the confirmation call. This result's newState is diagnostic only and must
   * never be persisted or fed into another step() call.
   */
  | { action: "NEED_CONFIRM"; newState: ExitState };

export interface ExitStateMachineConfig {
  stopLossPct: number;
  extraTargetPct: number;
  maxTargetExtensions: number;
  holdMinutes: number;
  fastGainPct: number;
  fastWindowMinutes: number;
  fastMinHistorySec: number;
  fastConfirmPolls: number;
  maxTimerRestarts: number;
  maxTotalHoldMinutes: number;
  trailPct: number;
  breakevenTriggerPct: number;
  breakevenFloorPct: number;
  flatBandPct: number;
  liqDropExitPct: number;
  liqDropConfirmReads: number;
  noRouteExitSec: number;
}

function pruneHistory(history: HistoryPoint[], now: number, fastWindowMs: number): HistoryPoint[] {
  // Keep at least the fast window, with a 2x buffer so restarts (section 8.5,
  // "history older than the fast window is ignored") and the fast-window
  // lookback always have enough to work with, without growing unboundedly.
  const cutoff = now - fastWindowMs * 2;
  const pruned = history.filter((p) => p.t >= cutoff);
  return pruned.length > 0 ? pruned : history.slice(-1);
}

function oldestWithinWindow(history: HistoryPoint[], now: number, fastWindowMs: number): HistoryPoint {
  const cutoff = now - fastWindowMs;
  for (const p of history) {
    if (p.t >= cutoff) return p;
  }
  return history[history.length - 1]!;
}

/**
 * SPEC.md section 8.3: pure exit state machine, evaluated in order; the first
 * SELL, NEED_CONFIRM or explicit HOLD returns. No IO — callers own quoting,
 * persistence and alerting.
 */
export function step(state: ExitState, inputs: ExitStateMachineInputs, cfg: ExitStateMachineConfig): ExitStepResult {
  const s: ExitState = { ...state, history: [...state.history] };
  const logs: string[] = [];
  const fastWindowMs = cfg.fastWindowMinutes * 60_000;

  // 1. No route
  if (inputs.pnlPct === null) {
    if (s.noRouteSince === null) s.noRouteSince = inputs.now;
    if (inputs.now - s.noRouteSince >= cfg.noRouteExitSec * 1000) {
      return { action: "SELL", reason: "no_route", newState: s, logs };
    }
    return { action: "HOLD", newState: s, logs };
  }
  s.noRouteSince = null;

  // 2. Liquidity pull — only touches lowLiqStreak when there's an actual new reading.
  if (inputs.liquidityUsd !== undefined) {
    if (inputs.liquidityUsd < s.entryLiquidity * (1 - cfg.liqDropExitPct / 100)) {
      s.lowLiqStreak += 1;
    } else {
      s.lowLiqStreak = 0;
    }
    if (s.lowLiqStreak >= cfg.liqDropConfirmReads) {
      return { action: "SELL", reason: "liq_pull", newState: s, logs };
    }
  }

  // 3. Stop-loss
  let pnl = inputs.pnlPct;
  if (pnl <= -cfg.stopLossPct) {
    if (inputs.confirmPnlPct === undefined) {
      return { action: "NEED_CONFIRM", newState: s };
    }
    if (inputs.confirmPnlPct <= -cfg.stopLossPct) {
      return { action: "SELL", reason: "stop", newState: s, logs };
    }
    pnl = inputs.confirmPnlPct;
  }

  // 4. Record
  s.peakPnl = Math.max(s.peakPnl, pnl);
  s.history.push({ t: inputs.now, pnl });
  s.history = pruneHistory(s.history, inputs.now, fastWindowMs);

  // 5. Fast
  const old = oldestWithinWindow(s.history, inputs.now, fastWindowMs);
  const rawFast = inputs.now - old.t >= cfg.fastMinHistorySec * 1000 && pnl - old.pnl >= cfg.fastGainPct;
  s.fastStreak = rawFast ? s.fastStreak + 1 : 0;
  const isFast = s.fastStreak >= cfg.fastConfirmPolls;

  // 6. Timer restart
  if (
    isFast &&
    s.timerRestarts < cfg.maxTimerRestarts &&
    (s.lastRestartAt === null || inputs.now - s.lastRestartAt >= fastWindowMs)
  ) {
    s.deadline = inputs.now + cfg.holdMinutes * 60_000;
    s.timerRestarts += 1;
    s.lastRestartAt = inputs.now;
    logs.push("timer_restart");
  }

  // 7. Breakeven
  if (cfg.breakevenTriggerPct > 0 && s.peakPnl >= cfg.breakevenTriggerPct && pnl <= cfg.breakevenFloorPct) {
    return { action: "SELL", reason: "breakeven", newState: s, logs };
  }

  // 8. Target
  if (pnl >= s.currentTarget) {
    s.trailArmed = true;
    if (isFast && s.targetExtensions < cfg.maxTargetExtensions) {
      s.currentTarget += cfg.extraTargetPct;
      s.targetExtensions += 1;
      logs.push("target_raised");
      return { action: "HOLD", newState: s, logs };
    }
    return { action: "SELL", reason: "target", newState: s, logs };
  }

  // 9. Trail
  if (s.trailArmed && pnl <= s.peakPnl - cfg.trailPct) {
    return { action: "SELL", reason: "trail", newState: s, logs };
  }

  // 10. Max hold
  if (inputs.now - s.entryTime >= cfg.maxTotalHoldMinutes * 60_000) {
    return { action: "SELL", reason: "max_hold", newState: s, logs };
  }

  // 11. Deadline
  if (inputs.now >= s.deadline) {
    const reason: ExitReason = Math.abs(pnl) <= cfg.flatBandPct ? "time_flat" : "time_exit";
    return { action: "SELL", reason, newState: s, logs };
  }

  // 12. Otherwise
  return { action: "HOLD", newState: s, logs };
}

/**
 * SPEC.md section 8.2's initial state, and 8.1's "the first history point is
 * recorded at entry." `entryPnlPct` should be computed from a real exit-lane
 * quote fetched immediately after the entry fill (a just-opened position is
 * typically already below zero — round-trip fees, price impact, simulated
 * slippage — never assume it's exactly 0%). Pass null when that quote
 * failed: history then starts empty and peakPnl starts at -Infinity (never
 * a fabricated reading), so the first *real* regular poll's pnl — whatever
 * its sign — always becomes the peak via step 4's Math.max, instead of
 * being silently floored at a guessed starting value.
 */
export function initialExitState(opts: {
  entryTime: number;
  entryLiquidity: number;
  targetProfitPct: number;
  holdMinutes: number;
  entryPnlPct: number | null;
}): ExitState {
  // peakPnl is always derived from the same value recorded as history[0] (when there is
  // one) — never a second, independently hardcoded literal that could drift out of sync
  // with it. A trade that stops out on its very first confirmed reading, before step 4
  // ever runs, keeps this exact initial value as its peak, since it's a real observation
  // (or, in the no-quote fallback, the neutral default), not an arbitrary starting number.
  const history: HistoryPoint[] = opts.entryPnlPct !== null ? [{ t: opts.entryTime, pnl: opts.entryPnlPct }] : [];
  return {
    entryTime: opts.entryTime,
    entryLiquidity: opts.entryLiquidity,
    peakPnl: opts.entryPnlPct ?? Number.NEGATIVE_INFINITY,
    currentTarget: opts.targetProfitPct,
    targetExtensions: 0,
    timerRestarts: 0,
    lastRestartAt: null,
    deadline: opts.entryTime + opts.holdMinutes * 60_000,
    trailArmed: false,
    fastStreak: 0,
    lowLiqStreak: 0,
    noRouteSince: null,
    history,
  };
}

/**
 * A closed trade's peak can never be reported as worse than its own final
 * realized pnl — true by definition (peak = the highest pnl ever observed,
 * and the closing reading is one such observation). This guards the rare
 * compound case where the quote-failure fallback above leaves peakPnl at
 * -Infinity and the position then closes on a confirmed stop-loss before
 * step 4 ever runs (section 8.3 order: stop-loss is step 3, record is step
 * 4) — without this, -Infinity would otherwise be the value persisted and
 * reported as that trade's peak.
 */
export function finalPeakPnl(peakPnl: number, finalPnlPct: number): number {
  return Math.max(peakPnl, finalPnlPct);
}
