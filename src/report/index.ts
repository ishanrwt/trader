import { equalSizeBuckets, maxDrawdown, mean, median, pearsonCorrelation, percentile } from "./stats.js";
import type { TradeRow } from "../storage/trades.js";
import { replayAsIfLive, type ReplayConfig } from "./asIfLive.js";

export interface TradeRecord {
  mode: "paper" | "live";
  exitTime: number;
  tradingDay: string;
  exitReason: string;
  netPnlUsd: number;
  netPnlPct: number;
  m5ChangePct: number | null;
  h1ChangePct: number | null;
  buyPressurePct: number | null; // buys/(buys+sells) * 100, from the entry snapshot
  liquidityUsd: number | null;
  pairAgeMs: number | null;
  top10Pct: number | null;
  score: number | null;
  scoreComponents: { buyPressure: number; activity: number; momentum: number; depth: number; holders: number; freshness: number } | null;
  /** A `reconciled` close whose proceeds are unknown (section 16.5): shown separately; excluded from win rate, median, mean and percentiles. */
  proceedsUnknown?: boolean;
  /** Needed by the as-if-live replay (section 11.4). */
  entryTime?: number;
  /** Needed to pair a selected shadow with its trade (section 11.4, shadow vs actual). */
  mint?: string;
  /** Section 11.1: halts a live bot would have been blocked by at entry; null/undefined = not recorded. */
  wouldBlockAtEntry?: string | null;
}

/** A paper trade the as-if-live replay can place in entry order. */
export type ReplayableTradeRecord = TradeRecord & { entryTime: number };

/** Section 11.4: paper-only "as if live" view, replayed over the whole paper history (the streak carries across periods). */
export interface AsIfLiveInput {
  cfg: ReplayConfig;
  allPaperTrades: readonly ReplayableTradeRecord[];
  /** The report period, by trading day (inclusive); kept/dropped counts and totals cover only this period. */
  from?: string;
  to?: string;
}

/** Fees of failed live transactions (section 16.3): realized losses outside any trade. */
export interface FeeLossRecord {
  ts: number;
  tradingDay: string;
  usd: number;
}

export interface TotalsResult {
  trades: number;
  winRate: number;
  medianNetPnlPct: number;
  meanNetPnlPct: number;
  medianNetPnlUsd: number;
  meanNetPnlUsd: number;
  p10NetPnlPct: number;
  p90NetPnlPct: number;
  avgWinUsd: number;
  avgLossUsd: number;
  totalNetPnlUsd: number;
  maxDrawdownUsd: number;
  /** Trades whose proceeds are unknown (counted in total and drawdown only). */
  proceedsUnknownCount: number;
  proceedsUnknownUsd: number;
  feeLossCount: number;
  feeLossUsd: number;
}

/** SPEC.md section 11.4: totals. A win is net PnL USD > 0 (section 11.1). */
export function computeTotals(trades: readonly TradeRecord[], feeLosses: readonly FeeLossRecord[] = []): TotalsResult {
  // Section 16.5: proceeds_unknown trades stay out of the per-trade statistics; they count in total and drawdown only.
  const known = trades.filter((t) => !t.proceedsUnknown);
  const unknown = trades.filter((t) => t.proceedsUnknown);
  const pnlUsd = known.map((t) => t.netPnlUsd);
  const pnlPct = known.map((t) => t.netPnlPct);
  const wins = known.filter((t) => t.netPnlUsd > 0);
  const losses = known.filter((t) => t.netPnlUsd <= 0);
  // Section 16.3: fee losses of failed transactions count toward total net PnL and max drawdown.
  const chronological = [
    ...trades.map((t) => ({ at: t.exitTime, usd: t.netPnlUsd })),
    ...feeLosses.map((f) => ({ at: f.ts, usd: -f.usd })),
  ]
    .sort((a, b) => a.at - b.at)
    .map((e) => e.usd);
  const unknownUsd = unknown.reduce((s, t) => s + t.netPnlUsd, 0);
  const feeLossUsd = feeLosses.reduce((s, f) => s + f.usd, 0);

  return {
    trades: trades.length,
    winRate: known.length > 0 ? wins.length / known.length : 0,
    medianNetPnlPct: median(pnlPct),
    meanNetPnlPct: mean(pnlPct),
    medianNetPnlUsd: median(pnlUsd),
    meanNetPnlUsd: mean(pnlUsd),
    p10NetPnlPct: percentile(pnlPct, 10),
    p90NetPnlPct: percentile(pnlPct, 90),
    avgWinUsd: wins.length > 0 ? mean(wins.map((t) => t.netPnlUsd)) : 0,
    avgLossUsd: losses.length > 0 ? mean(losses.map((t) => t.netPnlUsd)) : 0,
    totalNetPnlUsd: pnlUsd.reduce((a, b) => a + b, 0) + unknownUsd - feeLossUsd,
    maxDrawdownUsd: maxDrawdown(chronological),
    proceedsUnknownCount: unknown.length,
    proceedsUnknownUsd: unknownUsd,
    feeLossCount: feeLosses.length,
    feeLossUsd,
  };
}

export function breakdownByExitReason(trades: readonly TradeRecord[]): Record<string, TotalsResult> {
  const byReason = new Map<string, TradeRecord[]>();
  for (const t of trades) {
    const list = byReason.get(t.exitReason) ?? [];
    list.push(t);
    byReason.set(t.exitReason, list);
  }
  return Object.fromEntries([...byReason.entries()].map(([reason, ts]) => [reason, computeTotals(ts)]));
}

export function breakdownByTradingDay(trades: readonly TradeRecord[]): Record<string, TotalsResult> {
  const byDay = new Map<string, TradeRecord[]>();
  for (const t of trades) {
    const list = byDay.get(t.tradingDay) ?? [];
    list.push(t);
    byDay.set(t.tradingDay, list);
  }
  return Object.fromEntries([...byDay.entries()].map(([day, ts]) => [day, computeTotals(ts)]));
}

export interface QuantileBucketResult {
  bucket: number;
  count: number;
  totals: TotalsResult;
  /** Lowest and highest feature value in the bucket. */
  min: number;
  max: number;
}

