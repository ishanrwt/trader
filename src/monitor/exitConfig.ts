import type { ExitStateMachineConfig } from "./stateMachine.js";

/** The .env fields the exit state machine reads (SPEC.md section 8.3). */
export interface ExitEnvFields {
  STOP_LOSS_PCT: number;
  EXTRA_TARGET_PCT: number;
  MAX_TARGET_EXTENSIONS: number;
  HOLD_MINUTES: number;
  FAST_GAIN_PCT: number;
  FAST_WINDOW_MINUTES: number;
  FAST_MIN_HISTORY_SEC: number;
  FAST_CONFIRM_POLLS: number;
  MAX_TIMER_RESTARTS: number;
  MAX_TOTAL_HOLD_MINUTES: number;
  TRAIL_PCT: number;
  BREAKEVEN_TRIGGER_PCT: number;
  BREAKEVEN_FLOOR_PCT: number;
  FLAT_BAND_PCT: number;
  LIQ_DROP_EXIT_PCT: number;
  LIQ_DROP_CONFIRM_READS: number;
  NO_ROUTE_EXIT_SEC: number;
}

/** Maps .env fields to the state machine's config; shared by the bot and the offline replay. */
export function exitConfigFromEnv(c: ExitEnvFields): ExitStateMachineConfig {
  return {
    stopLossPct: c.STOP_LOSS_PCT,
    extraTargetPct: c.EXTRA_TARGET_PCT,
    maxTargetExtensions: c.MAX_TARGET_EXTENSIONS,
    holdMinutes: c.HOLD_MINUTES,
    fastGainPct: c.FAST_GAIN_PCT,
    fastWindowMinutes: c.FAST_WINDOW_MINUTES,
    fastMinHistorySec: c.FAST_MIN_HISTORY_SEC,
    fastConfirmPolls: c.FAST_CONFIRM_POLLS,
    maxTimerRestarts: c.MAX_TIMER_RESTARTS,
    maxTotalHoldMinutes: c.MAX_TOTAL_HOLD_MINUTES,
    trailPct: c.TRAIL_PCT,
    breakevenTriggerPct: c.BREAKEVEN_TRIGGER_PCT,
    breakevenFloorPct: c.BREAKEVEN_FLOOR_PCT,
    flatBandPct: c.FLAT_BAND_PCT,
    liqDropExitPct: c.LIQ_DROP_EXIT_PCT,
    liqDropConfirmReads: c.LIQ_DROP_CONFIRM_READS,
    noRouteExitSec: c.NO_ROUTE_EXIT_SEC,
  };
}
