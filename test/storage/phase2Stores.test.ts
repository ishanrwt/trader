import { describe, expect, it } from "vitest";
import { openDb } from "../../src/storage/db.js";
import { TradesStore, type NewTradeRow } from "../../src/storage/trades.js";
import { ShadowsStore, type NewShadowRow } from "../../src/storage/shadows.js";
import { SkipTracksStore } from "../../src/storage/skipTracks.js";
import { PostExitTracksStore } from "../../src/storage/postExitTracks.js";
import { SafetyCacheStore } from "../../src/storage/safetyCache.js";

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
    entryPairSnapshot: { liquidityUsd: 20_000 },
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

describe("TradesStore", () => {
  it("inserts and lists trades, filterable by mode/day range", () => {
    const store = new TradesStore(openDb(":memory:"));
    store.insert(newTrade({ tradingDay: "2026-01-01" }));
    store.insert(newTrade({ tradingDay: "2026-01-02", exitTime: 3000 }));
    expect(store.listAll().length).toBe(2);
    expect(store.listAll({ from: "2026-01-02" }).length).toBe(1);
    expect(store.listForTradingDay("2026-01-01").length).toBe(1);
  });

  it("round-trips tokens received, decimals, entry valuation, and raw quote amounts (in/out for both entry and exit)", () => {
    const store = new TradesStore(openDb(":memory:"));
    const id = store.insert(
      newTrade({
        tokenAmount: 68_306.48291,
        tokenDecimals: 6,
        entryValuationPnlPct: -3.2,
        entryQuoteInAmount: "25000000",
        entryQuoteOutAmount: "68306482910",
        exitQuoteInAmount: "68306482910",
        exitQuoteOutAmount: "19853020",
      }),
    );
    const row = store.get(id)!;
    expect(row.tokenAmount).toBeCloseTo(68_306.48291, 6);
    expect(row.tokenDecimals).toBe(6);
    expect(row.entryValuationPnlPct).toBe(-3.2);
    expect(row.entryQuoteInAmount).toBe("25000000");
    expect(row.entryQuoteOutAmount).toBe("68306482910");
    expect(row.exitQuoteInAmount).toBe("68306482910");
    expect(row.exitQuoteOutAmount).toBe("19853020");
  });

  it("allows null tokenAmount/decimals/quote amounts (e.g. a written_off trade with no exit quote)", () => {
    const store = new TradesStore(openDb(":memory:"));
    const id = store.insert(
      newTrade({ tokenAmount: null, tokenDecimals: null, exitQuoteInAmount: null, exitQuoteOutAmount: null, exitReason: "written_off" }),
    );
    const row = store.get(id)!;
    expect(row.exitQuoteInAmount).toBeNull();
    expect(row.exitQuoteOutAmount).toBeNull();
  });

  it("get() returns undefined for a missing id", () => {
    const store = new TradesStore(openDb(":memory:"));
    expect(store.get(999)).toBeUndefined();
  });
});

function newShadow(overrides: Partial<NewShadowRow> = {}): NewShadowRow {
  return {
    mint: "MINT1",
    symbol: "FOO",
    pairAddress: "pair1",
    outcome: "open",
    entryTime: 1000,
    costBasis: 25.05,
    tokenAmount: 1000,
    entryLiquidityUsd: 20_000,
    entryPriceUsd: 0.025,
    score: 0.6,
    scoreComponents: null,
    peakPnl: 0,
    currentTarget: 30,
    targetExtensions: 0,
    timerRestarts: 0,
    lastRestartAt: null,
    deadline: 900_000,
    trailArmed: false,
    fastStreak: 0,
    lowLiqStreak: 0,
    noRouteSince: null,
    exitTime: null,
    exitReason: null,
    proceeds: null,
    netPnlUsd: null,
    netPnlPct: null,
    ...overrides,
  };
}

describe("ShadowsStore", () => {
  it("inserts, transitions outcome, and lists/counts open shadows", () => {
    const store = new ShadowsStore(openDb(":memory:"));
    const id = store.insert(newShadow());
    expect(store.countOpen()).toBe(1);
    store.update(id, { outcome: "selected" });
    expect(store.countOpen()).toBe(0);
    expect(store.get(id)!.outcome).toBe("selected");
  });

  it("getOpenByMint finds the open shadow for a mint", () => {
    const store = new ShadowsStore(openDb(":memory:"));
    store.insert(newShadow({ mint: "A" }));
    expect(store.getOpenByMint("A")?.mint).toBe("A");
    expect(store.getOpenByMint("B")).toBeUndefined();
  });
});

describe("SkipTracksStore", () => {
  it("inserts unresolved, then resolves through both offsets", () => {
    const store = new SkipTracksStore(openDb(":memory:"));
    const id = store.insert({ mint: "A", skipReason: "liquidity", discoveredAt: 0, skippedAt: 0, priceAtSkipUsd: 1 });
    expect(store.listUnresolved().length).toBe(1);
    store.setPrice15m(id, 1.1);
    expect(store.listUnresolved()[0]!.price15mUsd).toBe(1.1);
    store.setPrice60mAndResolve(id, 1.3);
    expect(store.listUnresolved().length).toBe(0);
    expect(store.listAll()[0]!.resolved).toBe(true);
  });

  it("counts entries within a window for the per-hour cap", () => {
    const store = new SkipTracksStore(openDb(":memory:"));
    store.insert({ mint: "A", skipReason: "liquidity", discoveredAt: 0, skippedAt: 1000, priceAtSkipUsd: 1 });
    store.insert({ mint: "B", skipReason: "liquidity", discoveredAt: 0, skippedAt: 5000, priceAtSkipUsd: 1 });
    expect(store.countInWindow(0)).toBe(2);
    expect(store.countInWindow(4000)).toBe(1);
  });
});

describe("PostExitTracksStore", () => {
  it("inserts unresolved, then resolves through all three offsets", () => {
    const db = openDb(":memory:");
    const tradeId = new TradesStore(db).insert(newTrade());
    const store = new PostExitTracksStore(db);
    const id = store.insert({ tradeId, mint: "A", exitTime: 0, exitPriceUsd: 1 });
    store.setPrice15m(id, 1.1);
    store.setPrice30m(id, 1.2);
    expect(store.listUnresolved().length).toBe(1);
    store.setPrice60mAndResolve(id, 1.3);
    expect(store.listUnresolved().length).toBe(0);
  });
});

describe("SafetyCacheStore", () => {
  it("caches permanently and upserts on re-set", () => {
    const store = new SafetyCacheStore(openDb(":memory:"));
    expect(store.get("MINT1")).toBeUndefined();
    store.set("MINT1", { passed: true, reason: "ok" }, 1000);
    expect(store.get("MINT1")).toEqual({ passed: true, reason: "ok" });
    store.set("MINT1", { passed: false, reason: "mint authority not revoked" }, 2000);
    expect(store.get("MINT1")).toEqual({ passed: false, reason: "mint authority not revoked" });
  });
});
