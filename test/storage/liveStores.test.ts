import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations, tableNames } from "../../src/storage/db.js";
import { FeeLossesStore } from "../../src/storage/feeLosses.js";
import { DuplicateIntentError, IntentsStore, sellRefKey, buyRefKey, type ReserveIntentInput } from "../../src/storage/intents.js";
import { PositionsStore, type NewPositionRow } from "../../src/storage/positions.js";
import { SafetyCacheStore } from "../../src/storage/safetyCache.js";
import { ShadowsStore } from "../../src/storage/shadows.js";
import { StateStore } from "../../src/storage/state.js";
import { TradesStore, type NewTradeRow } from "../../src/storage/trades.js";

const MIGRATIONS = fileURLToPath(new URL("../../src/storage/migrations", import.meta.url));

function position(overrides: Partial<NewPositionRow> = {}): NewPositionRow {
  return {
    mode: "live", mint: "MINT", symbol: "SYM", pairAddress: "PAIR", status: "open", entryTime: 1000, sizeUsd: 25, tokenAmount: 100, costBasis: 25.3,
    entryLiquidityUsd: 20_000, entryPairSnapshot: null, score: 0.5, scoreComponents: null, safetyResult: null, holdersResult: null, peakPnl: -1,
    currentTarget: 30, targetExtensions: 0, timerRestarts: 0, lastRestartAt: null, deadline: 2000, trailArmed: false, fastStreak: 0, lowLiqStreak: 0,
    noRouteSince: null, closingSince: null, pendingExitReason: null, lastPnlPct: null, lastValueUsd: null, lastPolledAt: null, tokenDecimals: 6,
    entryValuationPnlPct: null, entryQuoteInAmount: null, entryQuoteOutAmount: null, ...overrides,
  };
}

function trade(overrides: Partial<NewTradeRow> = {}): NewTradeRow {
  return {
    mode: "live", mint: "MINT", symbol: "SYM", pairAddress: null, entryTime: 1, exitTime: 2, sizeUsd: 25, costBasis: 25, proceeds: 0, netPnlUsd: -25,
    netPnlPct: -100, exitReason: "reconciled", peakPnl: 0, timerRestarts: 0, targetExtensions: 0, feesUsd: 0, entryPairSnapshot: null, top1Pct: null,
    top10Pct: null, score: null, scoreComponents: null, animalFlag: null, tradingDay: "2026-09-25", tokenAmount: null, tokenDecimals: null,
    entryValuationPnlPct: null, entryQuoteInAmount: null, entryQuoteOutAmount: null, exitQuoteInAmount: null, exitQuoteOutAmount: null, ...overrides,
  };
}

function reserveInput(overrides: Partial<ReserveIntentInput> = {}): ReserveIntentInput {
  return { kind: "sell", mode: "live", mint: "MINT", positionId: 7, refKey: sellRefKey(7), side: "sell", inputMint: "MINT", outputMint: "USDC", now: 1, ...overrides };
}

