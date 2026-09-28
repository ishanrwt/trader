import { computeTotals, type TotalsResult, type TradeRecord } from "../report/index.js";
import { mean, pearsonCorrelation } from "../report/stats.js";
import type { MintFeaturesRow } from "../storage/mintFeatures.js";
import type { PricePathPoint, PricePathRow } from "../storage/pricePaths.js";
import type { ReplayVariant } from "./config.js";
import { applyFilters } from "./filters.js";
import { pathCompleteness, simulatePath, type Completeness, type ReplayTrade } from "./simulate.js";

export interface ReplayPath {
  path: PricePathRow;
  points: PricePathPoint[];
  features: MintFeaturesRow | undefined;
}

export interface ReplayedTrade extends ReplayTrade {
  pathId: number;
  mint: string;
  selected: boolean;
  incomplete: boolean;
}

export interface VariantResult {
  name: string;
  trades: ReplayedTrade[];
  considered: number;
  stillRecording: number;
  excludedIncomplete: number;
  includedIncomplete: number;
  /** Filter drop counts by reason (`null:<filter>` = feature missing). */
  dropped: Record<string, number>;
  noEntryPoint: number;
  missingFeatures: number;
  /** Selected paths dropped by the filters, and unselected ones they kept. */
  selectedDropped: number;
  unselectedKept: number;
}

export function completenessFor(p: ReplayPath, v: ReplayVariant): Completeness {
  return pathCompleteness(p.path, p.points, v.params);
}

/** Replays every finished path through one variant's filters and exit config. */
export function runVariant(v: ReplayVariant, paths: readonly ReplayPath[], opts: { includeIncomplete?: boolean } = {}): VariantResult {
  const r: VariantResult = {
    name: v.name,
    trades: [],
    considered: 0,
    stillRecording: 0,
    excludedIncomplete: 0,
    includedIncomplete: 0,
    dropped: {},
    noEntryPoint: 0,
    missingFeatures: 0,
    selectedDropped: 0,
    unselectedKept: 0,
  };
  for (const p of paths) {
    if (p.path.status !== "done") {
      r.stillRecording++;
      continue;
    }
    r.considered++;
    if (!p.features) r.missingFeatures++;
    const c = completenessFor(p, v);
    if (!c.complete) {
      if (!opts.includeIncomplete) {
        r.excludedIncomplete++;
        continue;
      }
      r.includedIncomplete++;
    }
    const f = applyFilters(v.filters, p.path, p.features, p.points);
    if (!f.pass) {
      r.dropped[f.reason] = (r.dropped[f.reason] ?? 0) + 1;
      if (p.path.selected) r.selectedDropped++;
      continue;
    }
    if (!p.path.selected) r.unselectedKept++;
    const t = simulatePath(p.points, v.params, { entryAt: f.entryAt });
    if (!t) {
      r.noEntryPoint++;
      continue;
    }
    r.trades.push({ ...t, pathId: p.path.id, mint: p.path.mint, selected: p.path.selected, incomplete: !c.complete });
  }
  return r;
}

function asTradeRecord(t: ReplayTrade): TradeRecord {
  return {
    mode: "paper",
    exitTime: t.exitTime,
    tradingDay: "",
    exitReason: t.exitReason,
    netPnlUsd: t.netPnlUsd,
    netPnlPct: t.netPnlPct,
    m5ChangePct: null,
    h1ChangePct: null,
    buyPressurePct: null,
    liquidityUsd: null,
    pairAgeMs: null,
    top10Pct: null,
    score: null,
    scoreComponents: null,
  };
}

export interface SplitStats {
  selected: TotalsResult;
  unselected: TotalsResult;
  all: TotalsResult;
  reasons: { selected: Record<string, number>; unselected: Record<string, number>; all: Record<string, number> };
}

/** The report's own totals (section 11.4), split by whether a real position opened for the mint. */
export function splitStats(trades: readonly ReplayedTrade[]): SplitStats {
  const sel = trades.filter((t) => t.selected);
  const uns = trades.filter((t) => !t.selected);
  const reasons = (ts: readonly ReplayedTrade[]) => {
    const out: Record<string, number> = {};
    for (const t of ts) out[t.exitReason] = (out[t.exitReason] ?? 0) + 1;
    return out;
  };
  return {
    selected: computeTotals(sel.map(asTradeRecord)),
    unselected: computeTotals(uns.map(asTradeRecord)),
    all: computeTotals(trades.map(asTradeRecord)),
    reasons: { selected: reasons(sel), unselected: reasons(uns), all: reasons(trades) },
  };
}

const n2 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(2);
const pad = (s: string, w: number) => s.padStart(w);

function statsBlock(label: string, t: TotalsResult, reasons: Record<string, number>): string[] {
  if (t.trades === 0) return [`  ${label}: no trades`];
  const reasonText = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return [
    `  ${label}: ${t.trades} trades, win rate ${(t.winRate * 100).toFixed(1)}%`,
    `    net %   median ${pad(n2(t.medianNetPnlPct), 7)}  mean ${pad(n2(t.meanNetPnlPct), 7)}  p10 ${pad(n2(t.p10NetPnlPct), 7)}  p90 ${pad(n2(t.p90NetPnlPct), 7)}`,
    `    net USD total ${n2(t.totalNetPnlUsd)}  max drawdown ${t.maxDrawdownUsd.toFixed(2)}`,
    `    exits   ${reasonText}`,
  ];
}

