import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DexScreenerClient } from "../../src/clients/dexscreener.js";
import { recheckPending } from "../../src/discovery/index.js";
import { PendingStore } from "../../src/discovery/pendingStore.js";
import { SlidingWindowLimiter } from "../../src/limiters/slidingWindow.js";
import { createMemoryLogger } from "../../src/logger/index.js";
import { openDb, runMigrations } from "../../src/storage/db.js";
import { ShadowsStore } from "../../src/storage/shadows.js";
import { createShadowOnReady, type ShadowCreationConfig } from "../../src/tracking/shadowCreation.js";
import type { DexPair } from "../../src/types.js";

const MIGRATIONS = fileURLToPath(new URL("../../src/storage/migrations", import.meta.url));
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const CFG: ShadowCreationConfig = {
  enabled: true,
  mode: "paper",
  maxOpen: 30,
  positionUsd: 25,
  maxPositionPctOfLiq: 1,
  targetProfitPct: 30,
  holdMinutes: 15,
  cost: { poolFeePct: 1, extraSlippagePct: 2, feeUsdPerTx: 0.05 },
};

function pair(mint: string): DexPair {
  return {
    chainId: "solana",
    pairAddress: `${mint}-pair`,
    baseToken: { address: mint, symbol: mint },
    quoteToken: { address: USDC },
    priceUsd: "0.001",
    liquidity: { usd: 20_000 },
    priceChange: { m5: 5, h1: 10, h24: 20 },
    txns: { m5: { buys: 8, sells: 4 } },
    volume: { m5: 2000 },
  } as DexPair;
}

