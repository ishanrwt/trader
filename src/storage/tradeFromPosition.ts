import { finalPeakPnl } from "../monitor/stateMachine.js";
import type { PositionRow } from "./positions.js";
import type { NewTradeRow, TradeLiveFields } from "./trades.js";

export interface TradeFromPositionInput {
  row: PositionRow;
  proceeds: number;
  exitReason: string;
  exitTime: number;
  tradingDay: string;
  exitQuote: { exitQuoteInAmount: string | null; exitQuoteOutAmount: string | null };
  /** Fees when the caller doesn't pass its own (paper: PAPER_FEE_USD_PER_TX per side). */
  defaultFeesUsd: number;
  extras?: { feesUsd?: number; proceedsUnknown?: boolean; tradeLive?: Partial<TradeLiveFields> };
}

/**
 * The trade row recorded when a position closes (SPEC.md section 11.1): what
 * finalizeTrade in src/index.ts inserts. Pure, so every field copied from the
 * position can be tested without running the app.
 */
export function tradeFromPosition(i: TradeFromPositionInput): NewTradeRow {
  const { row, proceeds, extras = {} } = i;
  const netPnlUsd = proceeds - row.costBasis;
  const netPnlPct = (netPnlUsd / row.costBasis) * 100;
  const holders = row.holdersResult as { top1Pct?: number; top10Pct?: number } | null;
  return {
    mode: row.mode,
    mint: row.mint,
    symbol: row.symbol,
    pairAddress: row.pairAddress,
    entryTime: row.entryTime,
    exitTime: i.exitTime,
    sizeUsd: row.sizeUsd,
    costBasis: row.costBasis,
    proceeds,
    netPnlUsd,
    netPnlPct,
    exitReason: i.exitReason,
    peakPnl: finalPeakPnl(row.peakPnl, netPnlPct),
    timerRestarts: row.timerRestarts,
    targetExtensions: row.targetExtensions,
    feesUsd: extras.feesUsd ?? i.defaultFeesUsd,
    entryPairSnapshot: row.entryPairSnapshot,
    top1Pct: holders?.top1Pct ?? null,
    top10Pct: holders?.top10Pct ?? null,
    score: row.score,
    scoreComponents: row.scoreComponents,
    animalFlag: null,
    tradingDay: i.tradingDay,
    tokenAmount: row.tokenAmount,
    tokenDecimals: row.tokenDecimals,
    entryValuationPnlPct: row.entryValuationPnlPct,
    entryQuoteInAmount: row.entryQuoteInAmount,
    entryQuoteOutAmount: row.entryQuoteOutAmount,
    exitQuoteInAmount: i.exitQuote.exitQuoteInAmount,
    exitQuoteOutAmount: i.exitQuote.exitQuoteOutAmount,
    sellabilityLossPct: row.sellabilityLossPct,
    sellabilityCheckedAt: row.sellabilityCheckedAt,
    dexId: row.dexId,
    stopPollPnlPct: row.stopPollPnlPct,
    stopConfirmPnlPct: row.stopConfirmPnlPct,
    wouldBlockAtEntry: row.wouldBlockAtEntry,
    ...(extras.tradeLive ?? {}),
    proceedsUnknown: extras.proceedsUnknown ?? false,
  };
}
