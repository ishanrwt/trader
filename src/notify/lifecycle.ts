import type { StateStore } from "../storage/state.js";

const LAST_ALIVE_KEY = "lastAliveAt";

export interface StartupInfo {
  isRestart: boolean;
  downtimeMs: number | null;
}

/**
 * SPEC.md section 10: urgent alert on "startup after a crash or restart," with
 * the downtime gap when it's a restart. A fresh first-ever run has no prior
 * heartbeat, so it's reported as a start, not a restart.
 */
export function detectStartup(stateStore: StateStore, now: number): StartupInfo {
  const lastAliveAt = stateStore.get<number | null>(LAST_ALIVE_KEY, null);
  if (lastAliveAt === null) {
    return { isRestart: false, downtimeMs: null };
  }
  return { isRestart: true, downtimeMs: Math.max(0, now - lastAliveAt) };
}

/** Call periodically while the process is alive so the next restart's gap is accurate. */
export function heartbeat(stateStore: StateStore, now: number): void {
  stateStore.set(LAST_ALIVE_KEY, now);
}
