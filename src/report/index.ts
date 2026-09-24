import { equalSizeBuckets, maxDrawdown, mean, median, pearsonCorrelation, percentile } from "./stats.js";

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
}

/** SPEC.md section 11.4: totals. A win is net PnL USD > 0 (section 11.1). */
export function computeTotals(trades: readonly TradeRecord[]): TotalsResult {
  const pnlUsd = trades.map((t) => t.netPnlUsd);
  const pnlPct = trades.map((t) => t.netPnlPct);
  const wins = trades.filter((t) => t.netPnlUsd > 0);
  const losses = trades.filter((t) => t.netPnlUsd <= 0);
  const chronological = [...trades].sort((a, b) => a.exitTime - b.exitTime).map((t) => t.netPnlUsd);

  return {
    trades: trades.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    medianNetPnlPct: median(pnlPct),
    meanNetPnlPct: mean(pnlPct),
    medianNetPnlUsd: median(pnlUsd),
    meanNetPnlUsd: mean(pnlUsd),
    p10NetPnlPct: percentile(pnlPct, 10),
    p90NetPnlPct: percentile(pnlPct, 90),
    avgWinUsd: wins.length > 0 ? mean(wins.map((t) => t.netPnlUsd)) : 0,
    avgLossUsd: losses.length > 0 ? mean(losses.map((t) => t.netPnlUsd)) : 0,
    totalNetPnlUsd: pnlUsd.reduce((a, b) => a + b, 0),
    maxDrawdownUsd: maxDrawdown(chronological),
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
}

/** SPEC.md section 11.4: results by entry-feature (or score) quantile buckets, earliest/lowest bucket first. */
export function quantileBuckets(trades: readonly TradeRecord[], keyFn: (t: TradeRecord) => number | null, buckets: number): QuantileBucketResult[] {
  const withKey = trades.filter((t) => keyFn(t) !== null).sort((a, b) => keyFn(a)! - keyFn(b)!);
  return equalSizeBuckets(withKey, buckets).map((group, i) => ({ bucket: i + 1, count: group.length, totals: computeTotals(group) }));
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

export interface ShadowRecord {
  outcome: "open" | "selected" | "unsellable" | "closed";
  netPnlUsd: number | null;
  netPnlPct: number | null;
}

export interface ShadowComparisonResult {
  selected: TotalsResult;
  unselected: TotalsResult;
}

/** SPEC.md section 11.4: shadows, selected vs unselected. Excludes "unsellable" (per section 11.2) and still-open shadows. */
export function compareShadowsSelectedVsUnselected(shadows: readonly ShadowRecord[]): ShadowComparisonResult {
  const closed = shadows.filter((s) => s.outcome === "selected" || s.outcome === "closed").filter((s) => s.netPnlUsd !== null);
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
    selected: computeTotals(asTrades(closed.filter((s) => s.outcome === "selected"))),
    unselected: computeTotals(asTrades(closed.filter((s) => s.outcome === "closed"))),
  };
}

export interface ShadowVsActualPair {
  shadowNetPnlPct: number;
  actualNetPnlPct: number;
}

export interface ShadowVsActualResult {
  pairs: number;
  meanAbsDiffPct: number;
  correlation: number;
}

/** SPEC.md section 11.4: how closely the shadow method matches real quotes, for selected mints. */
export function compareShadowVsActual(pairs: readonly ShadowVsActualPair[]): ShadowVsActualResult {
  if (pairs.length === 0) return { pairs: 0, meanAbsDiffPct: 0, correlation: 0 };
  const diffs = pairs.map((p) => Math.abs(p.shadowNetPnlPct - p.actualNetPnlPct));
  return {
    pairs: pairs.length,
    meanAbsDiffPct: mean(diffs),
    correlation: pearsonCorrelation(
      pairs.map((p) => p.shadowNetPnlPct),
      pairs.map((p) => p.actualNetPnlPct),
    ),
  };
}

export interface ExitedTooEarlyInput {
  exitPriceUsd: number;
  price15mUsd: number | null;
  price60mUsd: number | null;
}

export interface ExitedTooEarlyResult {
  shareTooEarly: number;
  medianUpsidePctMissed: number;
}

/** SPEC.md section 11.4: share of trades whose post-exit price at +15/+60 exceeded the exit price, and by how much. */
export function exitedTooEarly(rows: readonly ExitedTooEarlyInput[]): ExitedTooEarlyResult {
  const withData = rows.filter((r) => r.price15mUsd !== null || r.price60mUsd !== null);
  if (withData.length === 0) return { shareTooEarly: 0, medianUpsidePctMissed: 0 };
  const upsides = withData.map((r) => {
    const best = Math.max(r.price15mUsd ?? -Infinity, r.price60mUsd ?? -Infinity);
    return ((best - r.exitPriceUsd) / r.exitPriceUsd) * 100;
  });
  const tooEarly = upsides.filter((u) => u > 0);
  return {
    shareTooEarly: tooEarly.length / withData.length,
    medianUpsidePctMissed: median(tooEarly.length > 0 ? tooEarly : [0]),
  };
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
  median15mPctChange: number;
  median60mPctChange: number;
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
    median15mPctChange: median(rs.map((r) => pctChange(r.priceAtSkipUsd, r.price15mUsd)).filter((v): v is number => v !== null)),
    median60mPctChange: median(rs.map((r) => pctChange(r.priceAtSkipUsd, r.price60mUsd)).filter((v): v is number => v !== null)),
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
}): string {
  const totals = computeTotals(input.trades);
  const byReason = breakdownByExitReason(input.trades);
  const byDay = breakdownByTradingDay(input.trades);
  const scoreQuintiles = quantileBuckets(input.trades, (t) => t.score, 5);
  const correlations = scoreComponentCorrelations(input.trades);
  const skipStats = skipReasonStats(input.skipTracks);
  const checklist = goLiveChecklist(input.paperTrades, input.hasStuckPositions, input.goLiveConfig);

  const lines: string[] = [];
  lines.push(`=== Report (${input.trades.length} trades) ===`);
  lines.push(
    `Win rate ${(totals.winRate * 100).toFixed(1)}%, median ${totals.medianNetPnlPct.toFixed(1)}%, total $${totals.totalNetPnlUsd.toFixed(2)}, max drawdown $${totals.maxDrawdownUsd.toFixed(2)}`,
  );
  lines.push(`By exit reason: ${Object.entries(byReason).map(([r, t]) => `${r}=${t.trades}`).join(", ") || "none"}`);
  lines.push(`Trading days: ${Object.keys(byDay).length}`);
  lines.push(`Score quintiles (trades/win rate): ${scoreQuintiles.map((b) => `${b.count}/${(b.totals.winRate * 100).toFixed(0)}%`).join(", ") || "none"}`);
  lines.push(
    `Component correlations: buyPressure=${correlations.buyPressure.toFixed(2)}, activity=${correlations.activity.toFixed(2)}, ` +
      `momentum=${correlations.momentum.toFixed(2)}, depth=${correlations.depth.toFixed(2)}, holders=${correlations.holders.toFixed(2)}, freshness=${correlations.freshness.toFixed(2)}`,
  );
  lines.push(
    `Skip reasons: ${skipStats.map((s) => `${s.reason}(n=${s.count}, +15m=${s.median15mPctChange.toFixed(1)}%, +60m=${s.median60mPctChange.toFixed(1)}%)`).join(", ") || "none"}`,
  );
  lines.push("Go-live checklist:");
  for (const item of checklist) lines.push(`  [${item.pass ? "PASS" : "FAIL"}] ${item.check} (${item.detail})`);
  return lines.join("\n");
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
