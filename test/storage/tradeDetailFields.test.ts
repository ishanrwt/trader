import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/storage/db.js";
import { PositionsStore, type NewPositionRow } from "../../src/storage/positions.js";
import { TradesStore, type NewTradeRow } from "../../src/storage/trades.js";

const MIGRATIONS = fileURLToPath(new URL("../../src/storage/migrations", import.meta.url));

function position(overrides: Partial<NewPositionRow> = {}): NewPositionRow {
  return {
    mode: "paper", mint: "MINT", symbol: "SYM", pairAddress: "PAIR", status: "open", entryTime: 1000, sizeUsd: 25, tokenAmount: 100, costBasis: 25.05,
    entryLiquidityUsd: 20_000, entryPairSnapshot: { dexId: "pumpswap" }, score: 0.5, scoreComponents: null, safetyResult: null, holdersResult: null,
    peakPnl: 0, currentTarget: 30, targetExtensions: 0, timerRestarts: 0, lastRestartAt: null, deadline: 100_000, trailArmed: false, fastStreak: 0,
    lowLiqStreak: 0, noRouteSince: null, closingSince: null, pendingExitReason: null, lastPnlPct: null, lastValueUsd: null, lastPolledAt: null,
    tokenDecimals: 6, entryValuationPnlPct: null, entryQuoteInAmount: null, entryQuoteOutAmount: null,
    ...overrides,
  };
}

function trade(overrides: Partial<NewTradeRow> = {}): NewTradeRow {
  return {
    mode: "paper", mint: "MINT", symbol: "SYM", pairAddress: "PAIR", entryTime: 1000, exitTime: 2000, sizeUsd: 25, costBasis: 25.05, proceeds: 20,
    netPnlUsd: -5.05, netPnlPct: -20.16, exitReason: "stop", peakPnl: 1, timerRestarts: 0, targetExtensions: 0, feesUsd: 0.1, entryPairSnapshot: null,
    top1Pct: 5, top10Pct: 20, score: 0.5, scoreComponents: null, animalFlag: null, tradingDay: "2026-09-25", tokenAmount: 100, tokenDecimals: 6,
    entryValuationPnlPct: -3, entryQuoteInAmount: null, entryQuoteOutAmount: null, exitQuoteInAmount: null, exitQuoteOutAmount: null,
    ...overrides,
  };
}

describe("migration 0005_trade_detail", () => {
  it("backfills dex_id from the stored snapshot on every pre-migration trade and position; the never-recorded fields stay NULL", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-mig5-"));
    try {
      for (const f of ["0001_init.sql", "0002_phase2.sql", "0003_trade_history_and_quotes.sql", "0004_live.sql"]) {
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
      }
      const db = new Database(":memory:");
      runMigrations(db, dir);
      expect(db.pragma("user_version", { simple: true })).toBe(4);

      const insertTrade = db.prepare(
        `INSERT INTO trades (mode, mint, entry_time, exit_time, size_usd, cost_basis, proceeds, net_pnl_usd, net_pnl_pct, exit_reason,
          peak_pnl, timer_restarts, target_extensions, fees_usd, entry_pair_snapshot, trading_day)
         VALUES ('paper', ?, 1, 2, 25, 25.05, 20, -5, -20, 'stop', 0, 0, 0, 0.1, ?, '2026-09-25')`,
      );
      insertTrade.run("A", JSON.stringify({ dexId: "pumpswap", liquidity: { usd: 1 } }));
      insertTrade.run("B", JSON.stringify({ dexId: "raydium" }));
      insertTrade.run("C", JSON.stringify({ liquidity: { usd: 1 } })); // snapshot without a dexId
      insertTrade.run("D", null); // no snapshot at all
      db.prepare(
        `INSERT INTO positions (mode, mint, entry_time, size_usd, token_amount, cost_basis, entry_liquidity_usd, entry_pair_snapshot, current_target, deadline)
         VALUES ('paper', 'P', 1, 25, 100, 25.05, 20000, ?, 30, 100000)`,
      ).run(JSON.stringify({ dexId: "meteora" }));

      runMigrations(db); // applies 0005
      expect(db.pragma("user_version", { simple: true })).toBe(5);

      const trades = new TradesStore(db).listAll();
      expect(trades.map((t) => [t.mint, t.dexId])).toEqual([
        ["A", "pumpswap"],
        ["B", "raydium"],
        ["C", null],
        ["D", null],
      ]);
      for (const t of trades) {
        expect(t.sellabilityLossPct).toBeNull();
        expect(t.sellabilityCheckedAt).toBeNull();
        expect(t.stopPollPnlPct).toBeNull();
        expect(t.stopConfirmPnlPct).toBeNull();
      }
      expect(new PositionsStore(db).listOpen()[0]!.dexId).toBe("meteora");

      // Every pre-migration row whose snapshot has a dexId got it: none left behind.
      const missed = db
        .prepare("SELECT COUNT(*) AS n FROM trades WHERE dex_id IS NULL AND json_extract(entry_pair_snapshot, '$.dexId') IS NOT NULL")
        .get() as { n: number };
      expect(missed.n).toBe(0);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("detail fields on positions and trades", () => {
  it("positions: insert round-trips sellability and dexId, which default to null when omitted", () => {
    const store = new PositionsStore(openDb(":memory:"));
    const withDetail = store.get(store.insert(position({ sellabilityLossPct: 3.25, sellabilityCheckedAt: 999, dexId: "pumpswap" })))!;
    expect(withDetail).toMatchObject({ sellabilityLossPct: 3.25, sellabilityCheckedAt: 999, dexId: "pumpswap", stopPollPnlPct: null, stopConfirmPnlPct: null });
    const without = store.get(store.insert(position({ mint: "OTHER" })))!;
    expect(without).toMatchObject({ sellabilityLossPct: null, sellabilityCheckedAt: null, dexId: null });
  });

  it("positions: update() sets the stop poll/confirmation values (including a null no-route confirmation) and leaves sellability untouched", () => {
    const store = new PositionsStore(openDb(":memory:"));
    const id = store.insert(position({ sellabilityLossPct: 3.25, sellabilityCheckedAt: 999, dexId: "pumpswap" }));
    store.update(id, { status: "closing", pendingExitReason: "stop", stopPollPnlPct: -16.4, stopConfirmPnlPct: null });
    expect(store.get(id)).toMatchObject({ status: "closing", stopPollPnlPct: -16.4, stopConfirmPnlPct: null, sellabilityLossPct: 3.25, dexId: "pumpswap" });
    store.update(id, { stopConfirmPnlPct: -17.02 });
    expect(store.get(id)!.stopConfirmPnlPct).toBe(-17.02);
  });

  it("trades: insert round-trips all five detail fields, which default to null when omitted", () => {
    const store = new TradesStore(openDb(":memory:"));
    const full = store.get(
      store.insert(trade({ sellabilityLossPct: 3.25, sellabilityCheckedAt: 999, dexId: "raydium", stopPollPnlPct: -16.4, stopConfirmPnlPct: -17.02 })),
    )!;
    expect(full).toMatchObject({ sellabilityLossPct: 3.25, sellabilityCheckedAt: 999, dexId: "raydium", stopPollPnlPct: -16.4, stopConfirmPnlPct: -17.02 });
    const bare = store.get(store.insert(trade({ exitReason: "target" })))!;
    expect(bare).toMatchObject({ sellabilityLossPct: null, sellabilityCheckedAt: null, dexId: null, stopPollPnlPct: null, stopConfirmPnlPct: null });
  });
});
