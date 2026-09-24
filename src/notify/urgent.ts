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

export function buildDailyLossHaltMessage(input: { dailyLossUsd: number; capUsd: number }): string {
  return `Daily loss halt: net PnL for the day is -$${Math.abs(input.dailyLossUsd).toFixed(2)}, past the -$${input.capUsd.toFixed(2)} cap. Entries halted until the next trading day.`;
}

export function buildErrorHaltMessage(input: { consecutiveErrors: number }): string {
  return `Error halt: ${input.consecutiveErrors} consecutive failed entries/loop errors. Entries halted until /resume.`;
}

export function buildKillSwitchMessage(input: { source: "file" | "command"; positionsClosing: number }): string {
  const via = input.source === "file" ? "the KILL file" : "/killswitch";
  return `Kill switch activated via ${via}. Closing ${input.positionsClosing} open position(s) and halting entries.`;
}
