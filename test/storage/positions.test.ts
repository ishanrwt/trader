import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PositionsStore, positionRowToExitState, type NewPositionRow } from "../../src/storage/positions.js";
import { openDb } from "../../src/storage/db.js";
import { step, type ExitStateMachineConfig } from "../../src/monitor/stateMachine.js";

function newRow(overrides: Partial<NewPositionRow> = {}): NewPositionRow {
  return {
    mode: "paper",
    mint: "MINT1",
    symbol: "FOO",
    pairAddress: "pair1",
    status: "open",
    entryTime: 1000,
    sizeUsd: 25,
    tokenAmount: 1000,
    costBasis: 25.05,
    entryLiquidityUsd: 20_000,
    entryPairSnapshot: { liquidityUsd: 20_000 },
    score: 0.6,
    scoreComponents: { buyPressure: 0.5, activity: 0.5, momentum: 0.5, depth: 0.5, holders: 0.5, freshness: 0.5 },
    safetyResult: { passed: true },
    holdersResult: { passed: true, top1Pct: 5, top10Pct: 20 },
    peakPnl: 0,
    currentTarget: 30,
    targetExtensions: 0,
    timerRestarts: 0,
    lastRestartAt: null,
    deadline: 1_000_000,
    trailArmed: false,
    fastStreak: 0,
    lowLiqStreak: 0,
    noRouteSince: null,
    closingSince: null,
    pendingExitReason: null,
    lastPnlPct: null,
    lastValueUsd: null,
    lastPolledAt: null,
    tokenDecimals: null,
    entryValuationPnlPct: null,
    entryQuoteInAmount: null,
    entryQuoteOutAmount: null,
    ...overrides,
  };
}

