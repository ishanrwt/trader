import type { Db } from "../storage/db.js";
import { logEvent } from "../storage/events.js";
import type { StopCheck } from "./index.js";

/**
 * SPEC.md section 8.3: every NEED_CONFIRM round trip is logged as a
 * `stop_confirm` event, confirmed or not, so how often the confirmation quote
 * disagreed (and the position was held) can be counted afterwards.
 */
export function logStopConfirm(db: Db, now: number, positionId: number, check: StopCheck): void {
  const verdict = check.confirmed ? "confirmed" : "not confirmed, held";
  logEvent(db, now, "stop_confirm", `Position ${positionId} stop ${verdict}`, { id: positionId, ...check });
}

/**
 * The stop values persisted on a position as it moves to `closing` (section 11.1),
 * later copied to its trade. Only a `stop` exit carries them.
 */
export function stopCloseFields(reason: string, stopCheck: StopCheck | undefined): { stopPollPnlPct?: number; stopConfirmPnlPct?: number | null } {
  if (reason !== "stop" || !stopCheck) return {};
  return { stopPollPnlPct: stopCheck.pollPnlPct, stopConfirmPnlPct: stopCheck.confirmPnlPct };
}
