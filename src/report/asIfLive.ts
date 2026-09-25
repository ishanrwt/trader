import { recordTradeOutcome } from "../risk/index.js";
import { tradingDayKey } from "../time.js";
import type { HaltName } from "../risk/halts.js";

/**
 * SPEC.md section 11.4 "as if live": replays section 9.1's daily-loss halt and
 * loss-streak pause over paper trades in entry order and drops the trades a
 * live bot would have skipped. Only kept trades feed the replayed state, so a
 * loss taken during a would-be pause never extends the replayed streak.
 *
 * Approximations (printed with the result): unrealized losses on open
 * positions aren't replayed (only realized PnL at each exit counts), and slot
 * usage differs (a dropped trade may have freed a slot for a candidate paper
 * never took). The limits are the ones passed in, i.e. the current `.env`.
 */

export interface ReplayTrade {
  entryTime: number;
  exitTime: number;
  /** Trading day of the exit, as stored (the day the realized PnL counts toward, section 9.1). */
  tradingDay: string;
  netPnlUsd: number;
  proceedsUnknown?: boolean;
}

export interface ReplayConfig {
  maxDailyLossUsd: number;
  consecutiveLossPause: number;
  lossPauseMinutes: number;
  tradingDayTz: string;
}

export interface ReplayResult<T extends ReplayTrade> {
  kept: T[];
  dropped: Array<{ trade: T; reasons: HaltName[] }>;
}

export function replayAsIfLive<T extends ReplayTrade>(trades: readonly T[], cfg: ReplayConfig): ReplayResult<T> {
  const ordered = trades.map((t, i) => ({ t, i })).sort((a, b) => a.t.entryTime - b.t.entryTime || a.i - b.i);
  const kept: T[] = [];
  const dropped: ReplayResult<T>["dropped"] = [];

  // Exits of kept trades not yet applied, applied in exit order before any entry at or after them.
  const pendingExits: T[] = [];
  const realizedByDay = new Map<string, number>();
  const haltedDays = new Set<string>();
  let streak = { consecutiveLosses: 0, pauseUntil: null as number | null };

  const applyExitsUpTo = (time: number) => {
    pendingExits.sort((a, b) => a.exitTime - b.exitTime);
    while (pendingExits.length > 0 && pendingExits[0]!.exitTime <= time) {
      const x = pendingExits.shift()!;
      // Daily loss counts every realized trade, proceeds_unknown included (as realizedNetPnlForDay does).
      const dayTotal = (realizedByDay.get(x.tradingDay) ?? 0) + x.netPnlUsd;
      realizedByDay.set(x.tradingDay, dayTotal);
      if (dayTotal <= -cfg.maxDailyLossUsd) haltedDays.add(x.tradingDay); // sticky for the rest of that day
      // The streak skips proceeds_unknown trades (applyTradeToLossStreak).
      if (!x.proceedsUnknown) {
        streak = recordTradeOutcome(streak, x.netPnlUsd, x.exitTime, { consecutiveLossPause: cfg.consecutiveLossPause, lossPauseMinutes: cfg.lossPauseMinutes });
      }
    }
  };

  for (const { t } of ordered) {
    applyExitsUpTo(t.entryTime); // an exit at the same instant as an entry is applied first
    const reasons: HaltName[] = [];
    if (haltedDays.has(tradingDayKey(t.entryTime, cfg.tradingDayTz))) reasons.push("daily_loss");
    if (streak.pauseUntil !== null && t.entryTime < streak.pauseUntil) reasons.push("loss_streak");
    if (reasons.length > 0) {
      dropped.push({ trade: t, reasons });
    } else {
      kept.push(t);
      pendingExits.push(t);
    }
  }
  return { kept, dropped };
}