describe("one shadow per mint (SPEC.md section 11.2)", () => {
  it("a mint that becomes READY, drops back to pending, and becomes READY again gets exactly one shadow", async () => {
    const db = openDb(":memory:");
    const pending = new PendingStore(db);
    const shadows = new ShadowsStore(db);
    pending.addPending("MINT1", 0);

    const dexClient = new DexScreenerClient({
      profilesLimiter: new SlidingWindowLimiter(1000, 60_000),
      pairsLimiter: new SlidingWindowLimiter(1000, 60_000),
      logger: createMemoryLogger(),
      fetchImpl: (async () => new Response(JSON.stringify([pair("MINT1")]), { status: 200 })) as unknown as typeof fetch,
    });
    const onNewlyReady = vi.fn((mint: string, p: DexPair) => createShadowOnReady(shadows, CFG, mint, p, now, () => {}));
    // Holders passes, then fails (back to pending), then passes again (READY again).
    const getHolders = vi
      .fn()
      .mockResolvedValueOnce({ passed: true, reason: "ok", top1Pct: 5, top10Pct: 20 })
      .mockResolvedValueOnce({ passed: false, reason: "top10 too high", top1Pct: 5, top10Pct: 60 })
      .mockResolvedValueOnce({ passed: true, reason: "ok", top1Pct: 5, top10Pct: 20 });
    const phase2 = {
      momentumBuyPressureCfg: { minM5ChangePct: 0, minH1ChangePct: 0, minH24ChangePct: 0, maxH1ChangePct: 0, minM5Txns: 10, minM5BuySellRatio: 1, minM5VolumeUsd: 1000 },
      getMintSafety: vi.fn().mockResolvedValue({ passed: true, reason: "ok" }),
      getHolders,
      computeSnapshot: () => ({ score: 0.7, snapshotJson: "{}" }),
      onNewlyReady,
    };
    const opts = { dexClient, store: pending, allowedQuoteMints: [USDC], minLiquidityUsd: 10_000, entryWindowMin: 15, maxPendingAgeMin: 180, maxNoPairChecks: 3, reentryEnabled: false, logger: createMemoryLogger(), phase2 };

    let now = 1000;
    await recheckPending({ ...opts, now });
    expect(pending.listReady().map((r) => r.mint)).toEqual(["MINT1"]);
    now = 2000;
    await recheckPending({ ...opts, now });
    expect(pending.listReady()).toEqual([]); // dropped back to pending
    now = 3000;
    await recheckPending({ ...opts, now });

    expect(onNewlyReady).toHaveBeenCalledTimes(2); // the root cause: discovery reports each pending -> READY transition
    expect(onNewlyReady.mock.results.map((r) => r.value)).toEqual(["created", "exists"]);
    const all = shadows.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ mint: "MINT1", mode: "paper", entryTime: 1000 }); // created at the first READY
  });

  it("stays one shadow when the first one has already closed before the mint is READY again", () => {
    const shadows = new ShadowsStore(openDb(":memory:"));
    expect(createShadowOnReady(shadows, CFG, "MINT1", pair("MINT1"), 1000, () => {})).toBe("created");
    shadows.update(shadows.listAll()[0]!.id, { outcome: "closed", exitTime: 5000, exitReason: "stop", proceeds: 20, netPnlUsd: -5.05, netPnlPct: -20 });
    expect(createShadowOnReady(shadows, CFG, "MINT1", pair("MINT1"), 9000, () => {})).toBe("exists");
    expect(shadows.listAll()).toHaveLength(1);
  });

  it("paper and live each get their own shadow for the same mint", () => {
    const shadows = new ShadowsStore(openDb(":memory:"));
    expect(createShadowOnReady(shadows, CFG, "MINT1", pair("MINT1"), 1000, () => {})).toBe("created");
    expect(createShadowOnReady(shadows, { ...CFG, mode: "live" }, "MINT1", pair("MINT1"), 2000, () => {})).toBe("created");
    expect(shadows.listAll().map((s) => s.mode)).toEqual(["paper", "live"]);
  });

  it("cap rule (a): a first READY skipped for the cap gets its shadow at a later READY with room; a mint with a shadow never counts as skipped", () => {
    const shadows = new ShadowsStore(openDb(":memory:"));
    const onCapSkip = vi.fn();
    const oneSlot = { ...CFG, maxOpen: 1 };
    expect(createShadowOnReady(shadows, oneSlot, "FIRST", pair("FIRST"), 1000, onCapSkip)).toBe("created");
    expect(createShadowOnReady(shadows, oneSlot, "MINT2", pair("MINT2"), 2000, onCapSkip)).toBe("cap");
    expect(createShadowOnReady(shadows, oneSlot, "FIRST", pair("FIRST"), 2500, onCapSkip)).toBe("exists"); // at the cap, but not a skip
    expect(onCapSkip).toHaveBeenCalledTimes(1);

    shadows.update(shadows.getForMint("FIRST", "paper")!.id, { outcome: "closed" }); // room again
    expect(createShadowOnReady(shadows, oneSlot, "MINT2", pair("MINT2"), 3000, onCapSkip)).toBe("created");
    expect(shadows.getForMint("MINT2", "paper")!.entryTime).toBe(3000);
  });
});

describe("two processes racing on the same mint (unique index on mint and mode)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-shadow-race-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("only one row lands, even when both processes saw no shadow yet", () => {
    const dbPath = path.join(dir, "trader.db");
    const dbA = openDb(dbPath);
    const dbB = openDb(dbPath);
    try {
      const a = new ShadowsStore(dbA);
      const b = new ShadowsStore(dbB);
      // Both "processes" have already passed the existence check (the 123/124 case): force it to miss.
      const raced = Object.assign(Object.create(Object.getPrototypeOf(b)) as ShadowsStore, b, { getForMint: () => undefined });
      expect(createShadowOnReady(a, CFG, "BjTy", pair("BjTy"), 1_790_342_540_816, () => {})).toBe("created");
      expect(createShadowOnReady(raced, CFG, "BjTy", pair("BjTy"), 1_790_342_541_981, () => {})).toBe("exists");
      expect(new ShadowsStore(dbA).listAll()).toHaveLength(1);
      expect(() => b.insert({ ...a.listAll()[0]!, entryTime: 5 })).toThrow(/UNIQUE constraint failed/);
    } finally {
      dbA.close();
      dbB.close();
    }
  });
});

