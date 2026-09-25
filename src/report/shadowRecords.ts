import type { ShadowRow } from "../storage/shadows.js";
import { tradingDayKey } from "../time.js";
import type { ShadowRecord } from "./index.js";

/**
 * One mode's shadows for a report period (by the trading day of the shadow's
 * entry, inclusive), as the report's shadow section takes them (section 11.4).
 * `rows` come from ShadowsStore.listAll, which already excludes duplicates.
 */
export function shadowRecordsFor(rows: readonly ShadowRow[], opts: { mode: string; timeZone: string; from?: string; to?: string }): ShadowRecord[] {
  return rows
    .filter((s) => (s.mode ?? "paper") === opts.mode)
    .filter((s) => {
      const day = tradingDayKey(s.entryTime, opts.timeZone);
      return (opts.from === undefined || day >= opts.from) && (opts.to === undefined || day <= opts.to);
    })
    .map((s) => ({
      mint: s.mint,
      entryTime: s.entryTime,
      outcome: s.outcome,
      classification: s.classification,
      netPnlUsd: s.netPnlUsd,
      netPnlPct: s.netPnlPct,
    }));
}
