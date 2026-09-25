import type { GateCheckId } from "../gate/index.js";
import { formatDurationMs } from "../time.js";

export interface ClosedTradeSummary {
  symbol: string;
  exitReason: string;
  netPnlPct: number;
  netPnlUsd: number;
}

export interface OpenPositionSummary {
  symbol: string;
  timeHeldMs: number;
  pnlPct: number;
  currentTarget: number;
  deadline: number;
}

export interface TradingDaySummary {
  trades: number;
  winRate: number;
  medianNetPnlPct: number;
  meanNetPnlPct: number;
  totalNetPnlUsd: number;
  biggestWinUsd: number | null;
  biggestLossUsd: number | null;
  exitReasonBreakdown: Record<string, number>;
}

export interface DigestInput {
  mode: "PAPER" | "LIVE";
  now: number;
  startedAt: number;
  paused: boolean;
  pauseReason?: string;
  killed: boolean;
  dailyLossHalted: boolean;
  errorHalted: boolean;
  lossStreak: number;
  solPriceUsd: number | null;
  walletUsdc: number;
  walletSol: number;
  tradesClosed: ClosedTradeSummary[];
  openPositions: OpenPositionSummary[];
  tradingDay: TradingDaySummary;
  funnel: {
    /** Since the previous digest. */
    discovered: number;
    /** Mints that crossed MIN_LIQUIDITY_USD (firstEligibleAt set) since the previous digest. */
    eligible: number;
    /** Mints that reached READY (all 8 checks) since the previous digest. */
    ready: number;
    /** Positions opened since the previous digest. */
    entered: number;
    pendingNow: number;
    /** Unique mints per skip reason since the previous digest, not the number of evaluations. */
    skipReasons: Partial<Record<GateCheckId, number>>;
    skippedSlotsFullCount: number;
    scoreRangeOfEntries: { min: number; max: number } | null;
  };
  risk: {
    dailyLossUsd: number;
    dailyLossCapUsd: number;
  };
  health: {
    dexScreenerErrors: number;
    rpcErrors: number;
    jupiterRequestsPerMinAvg: number;
    jupiterRequestsPerMinPeak: number;
    jupiter429s: number;
    deferredEntryChecks: number;
    downtimeGaps: Array<{ from: number; to: number }>;
  };
  /** Section 16.5: reconciled closes with unknown proceeds, listed separately (not in the trading-day stats). */
  proceedsUnknownTrades?: ClosedTradeSummary[];
  /** Live mode only (section 10). */
  live?: LiveDigestSection;
}

export interface LiveDigestSection {
  sellFeeReserveSol: number;
  closingPositions: Array<{ symbol: string; stuckState: string | null; sellAttempts: number; sellFeesLamports: number }>;
  feeLossesToday: { count: number; usd: number };
  rpcRequests: number;
  tx: { sent: number; landed: number; failed: number; expired: number; refused: number };
  unknownTokens: string[];
  emptyTokenAccounts: number;
}

function topSkipReasons(skipReasons: Partial<Record<GateCheckId, number>>, limit = 3): string {
  const entries = Object.entries(skipReasons).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  if (entries.length === 0) return "none";
  return entries
    .slice(0, limit)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");
}

function fmtPct(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
}
function fmtUsd(x: number): string {
  return x >= 0 ? `+$${x.toFixed(2)}` : `-$${Math.abs(x).toFixed(2)}`;
}

