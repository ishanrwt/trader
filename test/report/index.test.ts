import { describe, expect, it } from "vitest";
import {
  breakdownByExitReason,
  breakdownByTradingDay,
  compareShadowVsActual,
  compareShadowsSelectedVsUnselected,
  computeTotals,
  exitedTooEarly,
  formatReport,
  formatTradeDetail,
  goLiveChecklist,
  quantileBuckets,
  scoreComponentCorrelations,
  skipReasonStats,
  type ShadowRecord,
  type TradeDetailRecord,
  type TradeRecord,
} from "../../src/report/index.js";

function trade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    mode: "paper",
    exitTime: 0,
    tradingDay: "2026-01-01",
    exitReason: "target",
    netPnlUsd: 0,
    netPnlPct: 0,
    m5ChangePct: null,
    h1ChangePct: null,
    buyPressurePct: null,
    liquidityUsd: null,
    pairAgeMs: null,
    top10Pct: null,
    score: null,
    scoreComponents: null,
    ...overrides,
  };
}

// Hand-checked dataset (see the comment on each expectation for the arithmetic).
const T1 = trade({ exitTime: 1000, tradingDay: "2026-01-01", exitReason: "target", netPnlUsd: 10, netPnlPct: 20 });
const T2 = trade({ exitTime: 2000, tradingDay: "2026-01-01", exitReason: "stop", netPnlUsd: -5, netPnlPct: -10 });
const T3 = trade({ exitTime: 3000, tradingDay: "2026-01-02", exitReason: "target", netPnlUsd: 15, netPnlPct: 25 });
const T4 = trade({ exitTime: 4000, tradingDay: "2026-01-02", exitReason: "time_exit", netPnlUsd: -20, netPnlPct: -30 });
const DATASET = [T1, T2, T3, T4];

describe("computeTotals (hand-checked)", () => {
  const totals = computeTotals(DATASET);

  it("win rate: 2 of 4 trades have net PnL USD > 0", () => {
    expect(totals.winRate).toBeCloseTo(0.5, 10);
  });

  it("median/mean net PnL %, sorted [-30,-10,20,25]", () => {
    expect(totals.medianNetPnlPct).toBeCloseTo(5, 10); // (-10+20)/2
    expect(totals.meanNetPnlPct).toBeCloseTo(1.25, 10); // (20-10+25-30)/4
  });

  it("median/mean net PnL USD, sorted [-20,-5,10,15]", () => {
    expect(totals.medianNetPnlUsd).toBeCloseTo(2.5, 10); // (-5+10)/2
    expect(totals.meanNetPnlUsd).toBeCloseTo(0, 10);
  });

  it("p10/p90 net PnL % via linear interpolation", () => {
    expect(totals.p10NetPnlPct).toBeCloseTo(-24, 10); // rank=0.3 -> -30*0.7 + -10*0.3
    expect(totals.p90NetPnlPct).toBeCloseTo(23.5, 10); // rank=2.7 -> 20*0.3 + 25*0.7
  });

  it("average win vs average loss", () => {
    expect(totals.avgWinUsd).toBeCloseTo(12.5, 10); // mean(10,15)
    expect(totals.avgLossUsd).toBeCloseTo(-12.5, 10); // mean(-5,-20)
  });

  it("total net PnL and max drawdown of the cumulative curve", () => {
    expect(totals.totalNetPnlUsd).toBeCloseTo(0, 10);
    // Chronological order [10,-5,15,-20] -> cumulative [10,5,20,0], peak [10,10,20,20], drawdown max = 20.
    expect(totals.maxDrawdownUsd).toBeCloseTo(20, 10);
  });
});

describe("breakdownByExitReason / breakdownByTradingDay", () => {
  it("groups correctly and each group's totals are internally consistent", () => {
    const byReason = breakdownByExitReason(DATASET);
    expect(byReason.target!.trades).toBe(2);
    expect(byReason.target!.totalNetPnlUsd).toBeCloseTo(25, 10); // 10+15
    expect(byReason.stop!.trades).toBe(1);

    const byDay = breakdownByTradingDay(DATASET);
    expect(byDay["2026-01-01"]!.totalNetPnlUsd).toBeCloseTo(5, 10); // 10-5
    expect(byDay["2026-01-02"]!.totalNetPnlUsd).toBeCloseTo(-5, 10); // 15-20
  });
});

