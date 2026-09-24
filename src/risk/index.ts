import { tradingDayKey } from "../time.js";

export type EntryBlockerReason = "kill_switch" | "paused" | "daily_loss_halt" | "loss_streak_pause" | "error_halt" | "slots_full";

export interface EntryBlockerState {
  killed: boolean;
  paused: boolean;
  /** Trading-day key the daily-loss halt was triggered on, or null. Sticky for the rest of that day; only day rollover clears it — not /resume (section 9.1). */
  dailyLossHaltDay: string | null;
  /** Epoch ms the loss-streak pause (section 9.1) ends, or null. */
  pauseUntil: number | null;
  consecutiveErrors: number;
  openPositionsCount: number;
}

export interface EntryBlockerConfig {
  maxConsecutiveErrors: number;
  maxConcurrent: number;
}

/** SPEC.md section 9.1, checked before every entry. First blocker wins. */
export function checkEntryBlockers(state: EntryBlockerState, now: number, cfg: EntryBlockerConfig): EntryBlockerReason | null {
  if (state.killed) return "kill_switch";
  if (state.paused) return "paused";
  if (state.dailyLossHaltDay !== null) return "daily_loss_halt";
  if (state.pauseUntil !== null && now < state.pauseUntil) return "loss_streak_pause";
  if (state.consecutiveErrors >= cfg.maxConsecutiveErrors) return "error_halt";
  if (state.openPositionsCount >= cfg.maxConcurrent) return "slots_full";
  return null;
}

export interface DailyLossConfig {
  maxDailyLossUsd: number;
  tradingDayTz: string;
}

/**
 * SPEC.md section 9.1: realized net PnL for the trading day + the sum of
 * unrealized losses over open positions, compared against -MAX_DAILY_LOSS_USD.
 * Sticky for the rest of the trading day once triggered (not re-evaluated
 * back to "ok" if unrealized losses later shrink) and cleared only by day
 * rollover, matching "not clearable by /resume."
 */
export function updateDailyLossHalt(
  currentHaltDay: string | null,
  realizedNetPnlToday: number,
  unrealizedLossSum: number,
  now: number,
  cfg: DailyLossConfig,
): string | null {
  const today = tradingDayKey(now, cfg.tradingDayTz);
  if (currentHaltDay !== null) {
    return currentHaltDay === today ? currentHaltDay : null; // still today: sticky; a new day: cleared
  }
  const total = realizedNetPnlToday + unrealizedLossSum;
  return total <= -cfg.maxDailyLossUsd ? today : null;
}

export interface LossStreakConfig {
  consecutiveLossPause: number;
  lossPauseMinutes: number;
}

export interface LossStreakState {
  consecutiveLosses: number;
  pauseUntil: number | null;
}

/** SPEC.md section 9.1: CONSECUTIVE_LOSS_PAUSE losing trades in a row pauses entries. A win resets the streak. */
export function recordTradeOutcome(state: LossStreakState, netPnlUsd: number, now: number, cfg: LossStreakConfig): LossStreakState {
  const isWin = netPnlUsd > 0; // section 11.1's win definition
  if (isWin) return { consecutiveLosses: 0, pauseUntil: null };
  const consecutiveLosses = state.consecutiveLosses + 1;
  const pauseUntil = consecutiveLosses >= cfg.consecutiveLossPause ? now + cfg.lossPauseMinutes * 60_000 : state.pauseUntil;
  return { consecutiveLosses, pauseUntil };
}

export interface KillSwitchCheckResult {
  active: boolean;
  justActivated: boolean;
}

/**
 * SPEC.md section 9.2: the KILL file or /killswitch. Deliberately a pure,
 * cheap check with no dependency on whether an entry is being attempted —
 * the caller runs this on its own timer (every POLL_SECONDS) so it fires
 * even when MAX_CONCURRENT slots are already full and slot filling never runs.
 */
export function checkKillSwitch(previouslyActive: boolean, killFileExists: boolean, killFlagSet: boolean): KillSwitchCheckResult {
  const active = killFileExists || killFlagSet;
  return { active, justActivated: active && !previouslyActive };
}