describe("migration 0007_shadow_one_per_mint", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-mig7-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("keeps the earliest shadow per mint and mode, marks the rest duplicate_of it, carries unsellable/selected, and then enforces one per mint", () => {
    for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f < "0007")) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
    const db = new Database(":memory:");
    runMigrations(db, dir);
    expect(db.pragma("user_version", { simple: true })).toBe(6);

    const insert = db.prepare(
      `INSERT INTO shadows (id, mint, mode, outcome, entry_time, cost_basis, token_amount, entry_liquidity_usd, entry_price_usd, current_target, deadline)
       VALUES (?, ?, ?, ?, ?, 25.05, 1000, 20000, 0.001, 30, 999999)`,
    );
    const rows: Array<[number, string, string, string, number]> = [
      [1, "A", "paper", "closed", 100], // kept
      [2, "A", "paper", "closed", 200],
      [3, "A", "paper", "open", 300], //   an open duplicate: must vanish from the poll and the cap
      [4, "B", "paper", "closed", 500], // kept: tie on entry_time, lower id wins
      [5, "B", "paper", "closed", 500],
      [6, "B", "live", "open", 600], //    kept: its own mode
      [7, "C", "paper", "closed", 700], // kept, becomes unsellable (like shadows 46/47)
      [8, "C", "paper", "unsellable", 710],
      [9, "D", "paper", "closed", 800], // kept, becomes selected
      [10, "D", "paper", "selected", 810],
      [11, "E", "paper", "closed", 900], // kept, unsellable wins over selected
      [12, "E", "paper", "selected", 910],
      [13, "E", "paper", "unsellable", 920],
      [14, "F", "paper", "closed", 1100], // entry order differs from id order: 15 is earlier
      [15, "F", "paper", "closed", 1000], // kept
      [16, "G", "paper", "open", 1200], //  no duplicates: untouched
    ];
    for (const r of rows) insert.run(...r);

    runMigrations(db, MIGRATIONS); // applies 0007
    expect(db.pragma("user_version", { simple: true })).toBe(7);

    const after = db.prepare("SELECT id, outcome, duplicate_of FROM shadows ORDER BY id").all() as Array<{ id: number; outcome: string; duplicate_of: number | null }>;
    expect(after.map((r) => [r.id, r.duplicate_of])).toEqual([
      [1, null], [2, 1], [3, 1], [4, null], [5, 4], [6, null], [7, null], [8, 7], [9, null], [10, 9], [11, null], [12, 11], [13, 11], [14, 15], [15, null], [16, null],
    ]);
    const outcome = (id: number) => after.find((r) => r.id === id)!.outcome;
    expect([outcome(7), outcome(9), outcome(11)]).toEqual(["unsellable", "selected", "unsellable"]);
    expect([outcome(1), outcome(4), outcome(15)]).toEqual(["closed", "closed", "closed"]); // no classification to carry: unchanged
    expect([outcome(2), outcome(3), outcome(8), outcome(13)]).toEqual(["closed", "open", "unsellable", "unsellable"]); // duplicates keep their own data

    const store = new ShadowsStore(db);
    expect(store.listAll().map((s) => s.id)).toEqual([1, 4, 6, 7, 9, 11, 15, 16]);
    expect(store.listOpen().map((s) => s.id)).toEqual([6, 16]); // open duplicate 3 is gone from the poll
    expect(store.countOpen()).toBe(2);
    expect(store.getOpenByMint("A")).toBeUndefined();
    expect(store.getForMint("E", "paper")!.id).toBe(11);
    expect(store.get(3)!.duplicateOf).toBe(1); // still readable by id

    expect(store.insertIfAbsent({ ...store.get(1)!, entryTime: 9999 })).toBeNull();
    expect(() => store.insert({ ...store.get(1)!, entryTime: 9999 })).toThrow(/UNIQUE constraint failed/);
    expect(store.insertIfAbsent({ ...store.get(1)!, mint: "NEW", entryTime: 9999 })).not.toBeNull();
    db.close();
  });
});
