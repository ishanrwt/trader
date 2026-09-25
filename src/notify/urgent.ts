import { formatDurationMs } from "../time.js";

export function buildStartupMessage(input: { mode: string; isRestart: boolean; downtimeMs: number | null }): string {
  if (input.isRestart) {
    const gap = input.downtimeMs !== null ? formatDurationMs(input.downtimeMs) : "unknown";
    return `Trader restarted (${input.mode}). Downtime gap: ${gap}.`;
  }
  return `Trader started (${input.mode}).`;
}

export function buildOutageStartedMessage(service: string, outageAlertMinutes: number): string {
  return `${service} has been unreachable for over ${outageAlertMinutes}m.`;
}

export function buildOutageRecoveredMessage(service: string): string {
  return `${service} is reachable again.`;
}

/** SPEC.md section 10: no_route or a stuck sell (both urgent). */
export function buildStuckSellMessage(input: { mint: string; symbol?: string; reason: "no_route" | "written_off" | "stuck" }): string {
  const label = input.symbol ?? input.mint;
  const what = input.reason === "written_off" ? "written off at -100% (no route to sell)" : input.reason === "no_route" ? "stuck: no route to sell" : "stuck after repeated sell failures";
  return `Position ${label} ${what}.`;
}

/**
 * SPEC.md sections 9.1 and 10: the daily-loss halt alert. Enforcing (live, or
 * paper without PAPER_HALTS_OBSERVE_ONLY) keeps the original wording; observe
 * mode says the halt would trigger and trading continues. `lateForDay` is set
 * when the halt was recorded for a trading day that has already ended before
 * the alert could go out (e.g. the bot stopped in between).
 */
export function buildDailyLossHaltMessage(input: { dailyLossUsd: number | null; capUsd: number; observeOnly?: boolean; lateForDay?: string }): string {
  const loss = input.dailyLossUsd === null ? "n/a" : `-$${Math.abs(input.dailyLossUsd).toFixed(2)}`;
  const text = input.observeOnly
    ? `PAPER: daily-loss halt would trigger (day ${loss} vs -$${input.capUsd.toFixed(2)} cap). Observing only, trading continues.`
    : `Daily loss halt: net PnL for the day is ${loss}, past the -$${input.capUsd.toFixed(2)} cap. Entries halted until the next trading day.`;
  return input.lateForDay ? `${text} (Sent late: recorded for trading day ${input.lateForDay}, which has already ended.)` : text;
}

/**
 * SPEC.md sections 9.1 and 10: sent when a loss-streak pause starts (not on
 * extensions). `untilClock` is the pause end as wall-clock time in
 * TRADING_DAY_TZ ("21:44 IST"). `alreadyEnded` is set when the pause ended
 * before the alert could go out.
 */
export function buildLossStreakPauseMessage(input: { streak: number; untilClock: string; observeOnly?: boolean; alreadyEnded?: boolean }): string {
  const text = input.observeOnly
    ? `PAPER: loss-streak pause would trigger (streak ${input.streak}, until ${input.untilClock}). Observing only, trading continues.`
    : `Loss-streak pause: ${input.streak} losing trades in a row. Entries paused until ${input.untilClock}.`;
  return input.alreadyEnded ? `${text} (Sent late: this pause already ended at ${input.untilClock}.)` : text;
}

export function buildErrorHaltMessage(input: { consecutiveErrors: number }): string {
  return `Error halt: ${input.consecutiveErrors} consecutive failed entries/loop errors. Entries halted until /resume.`;
}

export function buildKillSwitchMessage(input: { source: "file" | "command"; positionsClosing: number }): string {
  const via = input.source === "file" ? "the KILL file" : "/killswitch";
  return `Kill switch activated via ${via}. Closing ${input.positionsClosing} open position(s) and halting entries.`;
}