/** SPEC.md section 11.4: results by entry-feature (or score) quantile buckets, earliest/lowest bucket first. */
export function quantileBuckets(trades: readonly TradeRecord[], keyFn: (t: TradeRecord) => number | null, buckets: number): QuantileBucketResult[] {
  const withKey = trades.filter((t) => keyFn(t) !== null).sort((a, b) => keyFn(a)! - keyFn(b)!);
  return equalSizeBuckets(withKey, buckets).map((group, i) => ({
    bucket: i + 1,
    count: group.length,
    totals: computeTotals(group),
    min: keyFn(group[0]!)!,
    max: keyFn(group[group.length - 1]!)!,
  }));
}

export interface ScoreComponentCorrelations {
  buyPressure: number;
  activity: number;
  momentum: number;
  depth: number;
  holders: number;
  freshness: number;
}

/** SPEC.md section 11.4: correlation of each score component with net PnL. */
export function scoreComponentCorrelations(trades: readonly TradeRecord[]): ScoreComponentCorrelations {
  const withScore = trades.filter((t): t is TradeRecord & { scoreComponents: NonNullable<TradeRecord["scoreComponents"]> } => t.scoreComponents !== null);
  const pnl = withScore.map((t) => t.netPnlUsd);
  const componentSeries = (key: keyof ScoreComponentCorrelations) => withScore.map((t) => t.scoreComponents[key]);
  return {
    buyPressure: pearsonCorrelation(componentSeries("buyPressure"), pnl),
    activity: pearsonCorrelation(componentSeries("activity"), pnl),
    momentum: pearsonCorrelation(componentSeries("momentum"), pnl),
    depth: pearsonCorrelation(componentSeries("depth"), pnl),
    holders: pearsonCorrelation(componentSeries("holders"), pnl),
    freshness: pearsonCorrelation(componentSeries("freshness"), pnl),
  };
}

/** A shadow as the report sees it (section 11.2): lifecycle and classification are separate. Duplicates are never passed in. */
export interface ShadowRecord {
  mint: string;
  entryTime: number;
  outcome: "open" | "closed";
  classification: "unselected" | "selected" | "unsellable";
  netPnlUsd: number | null;
  netPnlPct: number | null;
}

export interface ShadowComparisonResult {
  selected: TotalsResult;
  unselected: TotalsResult;
  /** Closed without PnL: shadows classified before the lifecycle fix were never priced (exit_reason 'not_priced'). */
  noData: { selected: number; unselected: number };
  /** Still being priced; not yet comparable. */
  stillOpen: number;
  /** Excluded from comparisons (section 11.2). */
  unsellable: number;
}

/**
 * SPEC.md section 11.4: shadows, selected vs unselected, over closed shadows
 * with PnL. Unsellable shadows are excluded; still-open and unpriced ("no
 * data") shadows are counted, not compared.
 */
export function compareShadowsSelectedVsUnselected(shadows: readonly ShadowRecord[]): ShadowComparisonResult {
  const comparable = shadows.filter((s) => s.classification !== "unsellable");
  const closed = comparable.filter((s) => s.outcome === "closed");
  const priced = closed.filter((s) => s.netPnlUsd !== null);
  const unpriced = closed.filter((s) => s.netPnlUsd === null);
  const asTrades = (list: readonly ShadowRecord[]): TradeRecord[] =>
    list.map((s) => ({
      mode: "paper",
      exitTime: 0,
      tradingDay: "",
      exitReason: "",
      netPnlUsd: s.netPnlUsd!,
      netPnlPct: s.netPnlPct ?? 0,
      m5ChangePct: null,
      h1ChangePct: null,
      buyPressurePct: null,
      liquidityUsd: null,
      pairAgeMs: null,
      top10Pct: null,
      score: null,
      scoreComponents: null,
    }));
  return {
    selected: computeTotals(asTrades(priced.filter((s) => s.classification === "selected"))),
    unselected: computeTotals(asTrades(priced.filter((s) => s.classification === "unselected"))),
    noData: {
      selected: unpriced.filter((s) => s.classification === "selected").length,
      unselected: unpriced.filter((s) => s.classification === "unselected").length,
    },
    stillOpen: comparable.filter((s) => s.outcome === "open").length,
    unsellable: shadows.length - comparable.length,
  };
}

export interface ShadowVsActualPair {
  shadowNetPnlPct: number;
  actualNetPnlPct: number;
}

export interface ShadowVsActualResult {
  pairs: number;
  meanAbsDiffPct: number;
  /** Mean of (shadow - actual): positive means the shadow method is optimistic. */
  meanSignedDiffPct: number;
  correlation: number;
}

/**
 * Pairs each selected shadow that has PnL with its mint's first trade that
 * entered at or after the shadow (same mode: callers pass one mode's shadows
 * and trades).
 */
export function pairShadowsWithTrades(
  shadows: readonly ShadowRecord[],
  trades: ReadonlyArray<{ mint?: string; entryTime?: number; netPnlPct: number }>,
): ShadowVsActualPair[] {
  const pairs: ShadowVsActualPair[] = [];
  for (const s of shadows) {
    if (s.classification !== "selected" || s.netPnlPct === null) continue;
    const match = trades
      .filter((t) => t.mint === s.mint && t.entryTime !== undefined && t.entryTime >= s.entryTime)
      .sort((a, b) => a.entryTime! - b.entryTime!)[0];
    if (match) pairs.push({ shadowNetPnlPct: s.netPnlPct, actualNetPnlPct: match.netPnlPct });
  }
  return pairs;
}

/** SPEC.md section 11.4: how closely the shadow method matches real quotes, for selected mints. */
export function compareShadowVsActual(pairs: readonly ShadowVsActualPair[]): ShadowVsActualResult {
  if (pairs.length === 0) return { pairs: 0, meanAbsDiffPct: 0, meanSignedDiffPct: 0, correlation: 0 };
  const diffs = pairs.map((p) => Math.abs(p.shadowNetPnlPct - p.actualNetPnlPct));
  return {
    pairs: pairs.length,
    meanAbsDiffPct: mean(diffs),
    meanSignedDiffPct: mean(pairs.map((p) => p.shadowNetPnlPct - p.actualNetPnlPct)),
    correlation: pearsonCorrelation(
      pairs.map((p) => p.shadowNetPnlPct),
      pairs.map((p) => p.actualNetPnlPct),
    ),
  };
}

/** A post-exit track as the report sees it (section 11.3). */
export interface PostExitRecord {
  exitPriceUsd: number | null;
  /** 'dexscreener_at_exit' is the only valid baseline; 'entry_snapshot' rows predate the fix. */
  exitPriceSource: string | null;
  price15mUsd: number | null;
  price60mUsd: number | null;
}

