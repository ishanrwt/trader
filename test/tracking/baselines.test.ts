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
import { skipReasonStats } from "../../src/report/index.js";
import { openDb, runMigrations } from "../../src/storage/db.js";
import { PostExitTracksStore } from "../../src/storage/postExitTracks.js";
import { dexPriceAtExit } from "../../src/tracking/exitPrice.js";
import type { DexPair } from "../../src/types.js";

const MIGRATIONS = fileURLToPath(new URL("../../src/storage/migrations", import.meta.url));
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const pair = (mint: string, priceUsd?: string): DexPair =>
  ({ chainId: "solana", pairAddress: `${mint}-p`, baseToken: { address: mint }, quoteToken: { address: USDC }, liquidity: { usd: 20_000 }, ...(priceUsd ? { priceUsd } : {}) }) as DexPair;

function client(pairs: DexPair[]) {
  return new DexScreenerClient({
    profilesLimiter: new SlidingWindowLimiter(1000, 60_000),
    pairsLimiter: new SlidingWindowLimiter(1000, 60_000),
    logger: createMemoryLogger(),
    fetchImpl: (async () => new Response(JSON.stringify(pairs), { status: 200 })) as unknown as typeof fetch,
  });
}
const OPTS = { allowedQuoteMints: [USDC], minLiquidityUsd: 10_000, entryWindowMin: 15, maxPendingAgeMin: 180, maxNoPairChecks: 1, reentryEnabled: false, logger: createMemoryLogger() };

describe("skip-track baseline (section 11.3)", () => {
  it("each skip carries the DexScreener price from that recheck's batch and the mint's real discovery time; a pair skip has no price", async () => {
    const store = new PendingStore(openDb(":memory:"));
    const now = 200 * 60_000;
    store.addPending("AGED", 5_000); //                  older than maxPendingAgeMin (180 min)
    store.addPending("LATE", now - 60 * 60_000); //      first eligible 30 min ago: outside the 15-min entry window
    store.updatePending("LATE", { firstEligibleAt: now - 30 * 60_000 });
    store.addPending("NOPAIR", now - 10 * 60_000); //    no pair in the batch
    const result = await recheckPending({ dexClient: client([pair("AGED", "0.0021"), pair("LATE", "0.5")]), store, now, ...OPTS });

    expect(result.removedNeverReady).toEqual(
      expect.arrayContaining([
        { mint: "AGED", reason: "aged_out", priceUsd: 0.0021, discoveredAt: 5_000 },
        { mint: "LATE", reason: "entryWindow", priceUsd: 0.5, discoveredAt: now - 60 * 60_000 },
        { mint: "NOPAIR", reason: "pair", priceUsd: null, discoveredAt: now - 10 * 60_000 },
      ]),
    );
    expect(result.removedNeverReady).toHaveLength(3);
  });

  it("a pair without a positive priceUsd gives no baseline", async () => {
    const store = new PendingStore(openDb(":memory:"));
    store.addPending("AGED", 0);
    const result = await recheckPending({ dexClient: client([pair("AGED")]), store, now: 200 * 60_000, ...OPTS });
    expect(result.removedNeverReady).toEqual([{ mint: "AGED", reason: "aged_out", priceUsd: null, discoveredAt: 0 }]);
  });

  it("skip stats use only rows with a baseline and say how many have one", () => {
    const [stat] = skipReasonStats([
      { skipReason: "aged_out", priceAtSkipUsd: 1, price15mUsd: 1.1, price60mUsd: 0.8 },
      { skipReason: "aged_out", priceAtSkipUsd: null, price15mUsd: 5, price60mUsd: 5 }, // before the fix: no baseline
    ]);
    expect(stat).toMatchObject({ reason: "aged_out", count: 2, withBaseline: 1 });
    expect(stat!.median15mPctChange).toBeCloseTo(10, 10);
    expect(stat!.median60mPctChange).toBeCloseTo(-20, 10);
  });
});

describe("post-exit baseline: DexScreener price at exit (section 11.3)", () => {
  const logger = createMemoryLogger();

  it("returns the selected pair's priceUsd", async () => {
    await expect(dexPriceAtExit(async () => [pair("M", "0.00002917")], "M", [USDC], logger)).resolves.toBe(0.00002917);
  });

  it("returns null when the fetch fails, the mint has no valid pair, or the price isn't positive", async () => {
    await expect(dexPriceAtExit(async () => { throw new Error("timeout"); }, "M", [USDC], logger)).resolves.toBeNull();
    await expect(dexPriceAtExit(async () => [pair("OTHER", "1")], "M", [USDC], logger)).resolves.toBeNull();
    await expect(dexPriceAtExit(async () => [pair("M", "0")], "M", [USDC], logger)).resolves.toBeNull();
    await expect(dexPriceAtExit(async () => [pair("M")], "M", [USDC], logger)).resolves.toBeNull();
  });

  it("asks for exactly the exited mint", async () => {
    const getPairs = vi.fn().mockResolvedValue([pair("M", "2")]);
    await dexPriceAtExit(getPairs, "M", [USDC], logger);
    expect(getPairs).toHaveBeenCalledWith(["M"]);
  });
});

describe("migration 0009_post_exit_price_source", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-mig9-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("marks every existing post-exit track as 'entry_snapshot'; new rows record their own source", () => {
    for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f < "0009")) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
    const db = new Database(":memory:");
    runMigrations(db, dir);
    db.prepare(
      `INSERT INTO trades (id, mode, mint, entry_time, exit_time, size_usd, cost_basis, proceeds, net_pnl_usd, net_pnl_pct, exit_reason,
         peak_pnl, timer_restarts, target_extensions, fees_usd, trading_day)
       VALUES (1, 'paper', 'M', 1, 2, 25, 25.05, 20, -5, -20, 'stop', 0, 0, 0, 0.1, '2026-09-25')`,
    ).run();
    db.prepare("INSERT INTO post_exit_tracks (trade_id, mint, exit_time, exit_price_usd, resolved) VALUES (1, 'M', 2, 0.00007067, 0)").run();

    runMigrations(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(9);
    const store = new PostExitTracksStore(db);
    expect(store.listAll()[0]).toMatchObject({ exitPriceUsd: 0.00007067, exitPriceSource: "entry_snapshot" });
    store.insert({ tradeId: 1, mint: "M", exitTime: 3, exitPriceUsd: 0.000005, exitPriceSource: "dexscreener_at_exit" });
    expect(store.listAll().map((r) => r.exitPriceSource)).toEqual(["entry_snapshot", "dexscreener_at_exit"]);
    db.close();
  });
});