describe("migration 0004_live", () => {
  it("adds tx_intents and fee_losses", () => {
    const db = openDb(":memory:");
    expect(tableNames(db)).toEqual(expect.arrayContaining(["tx_intents", "fee_losses"]));
    db.close();
  });

  it("copies the Phase 2 risk state keys to their per-mode :paper names on an existing database", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-mig-"));
    try {
      for (const f of ["0001_init.sql", "0002_phase2.sql", "0003_trade_history_and_quotes.sql"]) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
      const db = new Database(":memory:");
      runMigrations(db, dir);
      const state = new StateStore(db);
      state.set("lossStreak", 3);
      state.set("dailyLossHaltDay", "2026-09-24");
      runMigrations(db); // now applies 0004 (and any later migrations)
      expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(4);
      expect(state.get("lossStreak:paper", 0)).toBe(3);
      expect(state.get("dailyLossHaltDay:paper", null)).toBe("2026-09-24");
      expect(state.get("lossStreak:live", 0)).toBe(0);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("IntentsStore: the one-live-transaction guard (SPEC.md section 16.4, addition A)", () => {
  it("refuses a second intent for the same position and side in every unresolved status", () => {
    for (const status of ["pending", "signed", "sent", "landed"] as const) {
      const db = openDb(":memory:");
      const store = new IntentsStore(db);
      const id = store.reserve(reserveInput());
      if (status !== "pending") store.markSigned(id, { signature: "SIG", signedTxB64: "AA==", lastValidBlockHeight: 100, expectedInRaw: "1", expectedOutRaw: "2", minOutRaw: "1" }, 2);
      if (status === "sent" || status === "landed") store.markSent(id, 3);
      if (status === "landed") store.markLanded(id, 4);
      expect(store.get(id)!.status).toBe(status);
      expect(store.hasUnresolved(sellRefKey(7), "sell")).toBe(true);
      expect(() => store.reserve(reserveInput())).toThrow(DuplicateIntentError);
      db.close();
    }
  });

  it("an intent persisted but not yet sent refuses a second attempt, before building and before signing", () => {
    const db = openDb(":memory:");
    const store = new IntentsStore(db);
    const first = store.reserve(reserveInput());
    store.markSigned(first, { signature: "SIG", signedTxB64: "AA==", lastValidBlockHeight: 100, expectedInRaw: "1", expectedOutRaw: "2", minOutRaw: "1" }, 2);
    // Before building: reserve() refuses.
    expect(() => store.reserve(reserveInput())).toThrow(DuplicateIntentError);
    // Before signing: an intent that is no longer 'pending' can't be signed again.
    expect(() => store.assertSoleUnresolved(first)).toThrow(DuplicateIntentError);
    db.close();
  });

  it("allows a new intent once the previous one is resolved (expired, failed, abandoned, applied)", () => {
    const db = openDb(":memory:");
    const store = new IntentsStore(db);
    for (const final of ["expired", "failed", "abandoned", "applied"] as const) {
      const id = store.reserve(reserveInput());
      store.resolve(id, final, 5);
      expect(store.hasUnresolved(sellRefKey(7), "sell")).toBe(false);
    }
    expect(() => store.reserve(reserveInput())).not.toThrow();
    db.close();
  });

  it("keys buys by mint, independently of sells", () => {
    const db = openDb(":memory:");
    const store = new IntentsStore(db);
    store.reserve(reserveInput({ kind: "buy", side: "buy", refKey: buyRefKey("M1"), positionId: null, mint: "M1" }));
    expect(() => store.reserve(reserveInput({ kind: "buy", side: "buy", refKey: buyRefKey("M1"), positionId: null, mint: "M1" }))).toThrow(DuplicateIntentError);
    expect(() => store.reserve(reserveInput({ kind: "buy", side: "buy", refKey: buyRefKey("M2"), positionId: null, mint: "M2" }))).not.toThrow();
    db.close();
  });

  it("persists signature, signed bytes, expiry height, expected amounts and payload", () => {
    const db = openDb(":memory:");
    const store = new IntentsStore(db);
    const id = store.reserve(reserveInput({ payload: { size: 25 } }));
    store.markSigned(id, { signature: "SIG", signedTxB64: "AQID", lastValidBlockHeight: 123, expectedInRaw: "1000", expectedOutRaw: "2000", minOutRaw: "1900" }, 2);
    const row = store.get(id)!;
    expect(row).toMatchObject({ status: "signed", signature: "SIG", signedTxB64: "AQID", lastValidBlockHeight: 123, expectedInRaw: "1000", expectedOutRaw: "2000", minOutRaw: "1900", payload: { size: 25 } });
    expect(store.listUnresolved("live").map((r) => r.id)).toEqual([id]);
    db.close();
  });
});

describe("live fields on positions, trades, shadows, safety cache; fee losses", () => {
  it("positions round-trip live fields and updateLive changes them", () => {
    const db = openDb(":memory:");
    const store = new PositionsStore(db);
    const id = store.insert(position({ tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", tokenAccount: "ATA", tokenAmountRaw: "123456789012345678", entrySignature: "SIG" }));
    const row = store.get(id)!;
    expect(row).toMatchObject({ tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", tokenAccount: "ATA", tokenAmountRaw: "123456789012345678", sellAttempts: 0, stuckState: null, closeAta: true });
    store.updateLive(id, { sellFailures: 3, stuckState: "stuck", stuckSince: 50, sellFeesLamports: 505_000, closeAta: false, tokenAmount: 99, tokenAmountRaw: "99000000" });
    expect(store.get(id)).toMatchObject({ sellFailures: 3, stuckState: "stuck", stuckSince: 50, sellFeesLamports: 505_000, closeAta: false, tokenAmount: 99, tokenAmountRaw: "99000000" });
    db.close();
  });

  it("paper positions get the live defaults", () => {
    const db = openDb(":memory:");
    const store = new PositionsStore(db);
    const id = store.insert(position({ mode: "paper" }));
    expect(store.get(id)).toMatchObject({ tokenAmountRaw: null, sellAttempts: 0, stuckState: null, closeAta: true });
    db.close();
  });

  it("trades store live fields and the proceeds_unknown flag; paper trades default to false", () => {
    const db = openDb(":memory:");
    const store = new TradesStore(db);
    const live = store.insert(trade({ proceedsUnknown: true, exitSignature: "XS", entryFeeLamports: 5100, rentPaidLamports: 2_039_280 }));
    const paper = store.insert(trade({ mode: "paper", exitReason: "target", proceeds: 30, netPnlUsd: 5 }));
    expect(store.get(live)).toMatchObject({ proceedsUnknown: true, exitSignature: "XS", entryFeeLamports: 5100, rentPaidLamports: 2_039_280 });
    expect(store.get(paper)!.proceedsUnknown).toBe(false);
    db.close();
  });

  it("shadows record their mode (default paper)", () => {
    const db = openDb(":memory:");
    const store = new ShadowsStore(db);
    const base = {
      mint: "M", symbol: null, pairAddress: null, outcome: "open" as const, entryTime: 1, costBasis: 1, tokenAmount: 1, entryLiquidityUsd: 1, entryPriceUsd: 1,
      score: null, scoreComponents: null, peakPnl: 0, currentTarget: 30, targetExtensions: 0, timerRestarts: 0, lastRestartAt: null, deadline: 2,
      trailArmed: false, fastStreak: 0, lowLiqStreak: 0, noRouteSince: null, exitTime: null, exitReason: null, proceeds: null, netPnlUsd: null, netPnlPct: null,
    };
    const a = store.insert(base);
    const b = store.insert({ ...base, mint: "N", mode: "live" });
    expect(store.getForMint("M", "paper")!.id).toBe(a);
    expect(store.getForMint("M", "paper")!.mode).toBe("paper");
    expect(store.getForMint("N", "live")!.id).toBe(b);
    expect(store.getForMint("N", "live")!.mode).toBe("live");
    expect(store.getForMint("M", "live")).toBeUndefined();
    db.close();
  });

  it("the safety cache stores the mint's token program and decimals", () => {
    const db = openDb(":memory:");
    const store = new SafetyCacheStore(db);
    store.set("M", { passed: true, reason: "ok" }, 1);
    expect(store.getMintInfo("M")).toBeUndefined();
    store.setMintInfo("M", { tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", decimals: 9 });
    expect(store.getMintInfo("M")).toEqual({ tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", decimals: 9 });
    db.close();
  });

  it("fee losses sum per mode and trading day", () => {
    const db = openDb(":memory:");
    const store = new FeeLossesStore(db);
    const base = { ts: 1, mint: "M", positionId: 1, intentId: 1, signature: "S", kind: "sell", lamports: 505_000, solPriceUsd: 150 };
    store.insert({ ...base, mode: "live", tradingDay: "2026-09-25", usd: 0.07575 });
    store.insert({ ...base, mode: "live", tradingDay: "2026-09-25", usd: 0.1 });
    store.insert({ ...base, mode: "live", tradingDay: "2026-09-24", usd: 5 });
    store.insert({ ...base, mode: "paper", tradingDay: "2026-09-25", usd: 9 });
    expect(store.sumUsdForDay("live", "2026-09-25")).toBeCloseTo(0.17575, 9);
    expect(store.sumUsdForDay("paper", "2026-09-25")).toBe(9);
    db.close();
  });
});
