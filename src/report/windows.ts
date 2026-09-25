import type { Db } from "../storage/db.js";
import { FeeLossesStore } from "../storage/feeLosses.js";
import { TradesStore } from "../storage/trades.js";
import { tradingDayKey } from "../time.js";

/**
 * Per-window stats for one trading day (SPEC.md section 11.4, `--windows` and
 * `/windows`): the day split into DIGEST_INTERVAL_MINUTES slices aligned to
 * local midnight in TRADING_DAY_TZ. Derived only from `trades` (by exit time)
 * and `fee_losses` (by ts); it never reads `events`, so a trade closed while a
 * digest was skipped or delayed still lands in its window.
 */

export interface WindowTrade {
  exitTime: number;
  netPnlUsd: number;
  proceedsUnknown: boolean;
}

export interface WindowFeeLoss {
  ts: number;
  usd: number;
}

export interface WindowRow {
  /** Minutes since local midnight. */
  startMin: number;
  endMin: number;
  trades: number;
  wins: number;
  /** Trades excluded from wins and net because their proceeds are unknown (section 16.5). */
  proceedsUnknown: number;
  feeLossUsd: number;
  /** Sum of net PnL USD over known-proceeds trades, minus fee losses. */
  netUsd: number;
  current: boolean;
}

export interface WindowStatsResult {
  day: string;
  timeZone: string;
  intervalMin: number;
  rows: WindowRow[];
  total: { trades: number; wins: number; proceedsUnknown: number; feeLossUsd: number; netUsd: number };
}

const MINUTES_PER_DAY = 24 * 60;

/** Minutes since local midnight in `timeZone` (wall clock). */
export function localMinuteOfDay(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return hour * 60 + minute;
}

/**
 * Pure. `trades` and `feeLosses` must already be one mode's rows for `day`.
 * For today, rows run up to and including the window containing `now`; for a
 * past day, every window is listed; empty windows are always shown.
 */
export function windowStats(
  trades: readonly WindowTrade[],
  feeLosses: readonly WindowFeeLoss[],
  opts: { day: string; timeZone: string; intervalMin: number; now: number },
): WindowStatsResult {
  const { day, timeZone, intervalMin, now } = opts;
  if (!(intervalMin > 0)) throw new Error(`intervalMin must be positive, got ${intervalMin}`);
  const bucketOf = (ms: number) => Math.floor(localMinuteOfDay(ms, timeZone) / intervalMin);
  const totalBuckets = Math.ceil(MINUTES_PER_DAY / intervalMin);
  const today = tradingDayKey(now, timeZone);
  const currentBucket = day === today ? bucketOf(now) : null;
  const lastBucket = day === today ? currentBucket! : day < today ? totalBuckets - 1 : -1;

  const rows: WindowRow[] = [];
  for (let b = 0; b <= lastBucket; b++) {
    rows.push({
      startMin: b * intervalMin,
      endMin: Math.min((b + 1) * intervalMin, MINUTES_PER_DAY),
      trades: 0,
      wins: 0,
      proceedsUnknown: 0,
      feeLossUsd: 0,
      netUsd: 0,
      current: b === currentBucket,
    });
  }
  for (const t of trades) {
    const row = rows[bucketOf(t.exitTime)];
    if (!row) continue; // after `now` (clock skew): nothing to show yet
    row.trades++;
    if (t.proceedsUnknown) {
      row.proceedsUnknown++;
      continue;
    }
    if (t.netPnlUsd > 0) row.wins++;
    row.netUsd += t.netPnlUsd;
  }
  for (const f of feeLosses) {
    const row = rows[bucketOf(f.ts)];
    if (!row) continue;
    row.feeLossUsd += f.usd;
    row.netUsd -= f.usd;
  }

  const total = { trades: 0, wins: 0, proceedsUnknown: 0, feeLossUsd: 0, netUsd: 0 };
  for (const r of rows) {
    total.trades += r.trades;
    total.wins += r.wins;
    total.proceedsUnknown += r.proceedsUnknown;
    total.feeLossUsd += r.feeLossUsd;
    total.netUsd += r.netUsd;
  }
  return { day, timeZone, intervalMin, rows, total };
}

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function signedUsd(v: number): string {
  const r = Math.round(v * 100) / 100;
  if (r === 0) return "$0.00";
  return `${r > 0 ? "+" : "-"}$${Math.abs(r).toFixed(2)}`;
}

function describe(s: { trades: number; wins: number; proceedsUnknown: number; feeLossUsd: number; netUsd: number }, live: boolean): string {
  if (s.trades === 0 && s.feeLossUsd === 0) return "0 trades";
  const parts = [`${s.trades} ${s.trades === 1 ? "trade" : "trades"}`, `${s.wins} ${s.wins === 1 ? "win" : "wins"}`];
  if (live && s.feeLossUsd > 0) parts.push(`fee losses $${s.feeLossUsd.toFixed(2)}`);
  parts.push(`net ${signedUsd(s.netUsd)}`);
  const line = parts.join(", ");
  return s.proceedsUnknown > 0 ? `${line} (${s.proceedsUnknown} proceeds unknown, not in wins or net)` : line;
}

export function formatWindowStats(mode: string, r: WindowStatsResult): string {
  const live = mode === "live";
  const lines = [`${mode.toUpperCase()}: trading day ${r.day} (${r.timeZone}), ${r.intervalMin}-min windows`];
  if (r.rows.length === 0) {
    lines.push("  (no windows yet)");
    return lines.join("\n");
  }
  for (const row of r.rows) {
    lines.push(`  ${hhmm(row.startMin)}-${hhmm(row.endMin)}${row.current ? " (current)" : ""}: ${describe(row, live)}`);
  }
  lines.push(`  day total: ${describe(r.total, live)}`);
  return lines.join("\n");
}

/** Reads one mode's trades and fee losses for `day` from the database and formats the windows. */
export function buildWindowsReport(db: Db, opts: { mode: string; day: string; timeZone: string; intervalMin: number; now: number }): string {
  const trades = new TradesStore(db)
    .listForTradingDay(opts.day)
    .filter((t) => t.mode === opts.mode)
    .map((t) => ({ exitTime: t.exitTime, netPnlUsd: t.netPnlUsd, proceedsUnknown: t.proceedsUnknown }));
  const feeLosses = new FeeLossesStore(db)
    .listAll({ mode: opts.mode, from: opts.day, to: opts.day })
    .map((f) => ({ ts: f.ts, usd: f.usd }));
  return formatWindowStats(opts.mode, windowStats(trades, feeLosses, opts));
}
