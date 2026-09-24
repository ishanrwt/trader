import { describe, expect, it } from "vitest";
import { openDb } from "../../src/storage/db.js";
import { TradeHistoryStore } from "../../src/storage/tradeHistory.js";
import { TradesStore, type NewTradeRow } from "../../src/storage/trades.js";

function newTrade(overrides: Partial<NewTradeRow> = {}): NewTradeRow {
  return {
    mode: "paper",
    mint: "MINT1",
    symbol: "FOO",
    pairAddress: "pair1",
    entryTime: 1000,
    exitTime: 2000,
    sizeUsd: 25,
    costBasis: 25.05,
    proceeds: 30,
    netPnlUsd: 4.95,
    netPnlPct: 19.76,
    exitReason: "target",
    peakPnl: 20,
    timerRestarts: 0,
    targetExtensions: 0,
    feesUsd: 0.1,
    entryPairSnapshot: null,
    top1Pct: 5,
    top10Pct: 20,
    score: 0.6,
    scoreComponents: null,
    animalFlag: null,
    tradingDay: "2026-01-01",
    tokenAmount: 1000,
    tokenDecimals: 6,
    entryValuationPnlPct: -1.5,
    entryQuoteInAmount: null,
    entryQuoteOutAmount: null,
    exitQuoteInAmount: null,
    exitQuoteOutAmount: null,
    ...overrides,
  };
}

describe("TradeHistoryStore", () => {
  it("preserves a trade's history — the whole point of this table (position_history is deleted on close)", () => {
    const db = openDb(":memory:");
    const tradeId = new TradesStore(db).insert(newTrade());
    const store = new TradeHistoryStore(db);

    store.insertMany(tradeId, [
      { t: 1000, pnl: -1.5 },
      { t: 1010, pnl: -2.1 },
      { t: 1020, pnl: 3.4 },
    ]);

    expect(store.listForTrade(tradeId)).toEqual([
      { t: 1000, pnl: -1.5 },
      { t: 1010, pnl: -2.1 },
      { t: 1020, pnl: 3.4 },
    ]);
  });

  it("does nothing for an empty points array (no wasted insert, no crash)", () => {
    const db = openDb(":memory:");
    const tradeId = new TradesStore(db).insert(newTrade());
    const store = new TradeHistoryStore(db);
    expect(() => store.insertMany(tradeId, [])).not.toThrow();
    expect(store.listForTrade(tradeId)).toEqual([]);
  });

  it("keeps different trades' history separate", () => {
    const db = openDb(":memory:");
    const tradesStore = new TradesStore(db);
    const tradeId1 = tradesStore.insert(newTrade({ mint: "A" }));
    const tradeId2 = tradesStore.insert(newTrade({ mint: "B" }));
    const store = new TradeHistoryStore(db);

    store.insertMany(tradeId1, [{ t: 1, pnl: 1 }]);
    store.insertMany(tradeId2, [{ t: 2, pnl: 2 }]);

    expect(store.listForTrade(tradeId1)).toEqual([{ t: 1, pnl: 1 }]);
    expect(store.listForTrade(tradeId2)).toEqual([{ t: 2, pnl: 2 }]);
  });
});