describe("quantileBuckets", () => {
  it("splits into equal-size buckets ordered by the key, earliest/lowest first", () => {
    const withScores = [
      trade({ netPnlUsd: 1, score: 0.9 }),
      trade({ netPnlUsd: 2, score: 0.1 }),
      trade({ netPnlUsd: 3, score: 0.5 }),
      trade({ netPnlUsd: 4, score: 0.3 }),
    ];
    const buckets = quantileBuckets(withScores, (t) => t.score, 2);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]!.count).toBe(2);
    expect(buckets[0]!.totals.trades).toBe(2); // scores 0.1, 0.3 -> the two trades with netPnlUsd 2 and 4
    expect(buckets[1]!.totals.trades).toBe(2); // scores 0.5, 0.9 -> netPnlUsd 3 and 1
  });

  it("excludes trades with a null key", () => {
    const buckets = quantileBuckets([trade({ score: null }), trade({ score: 0.5 })], (t) => t.score, 2);
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(1);
  });
});

describe("scoreComponentCorrelations", () => {
  const components = { buyPressure: 0, activity: 0, momentum: 0, depth: 0, holders: 0.5, freshness: 0 };
  const withComponents = [
    trade({ netPnlUsd: -10, scoreComponents: { ...components, buyPressure: 0.2 } }),
    trade({ netPnlUsd: 0, scoreComponents: { ...components, buyPressure: 0.5 } }),
    trade({ netPnlUsd: 10, scoreComponents: { ...components, buyPressure: 0.8 } }),
  ];

  it("a perfectly linear relationship correlates near 1", () => {
    expect(scoreComponentCorrelations(withComponents).buyPressure).toBeCloseTo(1, 6);
  });

  it("a constant component (zero variance) correlates at 0, not NaN", () => {
    expect(scoreComponentCorrelations(withComponents).holders).toBe(0);
  });
});

describe("shadow comparisons", () => {
  const shadows: ShadowRecord[] = [
    { outcome: "selected", netPnlUsd: 10, netPnlPct: 20 },
    { outcome: "selected", netPnlUsd: -5, netPnlPct: -10 },
    { outcome: "closed", netPnlUsd: 20, netPnlPct: 40 },
    { outcome: "closed", netPnlUsd: -2, netPnlPct: -5 },
    { outcome: "unsellable", netPnlUsd: null, netPnlPct: null },
    { outcome: "open", netPnlUsd: null, netPnlPct: null },
  ];

  it("compares selected vs unselected, excluding unsellable and still-open shadows", () => {
    const result = compareShadowsSelectedVsUnselected(shadows);
    expect(result.selected.trades).toBe(2);
    expect(result.selected.totalNetPnlUsd).toBeCloseTo(5, 10);
    expect(result.unselected.trades).toBe(2);
    expect(result.unselected.totalNetPnlUsd).toBeCloseTo(18, 10);
  });

  it("compares shadow vs actual pnl for selected mints (hand-checked: two points give a perfect correlation)", () => {
    const result = compareShadowVsActual([
      { shadowNetPnlPct: 20, actualNetPnlPct: 22 },
      { shadowNetPnlPct: -5, actualNetPnlPct: -4 },
    ]);
    expect(result.pairs).toBe(2);
    expect(result.meanAbsDiffPct).toBeCloseTo(1.5, 10); // mean(|20-22|, |-5+4|) = mean(2,1)
    expect(result.correlation).toBeCloseTo(1, 6);
  });
});

describe("exitedTooEarly", () => {
  it("hand-checked: one of two priced rows shows upside after the exit", () => {
    const result = exitedTooEarly([
      { exitPriceUsd: 1, price15mUsd: 1.2, price60mUsd: null }, // +20%
      { exitPriceUsd: 1, price15mUsd: 0.9, price60mUsd: 0.8 }, // best 0.9 -> -10%, not "too early"
      { exitPriceUsd: 2, price15mUsd: null, price60mUsd: null }, // no data, excluded
    ]);
    expect(result.shareTooEarly).toBeCloseTo(0.5, 10);
    expect(result.medianUpsidePctMissed).toBeCloseTo(20, 10);
  });
});