export interface HorizonResult {
  /** Trades with a valid exit price and a reading at this horizon. */
  withData: number;
  /** Share of those whose price at the horizon exceeded the exit price. */
  shareAbove: number;
  /** Median % above the exit price, among those that were above (0 if none). */
  medianUpsidePct: number;
}

export interface ExitedTooEarlyResult {
  at15m: HorizonResult;
  at60m: HorizonResult;
  /** Rows left out: no DexScreener price at exit (recorded before the fix, or the fetch failed). */
  excludedNoValidExitPrice: number;
}

/** SPEC.md section 11.4: share of trades whose post-exit price at +15 and at +60 min exceeded the exit price, and by how much. */
export function exitedTooEarly(rows: readonly PostExitRecord[]): ExitedTooEarlyResult {
  const valid = rows.filter((r) => r.exitPriceSource === "dexscreener_at_exit" && r.exitPriceUsd !== null && r.exitPriceUsd > 0);
  const horizon = (priceAt: (r: PostExitRecord) => number | null): HorizonResult => {
    const withData = valid.filter((r) => priceAt(r) !== null);
    const upsides = withData.map((r) => ((priceAt(r)! - r.exitPriceUsd!) / r.exitPriceUsd!) * 100).filter((u) => u > 0);
    return {
      withData: withData.length,
      shareAbove: withData.length > 0 ? upsides.length / withData.length : 0,
      medianUpsidePct: upsides.length > 0 ? median(upsides) : 0,
    };
  };
  return { at15m: horizon((r) => r.price15mUsd), at60m: horizon((r) => r.price60mUsd), excludedNoValidExitPrice: rows.length - valid.length };
}

export interface SkipTrackRecord {
  skipReason: string;
  priceAtSkipUsd: number | null;
  price15mUsd: number | null;
  price60mUsd: number | null;
}

export interface SkipReasonStat {
  reason: string;
  count: number;
  /** Rows with a price at skip (the baseline); rows recorded before the section 11.3 fix, and `pair` skips, have none. */
  withBaseline: number;
  /** null when no mint in this group has a priced +15m reading (e.g. it never had a valid pair) — distinct from a genuine 0% change. */
  median15mPctChange: number | null;
  /** null when no mint in this group has a priced +60m reading. */
  median60mPctChange: number | null;
}

/** Median of the non-null pct-change readings, or null if none of them have a price at all (not the same as a 0% change). */
function medianOrMissing(values: readonly (number | null)[]): number | null {
  const priced = values.filter((v): v is number => v !== null);
  return priced.length > 0 ? median(priced) : null;
}

/** SPEC.md section 11.4: skipped tokens, median +15/+60 price change by skip reason. */
export function skipReasonStats(rows: readonly SkipTrackRecord[]): SkipReasonStat[] {
  const byReason = new Map<string, SkipTrackRecord[]>();
  for (const r of rows) {
    const list = byReason.get(r.skipReason) ?? [];
    list.push(r);
    byReason.set(r.skipReason, list);
  }
  const pctChange = (base: number | null, at: number | null): number | null => (base === null || at === null || base === 0 ? null : ((at - base) / base) * 100);
  return [...byReason.entries()].map(([reason, rs]) => ({
    reason,
    count: rs.length,
    withBaseline: rs.filter((r) => r.priceAtSkipUsd !== null && r.priceAtSkipUsd > 0).length,
    median15mPctChange: medianOrMissing(rs.map((r) => pctChange(r.priceAtSkipUsd, r.price15mUsd))),
    median60mPctChange: medianOrMissing(rs.map((r) => pctChange(r.priceAtSkipUsd, r.price60mUsd))),
  }));
}

export interface GoLiveConfig {
  minTrades: number;
  minDays: number;
  minMedianPnlPct: number;
  minTotalPnlUsd: number;
  minP10PnlPct: number;
}

export interface GoLiveChecklistItem {
  check: string;
  pass: boolean;
  detail: string;
}

