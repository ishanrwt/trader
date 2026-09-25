import { equalSizeBuckets, maxDrawdown, mean, median, pearsonCorrelation, percentile } from "./stats.js";
import type { TradeRow } from "../storage/trades.js";

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
}): string {
  const totals = computeTotals(input.trades, input.feeLosses ?? []);
  const byReason = breakdownByExitReason(input.trades);
  const byDay = breakdownByTradingDay(input.trades);
  const scoreQuintiles = quantileBuckets(input.trades, (t) => t.score, 5);
  const correlations = scoreComponentCorrelations(input.trades.filter((t) => !t.proceedsUnknown));
  const skipStats = skipReasonStats(input.skipTracks);
  const checklist = goLiveChecklist(input.paperTrades, input.hasStuckPositions, input.goLiveConfig);

  const lines: string[] = [];
  if (input.modeLabel) lines.push(`##### ${input.modeLabel} #####`);
  lines.push(`=== Report (${input.trades.length} trades) ===`);
  if (input.modeLabel && input.trades.length === 0) lines.push(`No ${input.modeLabel.toLowerCase()} trades in this period.`);
  lines.push(
    `Win rate ${(totals.winRate * 100).toFixed(1)}%, median ${totals.medianNetPnlPct.toFixed(1)}%, total $${totals.totalNetPnlUsd.toFixed(2)}, max drawdown $${totals.maxDrawdownUsd.toFixed(2)}`,
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
  lines.push(`Trading days: ${Object.keys(byDay).length}`);
  lines.push(`Score quintiles (trades/win rate): ${scoreQuintiles.map((b) => `${b.count}/${(b.totals.winRate * 100).toFixed(0)}%`).join(", ") || "none"}`);
  lines.push(
    `Component correlations: buyPressure=${correlations.buyPressure.toFixed(2)}, activity=${correlations.activity.toFixed(2)}, ` +
      `momentum=${correlations.momentum.toFixed(2)}, depth=${correlations.depth.toFixed(2)}, holders=${correlations.holders.toFixed(2)}, freshness=${correlations.freshness.toFixed(2)}`,
  );
  const fmtSkipPct = (v: number | null): string => (v === null ? "n/a" : `${v.toFixed(1)}%`);
  lines.push(
    `Skip reasons: ${skipStats.map((s) => `${s.reason}(n=${s.count}, +15m=${fmtSkipPct(s.median15mPctChange)}, +60m=${fmtSkipPct(s.median60mPctChange)})`).join(", ") || "none"}`,
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