describe("PositionsStore", () => {
  it("inserts and round-trips a row, including JSON fields and booleans", () => {
    const store = new PositionsStore(openDb(":memory:"));
    const id = store.insert(newRow());
    const row = store.get(id)!;
    expect(row.mint).toBe("MINT1");
    expect(row.entryPairSnapshot).toEqual({ liquidityUsd: 20_000 });
    expect(row.trailArmed).toBe(false);
  });

  it("round-trips the entry-valuation and raw-quote-amount fields, including a negative pnlPct and null (quote failed)", () => {
    const store = new PositionsStore(openDb(":memory:"));
    const id = store.insert(newRow({ tokenDecimals: 6, entryValuationPnlPct: -3.2, entryQuoteInAmount: "25000000", entryQuoteOutAmount: "68306482910" }));
    const row = store.get(id)!;
    expect(row.tokenDecimals).toBe(6);
    expect(row.entryValuationPnlPct).toBe(-3.2);
    expect(row.entryQuoteInAmount).toBe("25000000");
    expect(row.entryQuoteOutAmount).toBe("68306482910");

    const id2 = store.insert(newRow({ mint: "MINT2", tokenDecimals: null, entryValuationPnlPct: null, entryQuoteInAmount: null, entryQuoteOutAmount: null }));
    const row2 = store.get(id2)!;
    expect(row2.tokenDecimals).toBeNull();
    expect(row2.entryValuationPnlPct).toBeNull();
  });

  it("update() never touches the write-once entry-valuation/raw-quote fields", () => {
    const store = new PositionsStore(openDb(":memory:"));
    const id = store.insert(newRow({ entryValuationPnlPct: -3.2 }));
    store.update(id, { peakPnl: 10 });
    expect(store.get(id)!.entryValuationPnlPct).toBe(-3.2);
  });

  it("lists open vs closing positions separately", () => {
    const store = new PositionsStore(openDb(":memory:"));
    store.insert(newRow({ mint: "A", status: "open" }));
    store.insert(newRow({ mint: "B", status: "closing" }));
    expect(store.listOpen().map((r) => r.mint)).toEqual(["A"]);
    expect(store.listClosing().map((r) => r.mint)).toEqual(["B"]);
  });

  it("update patches fields and preserves booleans/JSON correctly", () => {
    const store = new PositionsStore(openDb(":memory:"));
    const id = store.insert(newRow());
    store.update(id, { trailArmed: true, peakPnl: 12.5, status: "closing" });
    const row = store.get(id)!;
    expect(row.trailArmed).toBe(true);
    expect(row.peakPnl).toBe(12.5);
    expect(row.status).toBe("closing");
  });

  it("appends and loads history, filtering by sinceT", () => {
    const store = new PositionsStore(openDb(":memory:"));
    const id = store.insert(newRow());
    store.appendHistory(id, { t: 1000, pnl: 0 });
    store.appendHistory(id, { t: 2000, pnl: 5 });
    store.appendHistory(id, { t: 3000, pnl: 10 });
    expect(store.loadHistory(id, 0)).toEqual([
      { t: 1000, pnl: 0 },
      { t: 2000, pnl: 5 },
      { t: 3000, pnl: 10 },
    ]);
    expect(store.loadHistory(id, 2000)).toEqual([
      { t: 2000, pnl: 5 },
      { t: 3000, pnl: 10 },
    ]);
  });

  it("removing a position also removes its history", () => {
    const store = new PositionsStore(openDb(":memory:"));
    const id = store.insert(newRow());
    store.appendHistory(id, { t: 1000, pnl: 0 });
    store.remove(id);
    expect(store.get(id)).toBeUndefined();
    expect(store.loadHistory(id, 0)).toEqual([]);
  });

  it("positionRowToExitState reconstructs a valid ExitState for the pure state machine", () => {
    const store = new PositionsStore(openDb(":memory:"));
    const id = store.insert(newRow({ deadline: 5000, currentTarget: 40 }));
    const row = store.get(id)!;
    const state = positionRowToExitState(row, [{ t: 1000, pnl: 0 }]);
    expect(state.deadline).toBe(5000);
    expect(state.currentTarget).toBe(40);
    expect(state.history).toEqual([{ t: 1000, pnl: 0 }]);
  });

  describe("the -Infinity peakPnl sentinel survives a real file-based restart", () => {
    const CFG: ExitStateMachineConfig = {
      stopLossPct: 15,
      extraTargetPct: 10,
      maxTargetExtensions: 1,
      holdMinutes: 15,
      fastGainPct: 15,
      fastWindowMinutes: 5,
      fastMinHistorySec: 60,
      fastConfirmPolls: 2,
      maxTimerRestarts: 3,
      maxTotalHoldMinutes: 60,
      trailPct: 4,
      breakevenTriggerPct: 20,
      breakevenFloorPct: 2,
      flatBandPct: 3,
      liqDropExitPct: 30,
      liqDropConfirmReads: 2,
      noRouteExitSec: 30,
    };

    it("round-trips through an actual on-disk database, and Math.max still takes the first real poll's value after a simulated process restart", () => {
      // A real file, not :memory: — :memory: is destroyed on close, so it can't
      // actually simulate "the process died and a new one opened the same file."
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-peakpnl-restart-"));
      const dbPath = path.join(dir, "trader.db");
      try {
        // Process 1: opens the position with no entry valuation (the quote-failure
        // fallback) — peakPnl = -Infinity, no history point recorded.
        const db1 = openDb(dbPath);
        const store1 = new PositionsStore(db1);
        const id = store1.insert(newRow({ peakPnl: Number.NEGATIVE_INFINITY, deadline: 900_000 }));
        expect(store1.loadHistory(id, 0)).toEqual([]); // nothing recorded yet, as the fallback intends
        db1.close();

        // Process 2 ("after a restart"): a fresh Database connection to the same file.
        const db2 = openDb(dbPath);
        const store2 = new PositionsStore(db2);
        const row = store2.get(id)!;

        // The crux of the concern: peakPnl must still be exactly -Infinity here, not
        // null (which a JSON round-trip would silently produce, per JSON.stringify(-Infinity) === "null").
        expect(row.peakPnl).toBe(Number.NEGATIVE_INFINITY);
        expect(Number.isNaN(row.peakPnl)).toBe(false);

        const history = store2.loadHistory(id, 0);
        expect(history).toEqual([]);
        const state = positionRowToExitState(row, history);
        expect(state.peakPnl).toBe(Number.NEGATIVE_INFINITY);

        // The first poll after the restart: if peakPnl had silently become null/0
        // (the JSON-coercion failure mode), Math.max(0, -8) would wrongly floor the
        // peak at 0. With the real -Infinity carried through, it correctly becomes -8.
        const result = step(state, { now: 1000, pnlPct: -8 }, CFG);
        expect(result.newState.peakPnl).toBe(-8);
        db2.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