/** SPEC.md section 10: the full digest, sent every DIGEST_INTERVAL_MINUTES (it doubles as a heartbeat). */
export function buildDigest(input: DigestInput): string {
  const lines: string[] = [];

  lines.push(`=== Trader digest (${input.mode}) ===`);
  lines.push(`Uptime: ${formatDurationMs(input.now - input.startedAt)}`);
  lines.push(`Wallet: $${input.walletUsdc.toFixed(2)} USDC, ${input.walletSol.toFixed(4)} SOL`);
  if (input.live) lines.push(`SELL_FEE_RESERVE_SOL: ${input.live.sellFeeReserveSol.toFixed(6)} SOL`);
  if (input.solPriceUsd !== null) lines.push(`SOL/USD: $${input.solPriceUsd.toFixed(2)}`);
  lines.push("");

  lines.push("Trades closed this window:");
  if (input.tradesClosed.length === 0) {
    lines.push("  none");
  } else {
    for (const t of input.tradesClosed) {
      lines.push(`  ${t.symbol}: ${t.exitReason}, ${fmtPct(t.netPnlPct)} (${fmtUsd(t.netPnlUsd)})`);
    }
  }
  if (input.proceedsUnknownTrades && input.proceedsUnknownTrades.length > 0) {
    lines.push("Closed with proceeds unknown (reconciled; the loss may not be real):");
    for (const t of input.proceedsUnknownTrades) lines.push(`  ${t.symbol}: recorded ${fmtUsd(t.netPnlUsd)}`);
  }
  lines.push("");

  lines.push("Open positions:");
  if (input.openPositions.length === 0) {
    lines.push("  none");
  } else {
    for (const p of input.openPositions) {
      const deadlineIn = formatDurationMs(Math.max(0, p.deadline - input.now));
      lines.push(
        `  ${p.symbol}: held ${formatDurationMs(p.timeHeldMs)}, pnl ${fmtPct(p.pnlPct)}, target ${p.currentTarget.toFixed(1)}%, deadline in ${deadlineIn}`,
      );
    }
  }
  if (input.live && input.live.closingPositions.length > 0) {
    lines.push("Closing / stuck positions:");
    for (const p of input.live.closingPositions) {
      lines.push(`  ${p.symbol}: ${p.stuckState ?? "closing"}, sell attempts ${p.sellAttempts}, fees spent ${(p.sellFeesLamports / 1e9).toFixed(6)} SOL`);
    }
  }
  lines.push("");

  lines.push("Trading day so far:");
  lines.push(
    `  trades: ${input.tradingDay.trades}, win rate: ${(input.tradingDay.winRate * 100).toFixed(1)}%, ` +
      `median ${fmtPct(input.tradingDay.medianNetPnlPct)}, mean ${fmtPct(input.tradingDay.meanNetPnlPct)}, total ${fmtUsd(input.tradingDay.totalNetPnlUsd)}`,
  );
  if (input.tradingDay.biggestWinUsd !== null || input.tradingDay.biggestLossUsd !== null) {
    lines.push(
      `  biggest win: ${input.tradingDay.biggestWinUsd !== null ? fmtUsd(input.tradingDay.biggestWinUsd) : "n/a"}, ` +
        `biggest loss: ${input.tradingDay.biggestLossUsd !== null ? fmtUsd(input.tradingDay.biggestLossUsd) : "n/a"}`,
    );
  }
  const exitBreakdown = Object.entries(input.tradingDay.exitReasonBreakdown);
  lines.push(`  exit reasons: ${exitBreakdown.length > 0 ? exitBreakdown.map(([r, c]) => `${r}=${c}`).join(", ") : "none"}`);
  if (input.live) lines.push(`  fee losses from failed transactions: ${input.live.feeLossesToday.count}, ${fmtUsd(-input.live.feeLossesToday.usd)}`);
  lines.push("");

  lines.push("Funnel:");
  lines.push(`  discovered: ${input.funnel.discovered}`);
  lines.push(`  eligible: ${input.funnel.eligible}`);
  lines.push(`  READY: ${input.funnel.ready}`);
  lines.push(`  entered: ${input.funnel.entered}`);
  lines.push(`  pending now: ${input.funnel.pendingNow}`);
  lines.push(`  top skip reasons: ${topSkipReasons(input.funnel.skipReasons)}`);
  lines.push(`  skipped (slots full): ${input.funnel.skippedSlotsFullCount}`);
  lines.push(
    `  score range of entries: ${input.funnel.scoreRangeOfEntries ? `${input.funnel.scoreRangeOfEntries.min.toFixed(2)}-${input.funnel.scoreRangeOfEntries.max.toFixed(2)}` : "n/a"}`,
  );
  lines.push("");

  lines.push("Risk:");
  lines.push(`  paused: ${input.paused}${input.pauseReason ? ` (${input.pauseReason})` : ""}`);
  lines.push(`  killed: ${input.killed}`);
  lines.push(`  daily loss halt: ${input.dailyLossHalted}`);
  lines.push(`  error halt: ${input.errorHalted}`);
  lines.push(`  daily loss: ${fmtUsd(-Math.abs(input.risk.dailyLossUsd))} vs -$${input.risk.dailyLossCapUsd.toFixed(2)} cap`);
  lines.push(`  loss streak: ${input.lossStreak}`);
  lines.push("");

  lines.push("Health:");
  lines.push(`  DexScreener errors: ${input.health.dexScreenerErrors}`);
  lines.push(`  RPC errors: ${input.health.rpcErrors}`);
  lines.push(
    `  Jupiter req/min: avg ${input.health.jupiterRequestsPerMinAvg.toFixed(1)}, ` +
      `peak ${input.health.jupiterRequestsPerMinPeak}, 429s: ${input.health.jupiter429s}`,
  );
  lines.push(`  Deferred entry checks: ${input.health.deferredEntryChecks}`);
  if (input.live) {
    const tx = input.live.tx;
    lines.push(`  RPC requests this window: ${input.live.rpcRequests}`);
    lines.push(`  Transactions: sent ${tx.sent}, landed ${tx.landed}, failed ${tx.failed}, expired ${tx.expired}; verification refusals ${tx.refused}`);
  }
  if (input.health.downtimeGaps.length > 0) {
    const gaps = input.health.downtimeGaps.map((g) => formatDurationMs(g.to - g.from)).join(", ");
    lines.push(`  Downtime gaps this period: ${gaps}`);
  }

  if (input.live) {
    lines.push("");
    lines.push("Wallet reconciliation:");
    lines.push(`  unknown tokens (never traded automatically): ${input.live.unknownTokens.length > 0 ? input.live.unknownTokens.join(", ") : "none"}`);
    lines.push(`  empty token accounts left open: ${input.live.emptyTokenAccounts}`);
  }

  return lines.join("\n");
}