export function formatVariant(r: VariantResult, baseline?: VariantResult): string {
  const s = splitStats(r.trades);
  const drops = Object.entries(r.dropped)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const lines = [
    `=== ${r.name} ===`,
    `  finished paths ${r.considered} (still recording ${r.stillRecording}, not replayed); ` +
      (r.includedIncomplete > 0 ? `incomplete included and flagged ${r.includedIncomplete}` : `incomplete excluded ${r.excludedIncomplete}`) +
      `; no mint_features row ${r.missingFeatures}`,
    `  dropped by filters: ${drops || "none"}${r.noEntryPoint > 0 ? `; no priced entry point ${r.noEntryPoint}` : ""}`,
    `  vs what paper bought: dropped ${r.selectedDropped} selected mint(s), kept ${r.unselectedKept} unselected mint(s)`,
    ...statsBlock("selected mints", s.selected, s.reasons.selected),
    ...statsBlock("unselected mints", s.unselected, s.reasons.unselected),
    ...statsBlock("all", s.all, s.reasons.all),
  ];
  if (r.includedIncomplete > 0) {
    const inc = r.trades.filter((t) => t.incomplete);
    lines.push(`  of which from INCOMPLETE paths: ${inc.length} (path ids ${inc.map((t) => t.pathId).join(", ")})`);
  }
  if (baseline && baseline !== r) {
    const b = splitStats(baseline.trades).all;
    lines.push(`  vs baseline: trades ${s.all.trades - b.trades >= 0 ? "+" : ""}${s.all.trades - b.trades}, total net USD ${n2(s.all.totalNetPnlUsd - b.totalNetPnlUsd)}, median % ${n2(s.all.medianNetPnlPct - b.medianNetPnlPct)}`);
  }
  return lines.join("\n");
}

// ---- Cross-check against real paper trades ----

export interface RealTrade {
  id: number;
  mint: string;
  mode: string;
  entryTime: number;
  exitTime: number;
  sizeUsd: number;
  costBasis: number;
  netPnlPct: number;
  exitReason: string;
  /** Lowest pnlPct in the trade's own history (trade_history), if any. */
  minHistoryPnlPct?: number | null;
}

export interface CrossCheckRow {
  trade: RealTrade;
  replay: ReplayTrade | null;
  deltaPct: number | null;
  flagged: boolean;
  cause: string | null;
}

/**
 * Replays each real trade whose entry a finished path covers, from the first
 * point at or after its real entry time, with its real size and cost basis.
 */
export function crossCheck(
  baseline: ReplayVariant,
  trades: readonly RealTrade[],
  paths: readonly ReplayPath[],
  tolerancePp: number,
): { rows: CrossCheckRow[]; notCovered: number } {
  const byKey = new Map(paths.map((p) => [`${p.path.mint}|${p.path.mode}`, p]));
  const rows: CrossCheckRow[] = [];
  let notCovered = 0;
  for (const t of trades) {
    const p = byKey.get(`${t.mint}|${t.mode}`);
    if (!p || p.path.status !== "done" || t.entryTime < p.path.startedAt || t.entryTime >= p.path.endsAt) {
      notCovered++;
      continue;
    }
    // The trade's entry time is already after its fill latency.
    const replay = simulatePath(p.points, baseline.params, { entryAt: t.entryTime, skipEntryLatency: true, sizeUsd: t.sizeUsd, costBasis: t.costBasis });
    if (!replay) {
      rows.push({ trade: t, replay: null, deltaPct: null, flagged: true, cause: "no priced path point after entry" });
      continue;
    }
    const deltaPct = replay.netPnlPct - t.netPnlPct;
    const flagged = replay.exitReason !== t.exitReason || Math.abs(deltaPct) > tolerancePp;
    let cause: string | null = null;
    if (flagged) {
      const incomplete = !pathCompleteness(p.path, p.points, baseline.params).complete;
      const lastT = p.points.at(-1)?.t ?? p.path.startedAt;
      if (incomplete) cause = "path incomplete (collector down)";
      else if (t.exitTime > lastT) cause = "real trade outlived the 60-min path";
      else if (replay.exitReason === "stop" && t.exitReason !== "stop") {
        const min = t.minHistoryPnlPct;
        cause =
          min !== undefined && min !== null && min > -baseline.params.exit.stopLossPct
            ? `DexScreener mark hit the stop; paper's quotes never did (low ${min.toFixed(1)}%)`
            : "replay stopped, paper didn't (paper's confirmation quote may have rejected it)";
      }
      else if (t.exitReason === "no_route" || replay.exitReason === "no_route") cause = "route availability differs (Jupiter vs DexScreener pair)";
      else cause = "Jupiter quote vs DexScreener constant-product model";
    }
    rows.push({ trade: t, replay, deltaPct, flagged, cause });
  }
  return { rows, notCovered };
}

