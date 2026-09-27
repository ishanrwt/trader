import type { MintFeaturesRow } from "../storage/mintFeatures.js";
import { tradingDayKey } from "../time.js";
import type { RugFeatureName } from "../tracking/rugFeatures.js";
import { computeTotals, quantileBuckets, type TradeRecord } from "./index.js";

/**
 * SPEC.md section 11.4 / 11.6: rug-risk features in the report. Coverage is
 * over every mint recorded in the period (how often each feature is null, by
 * reason code); quartiles and breakdowns are over the period's trades that
 * have features, joined by mint.
 */

/** Which stored value stands for each feature's coverage. */
const COVERAGE: ReadonlyArray<{ name: RugFeatureName; label: string; value: (f: MintFeaturesRow) => unknown }> = [
  { name: "pool", label: "pool", value: (f) => f.poolProgram },
  { name: "pumpMigrated", label: "pump.fun migrated", value: (f) => f.pumpMigrated },
  { name: "lp", label: "LP status", value: (f) => f.lpStatus },
  { name: "holderCount", label: "holder count", value: (f) => f.holderCount },
  { name: "sniperShare", label: "sniper share", value: (f) => f.sniperSharePct },
  { name: "creatorHolding", label: "creator holding", value: (f) => f.creatorHoldingPct },
  { name: "rugcheck", label: "RugCheck", value: (f) => f.rugcheckScore },
];

const NUMERIC: ReadonlyArray<{ label: string; key: (f: MintFeaturesRow, t: TradeRecord) => number | null; digits: number }> = [
  { label: "LP burned %", key: (f) => f.lpBurnedPct, digits: 1 },
  { label: "holder count", key: (f) => f.holderCount, digits: 0 },
  { label: "sniper share %", key: (f) => f.sniperSharePct, digits: 1 },
  { label: "creator holding %", key: (f) => f.creatorHoldingPct, digits: 2 },
  { label: "RugCheck score", key: (f) => f.rugcheckScore, digits: 0 },
  { label: "pool age min", key: (_f, t) => (t.pairAgeMs === null ? null : t.pairAgeMs / 60_000), digits: 1 },
];

/** Mints recorded in a mode and period (by the trading day of `recorded_at`). */
export function rugFeaturesFor(rows: readonly MintFeaturesRow[], opts: { mode: string; timeZone: string; from?: string; to?: string }): MintFeaturesRow[] {
  return rows.filter((r) => {
    if (r.mode !== opts.mode) return false;
    const day = tradingDayKey(r.recordedAt, opts.timeZone);
    return (opts.from === undefined || day >= opts.from) && (opts.to === undefined || day <= opts.to);
  });
}

/** Per feature: how many recorded mints have no value, by reason code ("unknown" if none was stored). */
export function rugCoverage(rows: readonly MintFeaturesRow[]): Array<{ label: string; nulls: number; byReason: Record<string, number> }> {
  return COVERAGE.map((c) => {
    const byReason: Record<string, number> = {};
    let nulls = 0;
    for (const r of rows) {
      if (c.value(r) !== null && c.value(r) !== undefined) continue;
      nulls++;
      const reason = r.reasons[c.name] ?? "unknown";
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    }
    return { label: c.label, nulls, byReason };
  });
}

function fmtGroup(trades: readonly TradeRecord[]): string {
  const t = computeTotals(trades);
  return `${t.trades} trades, win rate ${(t.winRate * 100).toFixed(0)}%, median ${t.medianNetPnlPct.toFixed(1)}%`;
}

export function formatRugSection(rows: readonly MintFeaturesRow[], trades: readonly TradeRecord[]): string[] {
  const byMint = new Map(rows.map((r) => [r.mint, r]));
  const joined = trades.filter((t) => t.mint !== undefined && byMint.has(t.mint));
  const f = (t: TradeRecord) => byMint.get(t.mint!)!;
  const lines = [`Rug-risk features (section 11.6): ${rows.length} mints recorded; ${joined.length} of ${trades.length} trades have them`];

  lines.push("  coverage (null of recorded, by reason):");
  for (const c of rugCoverage(rows)) {
    const reasons = Object.entries(c.byReason)
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r} ${n}`)
      .join(", ");
    lines.push(`    ${c.label}: ${c.nulls} of ${rows.length} null${reasons ? ` (${reasons})` : ""}`);
  }

  lines.push("  quartiles over trades (Q1 lowest; [range] trades, win rate, median net PnL %):");
  for (const n of NUMERIC) {
    const key = (t: TradeRecord) => n.key(f(t), t);
    const buckets = quantileBuckets(joined, key, 4);
    const missing = joined.filter((t) => key(t) === null).length;
    const parts = buckets.map(
      (b) => `Q${b.bucket} [${b.min.toFixed(n.digits)}..${b.max.toFixed(n.digits)}] ${b.count}, ${(b.totals.winRate * 100).toFixed(0)}%, ${b.totals.medianNetPnlPct.toFixed(1)}%`,
    );
    lines.push(`    ${n.label}: ${parts.join(" | ") || "no data"}${missing > 0 ? `; missing ${missing}` : ""}`);
  }

  const categorical = (label: string, value: (r: MintFeaturesRow) => string | null) => {
    const groups = new Map<string, TradeRecord[]>();
    let missing = 0;
    for (const t of joined) {
      const v = value(f(t));
      if (v === null) {
        missing++;
        continue;
      }
      groups.set(v, [...(groups.get(v) ?? []), t]);
    }
    const parts = [...groups.entries()].sort().map(([v, ts]) => `${v}: ${fmtGroup(ts)}`);
    lines.push(`    ${label}: ${parts.join(" | ") || "no data"}${missing > 0 ? `; missing ${missing}` : ""}`);
  };
  lines.push("  breakdowns over trades:");
  categorical("LP status", (r) => r.lpStatus);
  categorical("pump.fun migrated", (r) => (r.pumpMigrated === null ? null : r.pumpMigrated ? "yes" : "no"));
  return lines;
}
