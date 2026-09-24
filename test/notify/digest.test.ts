import { describe, expect, it } from "vitest";
import { buildDigest, type DigestInput } from "../../src/notify/digest.js";

function baseInput(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    mode: "PAPER",
    now: 3_600_000,
    startedAt: 0,
    paused: false,
    killed: false,
    dailyLossHalted: false,
    errorHalted: false,
    lossStreak: 0,
    solPriceUsd: 150.5,
    walletUsdc: 500,
    walletSol: 0.5,
    tradesClosed: [],
    openPositions: [],
    tradingDay: {
      trades: 0,
      winRate: 0,
      medianNetPnlPct: 0,
      meanNetPnlPct: 0,
      totalNetPnlUsd: 0,
      biggestWinUsd: null,
      biggestLossUsd: null,
      exitReasonBreakdown: {},
    },
    funnel: {
      discovered: 10,
      eligible: 6,
      ready: 2,
      entered: 1,
      pendingNow: 4,
      skipReasons: {},
      skippedSlotsFullCount: 0,
      scoreRangeOfEntries: null,
    },
    risk: { dailyLossUsd: 0, dailyLossCapUsd: 30 },
    health: {
      dexScreenerErrors: 0,
      rpcErrors: 0,
      jupiterRequestsPerMinAvg: 0,
      jupiterRequestsPerMinPeak: 0,
      jupiter429s: 0,
      deferredEntryChecks: 0,
      downtimeGaps: [],
    },
    ...overrides,
  };
}

describe("buildDigest", () => {
  it("labels the digest with the mode", () => {
    expect(buildDigest(baseInput({ mode: "PAPER" }))).toContain("=== Trader digest (PAPER) ===");
  });

  it("shows the wallet balances", () => {
    expect(buildDigest(baseInput({ walletUsdc: 474.95, walletSol: 0.5 }))).toContain("$474.95 USDC, 0.5000 SOL");
  });

  it("shows the top skip reasons sorted by count, capped at 3", () => {
    const text = buildDigest(
      baseInput({ funnel: { ...baseInput().funnel, skipReasons: { liquidity: 10, pair: 3, entryWindow: 7, duplicate: 1 } } }),
    );
    expect(text).toContain("top skip reasons: liquidity=10, entryWindow=7, pair=3");
  });

  it("shows 'none' when there are no skip reasons", () => {
    expect(buildDigest(baseInput())).toContain("top skip reasons: none");
  });

  it("shows the eligible and READY counts in the funnel", () => {
    const text = buildDigest(baseInput({ funnel: { ...baseInput().funnel, eligible: 6, ready: 2, entered: 1 } }));
    expect(text).toContain("eligible: 6");
    expect(text).toContain("READY: 2");
    expect(text).toContain("entered: 1");
  });

  it("shows n/a for the entry score range when nothing entered, and the range otherwise", () => {
    expect(buildDigest(baseInput())).toContain("score range of entries: n/a");
    const text = buildDigest(baseInput({ funnel: { ...baseInput().funnel, scoreRangeOfEntries: { min: 0.4, max: 0.8 } } }));
    expect(text).toContain("score range of entries: 0.40-0.80");
  });

  it("shows the pause reason when paused", () => {
    const text = buildDigest(baseInput({ paused: true, pauseReason: "manual" }));
    expect(text).toContain("paused: true (manual)");
  });

  it("shows kill, daily-loss-halt and error-halt state", () => {
    const text = buildDigest(baseInput({ killed: true, dailyLossHalted: true, errorHalted: true }));
    expect(text).toContain("killed: true");
    expect(text).toContain("daily loss halt: true");
    expect(text).toContain("error halt: true");
  });

  it("omits SOL/USD when the price isn't known yet", () => {
    expect(buildDigest(baseInput({ solPriceUsd: null }))).not.toContain("SOL/USD");
  });

  it("lists downtime gaps when present", () => {
    const text = buildDigest(baseInput({ health: { ...baseInput().health, downtimeGaps: [{ from: 0, to: 90_000 }] } }));
    expect(text).toContain("Downtime gaps this period: 1m 30s");
  });

  it("lists trades closed this window with exit reason and net PnL", () => {
    const text = buildDigest(
      baseInput({ tradesClosed: [{ symbol: "FOO", exitReason: "target", netPnlPct: 32.5, netPnlUsd: 8.13 }] }),
    );
    expect(text).toContain("FOO: target, +32.5% (+$8.13)");
  });

  it("shows 'none' when nothing closed", () => {
    expect(buildDigest(baseInput())).toContain("Trades closed this window:\n  none");
  });

  it("lists open positions with time held, pnl, target and deadline", () => {
    const text = buildDigest(
      baseInput({
        now: 100_000,
        openPositions: [{ symbol: "BAR", timeHeldMs: 60_000, pnlPct: -4.2, currentTarget: 30, deadline: 160_000 }],
      }),
    );
    expect(text).toContain("BAR: held 1m 0s, pnl -4.2%, target 30.0%, deadline in 1m 0s");
  });

  it("shows the trading-day summary and exit-reason breakdown", () => {
    const text = buildDigest(
      baseInput({
        tradingDay: {
          trades: 5,
          winRate: 0.6,
          medianNetPnlPct: 10,
          meanNetPnlPct: 8,
          totalNetPnlUsd: 40,
          biggestWinUsd: 20,
          biggestLossUsd: -5,
          exitReasonBreakdown: { target: 3, stop: 2 },
        },
      }),
    );
    expect(text).toContain("trades: 5, win rate: 60.0%");
    expect(text).toContain("biggest win: +$20.00, biggest loss: -$5.00");
    expect(text).toContain("exit reasons: target=3, stop=2");
  });

  it("shows the daily loss vs cap and the loss streak", () => {
    const text = buildDigest(baseInput({ lossStreak: 3, risk: { dailyLossUsd: -18, dailyLossCapUsd: 30 } }));
    expect(text).toContain("daily loss: -$18.00 vs -$30.00 cap");
    expect(text).toContain("loss streak: 3");
  });

  it("shows skipped-slots-full count", () => {
    expect(buildDigest(baseInput({ funnel: { ...baseInput().funnel, skippedSlotsFullCount: 7 } }))).toContain(
      "skipped (slots full): 7",
    );
  });
});