describe("skipReasonStats", () => {
  it("hand-checked median +15/+60 percent change by reason", () => {
    const stats = skipReasonStats([
      { skipReason: "liquidity", priceAtSkipUsd: 1, price15mUsd: 1.1, price60mUsd: 1.3 }, // +10%, +30%
      { skipReason: "liquidity", priceAtSkipUsd: 2, price15mUsd: 1.8, price60mUsd: 2.4 }, // -10%, +20%
    ]);
    const liquidity = stats.find((s) => s.reason === "liquidity")!;
    expect(liquidity.count).toBe(2);
    expect(liquidity.median15mPctChange).toBeCloseTo(0, 10); // median(10,-10)
    expect(liquidity.median60mPctChange).toBeCloseTo(25, 10); // median(30,20)
  });

  it("reports null (missing), not 0%, when no mint in the group has a price at that offset", () => {
    const stats = skipReasonStats([
      { skipReason: "pair", priceAtSkipUsd: 1, price15mUsd: null, price60mUsd: null },
      { skipReason: "pair", priceAtSkipUsd: null, price15mUsd: null, price60mUsd: null }, // never even had a skip-time price
    ]);
    const pair = stats.find((s) => s.reason === "pair")!;
    expect(pair.count).toBe(2);
    expect(pair.median15mPctChange).toBeNull();
    expect(pair.median60mPctChange).toBeNull();
  });

  it("excludes only the missing readings from the median, keeping the priced ones when the group is mixed", () => {
    const stats = skipReasonStats([
      { skipReason: "pair", priceAtSkipUsd: 1, price15mUsd: 1.2, price60mUsd: null }, // +20% at 15m, no 60m reading
      { skipReason: "pair", priceAtSkipUsd: 1, price15mUsd: null, price60mUsd: null }, // no reading at all
    ]);
    const pair = stats.find((s) => s.reason === "pair")!;
    expect(pair.count).toBe(2);
    expect(pair.median15mPctChange).toBeCloseTo(20, 10); // the one priced reading, not diluted by the missing one
    expect(pair.median60mPctChange).toBeNull(); // neither mint has a 60m price
  });
});

describe("goLiveChecklist", () => {
  it("PASS/FAIL each rule against a small dataset with low thresholds", () => {
    const cfg = { minTrades: 4, minDays: 0, minMedianPnlPct: 0, minTotalPnlUsd: -1, minP10PnlPct: -50 };
    const items = goLiveChecklist(DATASET, false, cfg);

    expect(items.find((i) => i.check.startsWith("closed trades"))!.pass).toBe(true); // 4 >= 4
    expect(items.find((i) => i.check.startsWith("median net PnL"))!.pass).toBe(true); // 5 > 0
    expect(items.find((i) => i.check.startsWith("total net PnL"))!.pass).toBe(true); // 0 > -1
    expect(items.find((i) => i.check.startsWith("p10 net PnL"))!.pass).toBe(true); // -24 >= -50
    expect(items.find((i) => i.check === "no positions currently stuck")!.pass).toBe(true);
  });

  it("fails the trade-count and stuck-position checks when they don't clear", () => {
    const cfg = { minTrades: 100, minDays: 7, minMedianPnlPct: 0, minTotalPnlUsd: 0, minP10PnlPct: -20 };
    const items = goLiveChecklist(DATASET, true, cfg);
    expect(items.find((i) => i.check.startsWith("closed trades"))!.pass).toBe(false);
    expect(items.find((i) => i.check === "no positions currently stuck")!.pass).toBe(false);
  });
});

describe("formatReport", () => {
  it("renders every section, including PASS/FAIL lines for the go-live checklist", () => {
    const text = formatReport({
      trades: DATASET,
      paperTrades: DATASET,
      skipTracks: [{ skipReason: "liquidity", priceAtSkipUsd: 1, price15mUsd: 1.1, price60mUsd: 1.2 }],
      hasStuckPositions: false,
      goLiveConfig: { minTrades: 4, minDays: 0, minMedianPnlPct: 0, minTotalPnlUsd: -1, minP10PnlPct: -50 },
    });
    expect(text).toContain("=== Report (4 trades) ===");
    expect(text).toContain("By exit reason:");
    expect(text).toContain("Go-live checklist:");
    expect(text).toContain("[PASS]");
  });

  it("shows 'n/a' for a skip reason with no priced mints, not 0.0%", () => {
    const text = formatReport({
      trades: DATASET,
      paperTrades: DATASET,
      skipTracks: [{ skipReason: "pair", priceAtSkipUsd: 1, price15mUsd: null, price60mUsd: null }],
      hasStuckPositions: false,
      goLiveConfig: { minTrades: 4, minDays: 0, minMedianPnlPct: 0, minTotalPnlUsd: -1, minP10PnlPct: -50 },
    });
    expect(text).toContain("pair(n=1, +15m=n/a, +60m=n/a)");
    expect(text).not.toContain("+15m=0.0%");
  });
});