/** Renders every section of section 11.4 as plain text, shared by `npm run report` and `/report`. */
export function formatReport(input: {
  trades: readonly TradeRecord[];
  paperTrades: readonly TradeRecord[];
  skipTracks: readonly SkipTrackRecord[];
  hasStuckPositions: boolean;
  goLiveConfig: GoLiveConfig;
  /** Live only: fees of failed transactions in the same period (section 16.3). */
  feeLosses?: readonly FeeLossRecord[];
  /** Section 11.4: a heading naming the mode when both modes are printed. */
  modeLabel?: string;
  /** Paper only: adds the "as if live" block, and the go-live checklist uses it (section 11.4). */
  asIfLive?: AsIfLiveInput;
  /** This mode's shadows for the report period, duplicates already excluded (section 11.4 shadow section). */
  shadows?: readonly ShadowRecord[];
  /** This mode's post-exit tracks for the report period (section 11.4 exited too early). */
  postExit?: readonly PostExitRecord[];
}): string {
  const totals = computeTotals(input.trades, input.feeLosses ?? []);
  const byReason = breakdownByExitReason(input.trades);
  const byDay = breakdownByTradingDay(input.trades);
  const scoreQuintiles = quantileBuckets(input.trades, (t) => t.score, 5);
  const correlations = scoreComponentCorrelations(input.trades.filter((t) => !t.proceedsUnknown));
  const skipStats = skipReasonStats(input.skipTracks);
  const replay = input.asIfLive ? replayAsIfLive(input.asIfLive.allPaperTrades, input.asIfLive.cfg) : null;
  const checklist = goLiveChecklist(replay ? replay.kept : input.paperTrades, input.hasStuckPositions, input.goLiveConfig);

  const lines: string[] = [];
  if (input.modeLabel) lines.push(`##### ${input.modeLabel} #####`);
  lines.push(`=== Report (${input.trades.length} trades) ===`);
  if (input.asIfLive) {
    lines.push("View: all trades (everything paper took; see \"As if live\" below)");
    lines.push(`Taken under a would-be halt (tagged at entry): ${formatWouldBlockCounts(input.trades)}`);
  }
  if (input.modeLabel && input.trades.length === 0) lines.push(`No ${input.modeLabel.toLowerCase()} trades in this period.`);
  lines.push(
    `Win rate ${(totals.winRate * 100).toFixed(1)}%, median ${totals.medianNetPnlPct.toFixed(1)}%, total $${totals.totalNetPnlUsd.toFixed(2)}, max drawdown $${totals.maxDrawdownUsd.toFixed(2)}`,
  );
  lines.push(
    `Mean ${totals.meanNetPnlPct.toFixed(1)}%, median $${totals.medianNetPnlUsd.toFixed(2)}, mean $${totals.meanNetPnlUsd.toFixed(2)}, ` +
      `p10 ${totals.p10NetPnlPct.toFixed(1)}%, p90 ${totals.p90NetPnlPct.toFixed(1)}%, avg win $${totals.avgWinUsd.toFixed(2)} vs avg loss $${totals.avgLossUsd.toFixed(2)}`,
  );
  if (totals.proceedsUnknownCount > 0) {
    lines.push(
      `Proceeds unknown (reconciled, shown separately; excluded from win rate/median/mean/percentiles, included in total): ${totals.proceedsUnknownCount} trades, $${totals.proceedsUnknownUsd.toFixed(2)}`,
    );
  }
  if (input.feeLosses) {
    const byDayFees = new Map<string, number>();
    for (const f of input.feeLosses) byDayFees.set(f.tradingDay, (byDayFees.get(f.tradingDay) ?? 0) + f.usd);
    lines.push(
      `Fee losses from failed transactions (in total and drawdown): ${totals.feeLossCount}, $${totals.feeLossUsd.toFixed(4)}` +
        (byDayFees.size > 0 ? ` (${[...byDayFees].map(([d, u]) => `${d}: $${u.toFixed(4)}`).join(", ")})` : ""),
    );
  }
  lines.push(`By exit reason: ${Object.entries(byReason).map(([r, t]) => `${r}=${t.trades}`).join(", ") || "none"}`);
  for (const [reason, t] of Object.entries(byReason)) lines.push(`  ${reason}: ${fmtGroup(t)}`);
  lines.push(`Trading days: ${Object.keys(byDay).length}`);
  for (const day of Object.keys(byDay).sort()) lines.push(`  ${day}: ${fmtGroup(byDay[day]!)}`);
  lines.push(...formatFeatureQuartiles(input.trades));
  lines.push(`Score quintiles (trades/win rate): ${scoreQuintiles.map((b) => `${b.count}/${(b.totals.winRate * 100).toFixed(0)}%`).join(", ") || "none"}`);
  lines.push(
    `Component correlations: buyPressure=${correlations.buyPressure.toFixed(2)}, activity=${correlations.activity.toFixed(2)}, ` +
      `momentum=${correlations.momentum.toFixed(2)}, depth=${correlations.depth.toFixed(2)}, holders=${correlations.holders.toFixed(2)}, freshness=${correlations.freshness.toFixed(2)}`,
  );
  if (input.shadows) lines.push(...formatShadowSection(input.shadows, input.trades));
  if (input.postExit) lines.push(...formatExitedTooEarly(exitedTooEarly(input.postExit)));
  const fmtSkipPct = (v: number | null): string => (v === null ? "n/a" : `${v.toFixed(1)}%`);
  lines.push(
    `Skip reasons (median change from the price at skip; only rows with that baseline): ${
      skipStats.map((s) => `${s.reason}(n=${s.count}, with baseline ${s.withBaseline}, +15m=${fmtSkipPct(s.median15mPctChange)}, +60m=${fmtSkipPct(s.median60mPctChange)})`).join(", ") || "none"
    }`,
  );
  if (input.asIfLive && replay) lines.push(...formatAsIfLive(input.asIfLive, replay));
  lines.push(input.asIfLive ? "Go-live checklist (as if live):" : "Go-live checklist:");
  for (const item of checklist) lines.push(`  [${item.pass ? "PASS" : "FAIL"}] ${item.check} (${item.detail})`);
  return lines.join("\n");
}

function fmtGroup(t: TotalsResult): string {
  return `${t.trades} trades, win rate ${(t.winRate * 100).toFixed(1)}%, median ${t.medianNetPnlPct.toFixed(1)}%, total $${t.totalNetPnlUsd.toFixed(2)}`;
}

/** Section 11.4 entry features, in order; pair age is shown in minutes. */
const ENTRY_FEATURES: ReadonlyArray<{ label: string; key: (t: TradeRecord) => number | null; fmt: (v: number) => string }> = [
  { label: "m5 change %", key: (t) => t.m5ChangePct, fmt: (v) => v.toFixed(1) },
  { label: "h1 change %", key: (t) => t.h1ChangePct, fmt: (v) => v.toFixed(1) },
  { label: "buy pressure %", key: (t) => t.buyPressurePct, fmt: (v) => v.toFixed(1) },
  { label: "liquidity $", key: (t) => t.liquidityUsd, fmt: (v) => v.toFixed(0) },
  { label: "pair age min", key: (t) => (t.pairAgeMs === null ? null : t.pairAgeMs / 60_000), fmt: (v) => v.toFixed(1) },
  { label: "top-10 share %", key: (t) => t.top10Pct, fmt: (v) => v.toFixed(1) },
];

/** Section 11.4: results by entry-feature quartile (Q1 = lowest values); trades missing a feature are counted, not bucketed. */
export function formatFeatureQuartiles(trades: readonly TradeRecord[]): string[] {
  const lines = ["Entry-feature quartiles (Q1 lowest; [range] trades, win rate, median net PnL %):"];
  for (const f of ENTRY_FEATURES) {
    const buckets = quantileBuckets(trades, f.key, 4);
    const missing = trades.filter((t) => f.key(t) === null).length;
    const parts = buckets.map(
      (b) => `Q${b.bucket} [${f.fmt(b.min)}..${f.fmt(b.max)}] ${b.count}, ${(b.totals.winRate * 100).toFixed(0)}%, ${b.totals.medianNetPnlPct.toFixed(1)}%`,
    );
    lines.push(`  ${f.label}: ${parts.join(" | ") || "no data"}${missing > 0 ? `; missing ${missing}` : ""}`);
  }
  return lines;
}

