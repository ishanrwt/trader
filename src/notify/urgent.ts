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