function tradeDetail(overrides: Partial<TradeDetailRecord> = {}): TradeDetailRecord {
  return {
    id: 1,
    mint: "MINT1111111111111111111111111111111111111",
    symbol: "FOO",
    entryTime: 1_000,
    exitTime: 42_404,
    sizeUsd: 25,
    costBasis: 25.05,
    tokenAmount: 68_306.48291,
    tokenDecimals: 6,
    proceeds: 19.85302,
    netPnlUsd: -5.19698,
    netPnlPct: -20.746,
    peakPnl: -3.2,
    exitReason: "stop",
    entryLiquidityUsd: 54_801.61,
    entryValuationPnlPct: -3.2,
    entryQuoteInAmount: "25000000",
    entryQuoteOutAmount: "68306482910",
    exitQuoteInAmount: "68306482910",
    exitQuoteOutAmount: "19853020",
    history: [
      { t: 1000, pnl: -3.2 },
      { t: 11000, pnl: -5.1 },
      { t: 21000, pnl: -12.4 },
    ],
    ...overrides,
  };
}

describe("formatTradeDetail", () => {
  it("renders every field for a fully-populated trade, including hold duration and raw quote amounts", () => {
    const text = formatTradeDetail([tradeDetail()]);
    expect(text).toContain("=== Trade 1: FOO (MINT1111111111111111111111111111111111111) ===");
    expect(text).toContain("hold: 41.4s"); // (42404-1000)/1000
    expect(text).toContain("tokens received: 68306.48291  decimals: 6");
    expect(text).toContain("entry valuation (first exit-lane quote after fill): -3.20%");
    expect(text).toContain("entry quote (raw): in=25000000 out=68306482910");
    expect(text).toContain("exit quote (raw): in=68306482910 out=19853020");
    expect(text).toContain("history (3 of 3): (1000, -3.20%), (11000, -5.10%), (21000, -12.40%)");
  });

  it("shows n/a for missing entry valuation, quote amounts, and history — never a crash", () => {
    const text = formatTradeDetail([
      tradeDetail({
        tokenAmount: null,
        tokenDecimals: null,
        entryValuationPnlPct: null,
        entryQuoteInAmount: null,
        entryQuoteOutAmount: null,
        exitQuoteInAmount: null,
        exitQuoteOutAmount: null,
        entryLiquidityUsd: null,
        history: [],
      }),
    ]);
    expect(text).toContain("tokens received: n/a  decimals: n/a");
    expect(text).toContain("entry valuation (first exit-lane quote after fill): n/a");
    expect(text).toContain("entry quote (raw): n/a (no successful quote)");
    expect(text).toContain("entry liquidity: n/a");
    expect(text).toContain("history (first 5 of 0): none");
  });

  it("shows n/a for a non-finite peak (the -Infinity sentinel, in case it's ever seen raw)", () => {
    const text = formatTradeDetail([tradeDetail({ peakPnl: Number.NEGATIVE_INFINITY })]);
    expect(text).toContain("peak: n/a");
  });

  it("shows both first-N and last-N history points, not just the first N", () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ t: i * 1000, pnl: i }));
    const text = formatTradeDetail([tradeDetail({ history })], { historyPoints: 5 });
    expect(text).toContain("history, first 5 of 12: (0, 0.00%), (1000, 1.00%), (2000, 2.00%), (3000, 3.00%), (4000, 4.00%)");
    expect(text).toContain(
      "history, last 5 of 12 (2 more in between): (7000, 7.00%), (8000, 8.00%), (9000, 9.00%), (10000, 10.00%), (11000, 11.00%)",
    );
  });

  it("when first-N and last-N overlap (a short excess over the limit), shows the overlapping points in both without claiming a negative gap", () => {
    const text = formatTradeDetail(
      [tradeDetail({ history: [{ t: 1, pnl: 1 }, { t: 2, pnl: 2 }, { t: 3, pnl: 3 }] })],
      { historyPoints: 2 },
    );
    expect(text).toContain("history, first 2 of 3: (1, 1.00%), (2, 2.00%)");
    expect(text).toContain("history, last 2 of 3: (2, 2.00%), (3, 3.00%)");
    expect(text).not.toContain("more in between");
  });

  it("shows one combined line, not a redundant repeat, when the whole history already fits within the requested count", () => {
    const text = formatTradeDetail([tradeDetail({ history: [{ t: 1, pnl: 1 }, { t: 2, pnl: 2 }] })], { historyPoints: 5 });
    expect(text).toContain("history (2 of 2): (1, 1.00%), (2, 2.00%)");
    expect(text).not.toContain("first 5");
    expect(text).not.toContain("last 5");
  });

  it("handles multiple trades and an empty list", () => {
    expect(formatTradeDetail([tradeDetail({ id: 1 }), tradeDetail({ id: 2 })])).toContain("Trade 1:");
    expect(formatTradeDetail([])).toBe("No trades.");
  });
});