/** Section 11.4: exited too early, per horizon, from valid DexScreener exit prices only. */
export function formatExitedTooEarly(r: ExitedTooEarlyResult): string[] {
  const h = (label: string, x: HorizonResult) =>
    x.withData === 0
      ? `  ${label}: no data`
      : `  ${label}: ${x.withData} with data, ${(x.shareAbove * 100).toFixed(1)}% above the exit price, median upside ${x.medianUpsidePct.toFixed(1)}% among those`;
  return [
    "Exited too early (DexScreener price after exit vs at exit):",
    h("+15m", r.at15m),
    h("+60m", r.at60m),
    `  excluded ${r.excludedNoValidExitPrice} with no valid exit price (recorded before the section 11.3 fix, or the fetch at exit failed)`,
  ];
}

/** Buy pressure at entry (section 11.4): m5 buys / (buys + sells) x 100 from the stored pair snapshot; null without txns. */
export function buyPressurePct(snapshot: unknown): number | null {
  const m5 = (snapshot as { txns?: { m5?: { buys?: unknown; sells?: unknown } } } | null)?.txns?.m5;
  const buys = finiteOrNull(m5?.buys);
  const sells = finiteOrNull(m5?.sells);
  if (buys === null || sells === null || buys + sells <= 0) return null;
  return (buys / (buys + sells)) * 100;
}

/** A stored trade as the aggregate report takes it; shared by `npm run report` and `/report`. */
export function tradeRowToRecord(t: TradeRow): ReplayableTradeRecord {
  const p = entryPairFields(t.entryPairSnapshot, t.entryTime);
  return {
    mode: t.mode as "paper" | "live",
    exitTime: t.exitTime,
    tradingDay: t.tradingDay,
    exitReason: t.exitReason,
    netPnlUsd: t.netPnlUsd,
    netPnlPct: t.netPnlPct,
    m5ChangePct: p?.priceChangeM5 ?? null,
    h1ChangePct: p?.priceChangeH1 ?? null,
    buyPressurePct: buyPressurePct(t.entryPairSnapshot),
    liquidityUsd: p?.liquidityUsd ?? null,
    pairAgeMs: p?.pairAgeMin === null || p?.pairAgeMin === undefined ? null : p.pairAgeMin * 60_000,
    top10Pct: t.top10Pct,
    score: t.score,
    scoreComponents: t.scoreComponents as TradeRecord["scoreComponents"],
    proceedsUnknown: t.proceedsUnknown,
    entryTime: t.entryTime,
    mint: t.mint,
    wouldBlockAtEntry: t.wouldBlockAtEntry,
  };
}

function fmtShadowSide(label: string, t: TotalsResult, noData: number): string {
  const stats =
    t.trades === 0
      ? "none with PnL"
      : `${t.trades} with PnL, win rate ${(t.winRate * 100).toFixed(1)}%, median ${t.medianNetPnlPct.toFixed(1)}%, mean ${t.meanNetPnlPct.toFixed(1)}%, ` +
        `p10 ${t.p10NetPnlPct.toFixed(1)}%, median $${t.medianNetPnlUsd.toFixed(2)}, mean $${t.meanNetPnlUsd.toFixed(2)}`;
  return `  ${label}: ${stats}; no data ${noData}`;
}

