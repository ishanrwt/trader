import { describe, expect, it } from "vitest";
import { openDb } from "../../src/storage/db.js";
import { PositionsStore, type NewPositionRow } from "../../src/storage/positions.js";
import { tradeFromPosition } from "../../src/storage/tradeFromPosition.js";
import { TradesStore } from "../../src/storage/trades.js";

function position(overrides: Partial<NewPositionRow> = {}): NewPositionRow {
  return {
    mode: "paper", mint: "MINT", symbol: "SYM", pairAddress: "PAIR", status: "closing", entryTime: 1_000, sizeUsd: 25, tokenAmount: 100, costBasis: 25.05,
    entryLiquidityUsd: 20_000, entryPairSnapshot: { dexId: "pumpswap", priceUsd: "0.01" }, score: 0.6, scoreComponents: { buyPressure: 0.5 },
    safetyResult: null, holdersResult: { passed: true, top1Pct: 3, top10Pct: 22 }, peakPnl: 4, currentTarget: 30, targetExtensions: 1, timerRestarts: 2,
    lastRestartAt: null, deadline: 900_000, trailArmed: false, fastStreak: 0, lowLiqStreak: 0, noRouteSince: null, closingSince: 60_000,
    pendingExitReason: "stop", lastPnlPct: -16.4, lastValueUsd: 21, lastPolledAt: 60_000, tokenDecimals: 6, entryValuationPnlPct: -3,
    entryQuoteInAmount: "25000000", entryQuoteOutAmount: "100000000",
    sellabilityLossPct: 3.1, sellabilityCheckedAt: 500, dexId: "pumpswap",
    ...overrides,
  };
}

/** Exactly what finalizeTrade does with the closing row: build the trade from it and insert it. */
function finalize(overrides: Partial<NewPositionRow>, proceeds = 20.8, exitReason = "stop") {
  const db = openDb(":memory:");
  const positions = new PositionsStore(db);
  const trades = new TradesStore(db);
  const row = positions.get(positions.insert(position(overrides)))!;
  const trade = trades.get(
    trades.insert(
      tradeFromPosition({
        row, proceeds, exitReason, exitTime: 70_000, tradingDay: "2026-09-25",
        exitQuote: { exitQuoteInAmount: "100000000", exitQuoteOutAmount: "20900000" }, defaultFeesUsd: 0.1,
      }),
    ),
  )!;
  return { row, trade };
}

describe("tradeFromPosition (the trade row finalizeTrade records)", () => {
  it("a position with stop_poll_pnl_pct and stop_confirm_pnl_pct set produces a trade row with the same values", () => {
    const { row, trade } = finalize({ stopPollPnlPct: -16.4, stopConfirmPnlPct: -17.02 });
    expect(row.stopPollPnlPct).toBe(-16.4);
    expect(row.stopConfirmPnlPct).toBe(-17.02);
    expect(trade.stopPollPnlPct).toBe(-16.4);
    expect(trade.stopConfirmPnlPct).toBe(-17.02);
  });

  it("a null (no-route) confirmation stays null on the trade, not -Infinity or 0", () => {
    const { trade } = finalize({ stopPollPnlPct: -16.4, stopConfirmPnlPct: null });
    expect(trade.stopPollPnlPct).toBe(-16.4);
    expect(trade.stopConfirmPnlPct).toBeNull();
  });

  it("copies the sellability and dexId fields and the rest of section 11.1 from the position", () => {
    const { trade } = finalize({ stopPollPnlPct: -16.4, stopConfirmPnlPct: -17.02 });
    expect(trade).toMatchObject({
      sellabilityLossPct: 3.1, sellabilityCheckedAt: 500, dexId: "pumpswap",
      mode: "paper", mint: "MINT", entryTime: 1_000, exitTime: 70_000, exitReason: "stop", proceeds: 20.8,
      timerRestarts: 2, targetExtensions: 1, feesUsd: 0.1, top1Pct: 3, top10Pct: 22, score: 0.6, tradingDay: "2026-09-25",
      tokenAmount: 100, tokenDecimals: 6, entryValuationPnlPct: -3, exitQuoteOutAmount: "20900000", proceedsUnknown: false,
    });
    expect(trade.netPnlUsd).toBeCloseTo(20.8 - 25.05, 10);
  });

  it("carries the would-be-halt tag from the position to the trade (section 11.1); unset stays null (not recorded)", () => {
    expect(finalize({ wouldBlockAtEntry: "daily_loss+loss_streak" }).trade.wouldBlockAtEntry).toBe("daily_loss+loss_streak");
    expect(finalize({ wouldBlockAtEntry: "none" }).trade.wouldBlockAtEntry).toBe("none");
    const untagged = finalize({});
    expect(untagged.row.wouldBlockAtEntry).toBeNull();
    expect(untagged.trade.wouldBlockAtEntry).toBeNull();
  });

  it("a non-stop close carries null stop values", () => {
    const { trade } = finalize({}, 32, "target");
    expect(trade.stopPollPnlPct).toBeNull();
    expect(trade.stopConfirmPnlPct).toBeNull();
  });
});