export interface DriftSummary {
  pairs: number;
  meanSignedDiffPct: number;
  meanAbsDiffPct: number;
  correlation: number;
}

export function driftSummary(rows: readonly CrossCheckRow[]): DriftSummary {
  const ok = rows.filter((r) => r.replay !== null);
  return {
    pairs: ok.length,
    meanSignedDiffPct: mean(ok.map((r) => r.deltaPct!)),
    meanAbsDiffPct: mean(ok.map((r) => Math.abs(r.deltaPct!))),
    correlation: pearsonCorrelation(
      ok.map((r) => r.replay!.netPnlPct),
      ok.map((r) => r.trade.netPnlPct),
    ),
  };
}

/** The shadow-vs-actual figures from the last full report run, as given when this tool was built. */
export const REFERENCE_SHADOW_DRIFT = { meanSignedDiffPct: -1.5, meanAbsDiffPct: 19.4, source: "last full report" };

/**
 * "Wildly different" from the shadow method's own drift: mean |diff| outside
 * half to double the shadow figure, or mean signed diff more than 10pp apart.
 */
export function driftWarning(replay: DriftSummary, shadow: { meanSignedDiffPct: number; meanAbsDiffPct: number }): string | null {
  if (replay.pairs === 0) return null;
  const absRatio = shadow.meanAbsDiffPct > 0 ? replay.meanAbsDiffPct / shadow.meanAbsDiffPct : Infinity;
  if (absRatio < 0.5 || absRatio > 2 || Math.abs(replay.meanSignedDiffPct - shadow.meanSignedDiffPct) > 10) {
    return "WARNING: the replay's drift from real trades is far from the shadow method's. Check the model before trusting variant comparisons.";
  }
  return null;
}

export function formatCrossCheck(
  result: { rows: CrossCheckRow[]; notCovered: number },
  tolerancePp: number,
  shadowNow: DriftSummary | null,
  fmtTime: (ms: number) => string,
): string {
  const lines = [`=== cross-check: baseline replay vs real paper trades (tolerance ${tolerancePp}pp, or a different exit reason) ===`];
  const flagged = result.rows.filter((r) => r.flagged);
  lines.push(`  trades covered by a finished path: ${result.rows.length}; not covered: ${result.notCovered}`);
  lines.push(`  reproduced: ${result.rows.length - flagged.length}; flagged: ${flagged.length}`);
  const sameReason = result.rows.filter((r) => r.replay && r.replay.exitReason === r.trade.exitReason).length;
  lines.push(`  same exit reason: ${sameReason}/${result.rows.length}`);
  if (flagged.length > 0) {
    lines.push("", "  trade  entry        real reason   real %    replay reason  replay %   delta    likely cause");
    for (const r of flagged) {
      lines.push(
        `  ${String(r.trade.id).padStart(5)}  ${fmtTime(r.trade.entryTime)}  ${r.trade.exitReason.padEnd(12)} ${pad(n2(r.trade.netPnlPct), 7)}   ${(r.replay?.exitReason ?? "-").padEnd(13)} ${pad(r.replay ? n2(r.replay.netPnlPct) : "-", 8)}  ${pad(r.deltaPct === null ? "-" : n2(r.deltaPct), 7)}  ${r.cause}`,
      );
    }
    const causes: Record<string, number> = {};
    for (const r of flagged) {
      const key = r.cause!.replace(/ \(low [^)]*\)$/, "");
      causes[key] = (causes[key] ?? 0) + 1;
    }
    lines.push("", "  flagged by likely cause: " + Object.entries(causes).map(([k, v]) => `${k} ${v}`).join("; "));
  }
  const d = driftSummary(result.rows);
  lines.push(
    "",
    "  model drift (replay/shadow − actual, net %):   pairs   mean signed   mean |diff|   correlation",
    `    replay baseline (this cross-check)          ${pad(String(d.pairs), 5)}   ${pad(n2(d.meanSignedDiffPct) + "pp", 11)}   ${pad(d.meanAbsDiffPct.toFixed(1) + "pp", 11)}   ${pad(d.correlation.toFixed(2), 11)}`,
  );
  if (shadowNow) {
    lines.push(
      `    shadows vs actual (report, current DB)      ${pad(String(shadowNow.pairs), 5)}   ${pad(n2(shadowNow.meanSignedDiffPct) + "pp", 11)}   ${pad(shadowNow.meanAbsDiffPct.toFixed(1) + "pp", 11)}   ${pad(shadowNow.correlation.toFixed(2), 11)}`,
    );
  }
  lines.push(
    `    shadows vs actual (${REFERENCE_SHADOW_DRIFT.source})              -   ${pad(n2(REFERENCE_SHADOW_DRIFT.meanSignedDiffPct) + "pp", 11)}   ${pad(REFERENCE_SHADOW_DRIFT.meanAbsDiffPct.toFixed(1) + "pp", 11)}             -`,
  );
  const warn = driftWarning(d, shadowNow ?? REFERENCE_SHADOW_DRIFT);
  lines.push(warn ? `  ${warn}` : "  The replay's drift is in the same range as the shadow method's.");
  return lines.join("\n");
}
