import type { PostExitTrackRow } from "../storage/postExitTracks.js";
import type { PostExitRecord } from "./index.js";

/**
 * One mode's post-exit tracks for a report period (by the trade's trading day,
 * inclusive), as the report's exited-too-early section takes them (section
 * 11.4). A track whose trade isn't in `trades` is left out.
 */
export function postExitRecordsFor(
  rows: readonly PostExitTrackRow[],
  trades: ReadonlyArray<{ id: number; mode: string; tradingDay: string }>,
  opts: { mode: string; from?: string; to?: string },
): PostExitRecord[] {
  const byId = new Map(trades.map((t) => [t.id, t]));
  return rows
    .filter((r) => {
      const t = byId.get(r.tradeId);
      return t !== undefined && t.mode === opts.mode && (opts.from === undefined || t.tradingDay >= opts.from) && (opts.to === undefined || t.tradingDay <= opts.to);
    })
    .map((r) => ({ exitPriceUsd: r.exitPriceUsd, exitPriceSource: r.exitPriceSource, price15mUsd: r.price15mUsd, price60mUsd: r.price60mUsd }));
}