/** Section 11.4: selected vs unselected shadows, and shadow vs actual for selected mints. */
export function formatShadowSection(shadows: readonly ShadowRecord[], trades: readonly TradeRecord[]): string[] {
  const c = compareShadowsSelectedVsUnselected(shadows);
  const vs = compareShadowVsActual(pairShadowsWithTrades(shadows, trades));
  const pp = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`;
  return [
    "Shadows (excluding duplicates):",
    fmtShadowSide("selected", c.selected, c.noData.selected),
    fmtShadowSide("unselected", c.unselected, c.noData.unselected),
    `  still open ${c.stillOpen}; unsellable ${c.unsellable} (excluded); "no data" = closed without PnL (classified before the lifecycle fix, never priced)`,
    vs.pairs === 0
      ? "  shadow vs actual (selected mints): no pairs"
      : `  shadow vs actual (selected mints): ${vs.pairs} pairs, mean |diff| ${vs.meanAbsDiffPct.toFixed(1)}pp, ` +
        `mean diff (shadow - actual) ${pp(vs.meanSignedDiffPct)}, correlation ${vs.correlation.toFixed(2)}`,
  ];
}

/** "3 (daily_loss 1, loss_streak 2, both 0); not recorded 14", from the per-trade tags (section 11.1). */
export function formatWouldBlockCounts(trades: ReadonlyArray<{ wouldBlockAtEntry?: string | null }>): string {
  let dailyLoss = 0;
  let lossStreak = 0;
  let both = 0;
  let notRecorded = 0;
  for (const t of trades) {
    const tag = t.wouldBlockAtEntry ?? null;
    if (tag === null) notRecorded++;
    else if (tag === "daily_loss") dailyLoss++;
    else if (tag === "loss_streak") lossStreak++;
    else if (tag === "daily_loss+loss_streak") both++;
  }
  const total = dailyLoss + lossStreak + both;
  return `${total} (daily_loss ${dailyLoss}, loss_streak ${lossStreak}, both ${both})${notRecorded > 0 ? `; not recorded ${notRecorded}` : ""}`;
}

function inPeriod(day: string, from?: string, to?: string): boolean {
  return (from === undefined || day >= from) && (to === undefined || day <= to);
}

function formatAsIfLive(input: AsIfLiveInput, replay: ReturnType<typeof replayAsIfLive<ReplayableTradeRecord>>): string[] {
  const kept = replay.kept.filter((t) => inPeriod(t.tradingDay, input.from, input.to));
  const dropped = replay.dropped.filter((d) => inPeriod(d.trade.tradingDay, input.from, input.to));
  let dailyLoss = 0;
  let lossStreak = 0;
  let both = 0;
  for (const d of dropped) {
    if (d.reasons.length === 2) both++;
    else if (d.reasons[0] === "daily_loss") dailyLoss++;
    else lossStreak++;
  }
  const totals = computeTotals(kept);
  const byDay = breakdownByTradingDay(kept);
  const lines = [
    "--- As if live (section 9.1 halts replayed over paper trades) ---",
    `Limits used (current .env): MAX_DAILY_LOSS_USD=${input.cfg.maxDailyLossUsd}, CONSECUTIVE_LOSS_PAUSE=${input.cfg.consecutiveLossPause}, LOSS_PAUSE_MINUTES=${input.cfg.lossPauseMinutes}`,
    `Kept ${kept.length} of ${kept.length + dropped.length}; dropped ${dropped.length} (daily_loss ${dailyLoss}, loss_streak ${lossStreak}, both ${both})`,
    `Win rate ${(totals.winRate * 100).toFixed(1)}%, median ${totals.medianNetPnlPct.toFixed(1)}%, total $${totals.totalNetPnlUsd.toFixed(2)}, max drawdown $${totals.maxDrawdownUsd.toFixed(2)}`,
    "By trading day:",
  ];
  const days = Object.keys(byDay).sort();
  if (days.length === 0) lines.push("  none");
  for (const day of days) {
    const d = byDay[day]!;
    lines.push(`  ${day}: ${d.trades} trades, win rate ${(d.winRate * 100).toFixed(1)}%, total $${d.totalNetPnlUsd.toFixed(2)}`);
  }
  lines.push(
    "Approximations: only realized PnL is replayed (live also counts unrealized losses, so it can halt earlier); slot usage differs " +
      "(a dropped trade may have freed a slot for a candidate paper never took); the limits above are applied to all history.",
  );
  return lines;
}

/** SPEC.md section 11.4: go-live checklist, paper trades only. */
export function goLiveChecklist(paperTrades: readonly TradeRecord[], hasStuckPositions: boolean, cfg: GoLiveConfig): GoLiveChecklistItem[] {
  const totals = computeTotals(paperTrades);
  const times = paperTrades.map((t) => t.exitTime);
  const spanDays = times.length > 0 ? (Math.max(...times) - Math.min(...times)) / 86_400_000 : 0;

  return [
    { check: `closed trades >= ${cfg.minTrades}`, pass: totals.trades >= cfg.minTrades, detail: `${totals.trades}` },
    { check: `first-to-last trade span >= ${cfg.minDays} days`, pass: spanDays >= cfg.minDays, detail: `${spanDays.toFixed(1)}d` },
    { check: `median net PnL % > ${cfg.minMedianPnlPct}`, pass: totals.medianNetPnlPct > cfg.minMedianPnlPct, detail: `${totals.medianNetPnlPct.toFixed(2)}%` },
    { check: `total net PnL USD > ${cfg.minTotalPnlUsd}`, pass: totals.totalNetPnlUsd > cfg.minTotalPnlUsd, detail: `$${totals.totalNetPnlUsd.toFixed(2)}` },
    { check: `p10 net PnL % >= ${cfg.minP10PnlPct}`, pass: totals.p10NetPnlPct >= cfg.minP10PnlPct, detail: `${totals.p10NetPnlPct.toFixed(2)}%` },
    { check: "no positions currently stuck", pass: !hasStuckPositions, detail: hasStuckPositions ? "stuck positions present" : "none" },
  ];
}

export interface TradeDetailHistoryPoint {
  t: number;
  pnl: number;
}

/**
 * Everything section 11.1 says a closed trade stores, laid out per-trade
 * rather than aggregated — the `--trades` report mode. `history` is the
 * trade's full trade_history (preserved past the close; see storage/
 * tradeHistory.ts), already ordered oldest-first.
 */
export interface TradeDetailRecord {
  id: number;
  mode: string;
  mint: string;
  symbol: string | null;
  pairAddress: string | null;
  dexId: string | null;
  tradingDay: string;
  entryTime: number;
  exitTime: number;
  sizeUsd: number;
  costBasis: number;
  tokenAmount: number | null;
  tokenDecimals: number | null;
  proceeds: number;
  netPnlUsd: number;
  netPnlPct: number;
  peakPnl: number;
  exitReason: string;
  timerRestarts: number;
  targetExtensions: number;
  feesUsd: number;
  /** The entry pair snapshot's fields (section 11.1); null when there's no snapshot at all. */
  entryPair: EntryPairFields | null;
  top1Pct: number | null;
  top10Pct: number | null;
  score: number | null;
  scoreComponents: Record<string, number> | null;
  animalFlag: boolean | null;
  /** Round-trip loss % from the sellability check that admitted the entry, and when it ran. Null on trades recorded before this was stored. */
  sellabilityLossPct: number | null;
  sellabilityCheckedAt: number | null;
  /** Stop exits: the triggering poll's pnlPct and the confirmation's (null = no route). Null on other exits and on trades recorded before this was stored. */
  stopPollPnlPct: number | null;
  stopConfirmPnlPct: number | null;
  entryValuationPnlPct: number | null;
  entryQuoteInAmount: string | null;
  entryQuoteOutAmount: string | null;
  exitQuoteInAmount: string | null;
  exitQuoteOutAmount: string | null;
  history: readonly TradeDetailHistoryPoint[];
  /** Live trades only (section 11.1): what the confirmed transactions actually did. */
  live?: {
    mode: string;
    entrySignature: string | null;
    exitSignature: string | null;
    entryUsdcRaw: string | null;
    entryTokensRaw: string | null;
    exitTokensRaw: string | null;
    exitUsdcRaw: string | null;
    entryFeeLamports: number | null;
    exitFeeLamports: number | null;
    entryFeeUsd: number | null;
    exitFeeUsd: number | null;
    rentPaidLamports: number | null;
    rentReclaimedLamports: number | null;
    rentPaidUsd: number | null;
    rentReclaimedUsd: number | null;
    entrySolPriceUsd: number | null;
    exitSolPriceUsd: number | null;
    sellAttempts: number | null;
    failedSellFeesLamports: number | null;
    failedSellFeesUsd: number | null;
    proceedsUnknown: boolean;
  };
}

/** The entry pair snapshot fields section 11.1 lists. Any field the snapshot lacks is null (printed n/a, never 0). */
export interface EntryPairFields {
  priceChangeM5: number | null;
  priceChangeH1: number | null;
  priceChangeH24: number | null;
  volumeM5: number | null;
  volumeH1: number | null;
  buysM5: number | null;
  sellsM5: number | null;
  liquidityUsd: number | null;
  /** Minutes from pairCreatedAt to the entry. */
  pairAgeMin: number | null;
  fdv: number | null;
}

function finiteOrNull(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Reads section 11.1's snapshot fields out of a stored DexScreener pair (defensively: it's stored JSON). */
export function entryPairFields(snapshot: unknown, entryTime: number): EntryPairFields | null {
  if (snapshot === null || typeof snapshot !== "object") return null;
  const p = snapshot as {
    priceChange?: Record<string, unknown>;
    volume?: Record<string, unknown>;
    txns?: { m5?: { buys?: unknown; sells?: unknown } };
    liquidity?: { usd?: unknown };
    pairCreatedAt?: unknown;
    fdv?: unknown;
  };
  const createdAt = finiteOrNull(p.pairCreatedAt);
  return {
    priceChangeM5: finiteOrNull(p.priceChange?.m5),
    priceChangeH1: finiteOrNull(p.priceChange?.h1),
    priceChangeH24: finiteOrNull(p.priceChange?.h24),
    volumeM5: finiteOrNull(p.volume?.m5),
    volumeH1: finiteOrNull(p.volume?.h1),
    buysM5: finiteOrNull(p.txns?.m5?.buys),
    sellsM5: finiteOrNull(p.txns?.m5?.sells),
    liquidityUsd: finiteOrNull(p.liquidity?.usd),
    pairAgeMin: createdAt !== null ? (entryTime - createdAt) / 60_000 : null,
    fdv: finiteOrNull(p.fdv),
  };
}

function scoreComponentsOf(v: unknown): Record<string, number> | null {
  if (v === null || typeof v !== "object") return null;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const n = finiteOrNull(x);
    if (n !== null) out[k] = n;
  }
  return out;
}

/** A stored trade (plus its trade_history) as the `--trades` report prints it. */
export function tradeRowToDetailRecord(t: TradeRow, history: readonly TradeDetailHistoryPoint[]): TradeDetailRecord {
  return {
    id: t.id,
    mode: t.mode,
    mint: t.mint,
    symbol: t.symbol,
    pairAddress: t.pairAddress,
    dexId: t.dexId,
    tradingDay: t.tradingDay,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    sizeUsd: t.sizeUsd,
    costBasis: t.costBasis,
    tokenAmount: t.tokenAmount,
    tokenDecimals: t.tokenDecimals,
    proceeds: t.proceeds,
    netPnlUsd: t.netPnlUsd,
    netPnlPct: t.netPnlPct,
    peakPnl: t.peakPnl,
    exitReason: t.exitReason,
    timerRestarts: t.timerRestarts,
    targetExtensions: t.targetExtensions,
    feesUsd: t.feesUsd,
    entryPair: entryPairFields(t.entryPairSnapshot, t.entryTime),
    top1Pct: t.top1Pct,
    top10Pct: t.top10Pct,
    score: t.score,
    scoreComponents: scoreComponentsOf(t.scoreComponents),
    animalFlag: t.animalFlag,
    sellabilityLossPct: t.sellabilityLossPct,
    sellabilityCheckedAt: t.sellabilityCheckedAt,
    stopPollPnlPct: t.stopPollPnlPct,
    stopConfirmPnlPct: t.stopConfirmPnlPct,
    entryValuationPnlPct: t.entryValuationPnlPct,
    entryQuoteInAmount: t.entryQuoteInAmount,
    entryQuoteOutAmount: t.entryQuoteOutAmount,
    exitQuoteInAmount: t.exitQuoteInAmount,
    exitQuoteOutAmount: t.exitQuoteOutAmount,
    history,
    live: {
      mode: t.mode,
      entrySignature: t.entrySignature,
      exitSignature: t.exitSignature,
      entryUsdcRaw: t.entryUsdcRaw,
      entryTokensRaw: t.entryTokensRaw,
      exitTokensRaw: t.exitTokensRaw,
      exitUsdcRaw: t.exitUsdcRaw,
      entryFeeLamports: t.entryFeeLamports,
      exitFeeLamports: t.exitFeeLamports,
      entryFeeUsd: t.entryFeeUsd,
      exitFeeUsd: t.exitFeeUsd,
      rentPaidLamports: t.rentPaidLamports,
      rentReclaimedLamports: t.rentReclaimedLamports,
      rentPaidUsd: t.rentPaidUsd,
      rentReclaimedUsd: t.rentReclaimedUsd,
      entrySolPriceUsd: t.entrySolPriceUsd,
      exitSolPriceUsd: t.exitSolPriceUsd,
      sellAttempts: t.sellAttempts,
      failedSellFeesLamports: t.failedSellFeesLamports,
      failedSellFeesUsd: t.failedSellFeesUsd,
      proceedsUnknown: t.proceedsUnknown,
    },
  };
}

/** The six score components, in section 6.1's order; any others stored are printed after them. */
const SCORE_COMPONENT_ORDER = ["buyPressure", "activity", "momentum", "depth", "holders", "freshness"];

function fmtNum(v: number | null, digits: number, prefix = "", suffix = ""): string {
  return v === null ? "n/a" : `${prefix}${v.toFixed(digits)}${suffix}`;
}

function fmtEntryPair(p: EntryPairFields | null): string {
  if (p === null) return "n/a (no snapshot stored)";
  return [
    `change m5 ${fmtNum(p.priceChangeM5, 2, "", "%")} h1 ${fmtNum(p.priceChangeH1, 2, "", "%")} h24 ${fmtNum(p.priceChangeH24, 2, "", "%")}`,
    `volume m5 ${fmtNum(p.volumeM5, 2, "$")} h1 ${fmtNum(p.volumeH1, 2, "$")}`,
    `m5 buys ${fmtNum(p.buysM5, 0)} sells ${fmtNum(p.sellsM5, 0)}`,
    `liquidity ${fmtNum(p.liquidityUsd, 2, "$")}`,
    `pair age ${fmtNum(p.pairAgeMin, 1, "", "m")}`,
    `fdv ${fmtNum(p.fdv, 0, "$")}`,
  ].join(" | ");
}

function fmtScore(score: number | null, components: Record<string, number> | null): string {
  const head = fmtNum(score, 4);
  if (components === null) return `${head} (components: n/a)`;
  const names = [...SCORE_COMPONENT_ORDER, ...Object.keys(components).filter((k) => !SCORE_COMPONENT_ORDER.includes(k))];
  return `${head} (${names.map((k) => `${k} ${fmtNum(components[k] ?? null, 4)}`).join(", ")})`;
}

function fmtSellability(lossPct: number | null, checkedAt: number | null, entryTime: number): string {
  if (checkedAt === null) return "not recorded";
  const beforeEntrySec = (entryTime - checkedAt) / 1000;
  return `${fmtNum(lossPct, 2, "", "%")} (checked ${new Date(checkedAt).toISOString()}, ${beforeEntrySec.toFixed(1)}s before entry)`;
}

function fmtStopConfirmation(exitReason: string, pollPnlPct: number | null, confirmPnlPct: number | null): string {
  if (exitReason !== "stop") return "n/a (not a stop exit)";
  if (pollPnlPct === null) return "not recorded";
  const confirm = confirmPnlPct === null ? "no route (treated as confirmed)" : `${confirmPnlPct.toFixed(2)}%`;
  return `triggering poll ${pollPnlPct.toFixed(2)}%, confirmation ${confirm}`;
}

function fmtUsd4(v: number): string {
  return `${v >= 0 ? "" : "-"}$${Math.abs(v).toFixed(4)}`;
}
function fmtPctOrNa(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "n/a";
  return `${v.toFixed(2)}%`;
}
function fmtQuote(inAmount: string | null, outAmount: string | null): string {
  if (inAmount === null && outAmount === null) return "n/a (no successful quote)";
  return `in=${inAmount ?? "n/a"} out=${outAmount ?? "n/a"}`;
}

/** `npm run report -- --trades` / the `--trades` mode: full per-trade detail, not aggregate stats. */
export function formatTradeDetail(trades: readonly TradeDetailRecord[], opts: { historyPoints?: number } = {}): string {
  const historyPoints = opts.historyPoints ?? 5;
  if (trades.length === 0) return "No trades.";

  const lines: string[] = [];
  for (const t of trades) {
    const holdSec = (t.exitTime - t.entryTime) / 1000;
    lines.push(`=== Trade ${t.id}: ${t.symbol ?? t.mint.slice(0, 6)} (${t.mint}) ===`);
    lines.push(`  entry: ${new Date(t.entryTime).toISOString()}  exit: ${new Date(t.exitTime).toISOString()}  hold: ${holdSec.toFixed(1)}s`);
    lines.push(`  size: $${t.sizeUsd.toFixed(2)}  cost basis: $${t.costBasis.toFixed(4)}  proceeds: $${t.proceeds.toFixed(4)}`);
    lines.push(`  mode: ${t.mode}  pair: ${t.pairAddress ?? "n/a"}  dex: ${t.dexId ?? "n/a"}  trading day: ${t.tradingDay}`);
    lines.push(`  net PnL: ${fmtUsd4(t.netPnlUsd)} / ${t.netPnlPct.toFixed(2)}%  peak: ${fmtPctOrNa(t.peakPnl)}  exit reason: ${t.exitReason}`);
    lines.push(`  timer restarts: ${t.timerRestarts}  target extensions: ${t.targetExtensions}  fees (total): ${fmtUsd4(t.feesUsd)}`);
    lines.push(`  stop confirmation: ${fmtStopConfirmation(t.exitReason, t.stopPollPnlPct, t.stopConfirmPnlPct)}`);
    lines.push(`  entry pair: ${fmtEntryPair(t.entryPair)}`);
    lines.push(`  holders: top1 ${fmtNum(t.top1Pct, 2, "", "%")}  top10 ${fmtNum(t.top10Pct, 2, "", "%")}  animal flag: ${t.animalFlag === null ? "n/a" : String(t.animalFlag)}`);
    lines.push(`  score: ${fmtScore(t.score, t.scoreComponents)}`);
    lines.push(`  sellability round-trip loss: ${fmtSellability(t.sellabilityLossPct, t.sellabilityCheckedAt, t.entryTime)}`);
    lines.push(`  tokens received: ${t.tokenAmount ?? "n/a"}  decimals: ${t.tokenDecimals ?? "n/a"}`);
    lines.push(`  entry valuation (first exit-lane quote after fill): ${fmtPctOrNa(t.entryValuationPnlPct)}`);
    lines.push(`  entry quote (raw): ${fmtQuote(t.entryQuoteInAmount, t.entryQuoteOutAmount)}`);
    lines.push(`  exit quote (raw): ${fmtQuote(t.exitQuoteInAmount, t.exitQuoteOutAmount)}`);
    if (t.live && t.live.mode === "live") {
      const l = t.live;
      const n = (v: unknown) => (v === null || v === undefined ? "n/a" : String(v));
      const usd = (v: number | null) => (v === null ? "n/a" : fmtUsd4(v));
      if (l.proceedsUnknown) lines.push("  PROCEEDS UNKNOWN: closed as reconciled (tokens left the wallet without a recorded sell); proceeds recorded as 0");
      lines.push(`  entry tx: ${n(l.entrySignature)}  USDC spent (raw): ${n(l.entryUsdcRaw)}  tokens received (raw): ${n(l.entryTokensRaw)}`);
      lines.push(`  exit tx: ${n(l.exitSignature)}  tokens sold (raw): ${n(l.exitTokensRaw)}  USDC received (raw): ${n(l.exitUsdcRaw)}`);
      lines.push(`  network fees: entry ${n(l.entryFeeLamports)} lamports (${usd(l.entryFeeUsd)}), exit ${n(l.exitFeeLamports)} lamports (${usd(l.exitFeeUsd)})`);
      lines.push(`  rent: paid ${n(l.rentPaidLamports)} lamports (${usd(l.rentPaidUsd)}), reclaimed ${n(l.rentReclaimedLamports)} lamports (${usd(l.rentReclaimedUsd)})`);
      lines.push(`  SOL/USD used: entry ${n(l.entrySolPriceUsd)}, exit ${n(l.exitSolPriceUsd)}  sell attempts: ${n(l.sellAttempts)}  failed sell fees: ${n(l.failedSellFeesLamports)} lamports (${usd(l.failedSellFeesUsd)})`);
    }
    const fmtPoints = (pts: readonly TradeDetailHistoryPoint[]) => pts.map((p) => `(${p.t}, ${p.pnl.toFixed(2)}%)`).join(", ");
    if (t.history.length === 0) {
      lines.push(`  history (first ${historyPoints} of 0): none`);
    } else if (t.history.length <= historyPoints) {
      // The whole history already fits in one line — a separate "last N" line would just repeat it.
      lines.push(`  history (${t.history.length} of ${t.history.length}): ${fmtPoints(t.history)}`);
    } else {
      const first = t.history.slice(0, historyPoints);
      const last = t.history.slice(-historyPoints);
      const between = Math.max(0, t.history.length - first.length - last.length);
      lines.push(`  history, first ${historyPoints} of ${t.history.length}: ${fmtPoints(first)}`);
      lines.push(`  history, last ${historyPoints} of ${t.history.length}${between > 0 ? ` (${between} more in between)` : ""}: ${fmtPoints(last)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
