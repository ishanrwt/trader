import { describe, expect, it, vi } from "vitest";
import { DexScreenerClient } from "../../src/clients/dexscreener.js";
import { pollProfiles, recheckPending } from "../../src/discovery/index.js";
import { PendingStore } from "../../src/discovery/pendingStore.js";
import { SlidingWindowLimiter } from "../../src/limiters/slidingWindow.js";
import { createMemoryLogger } from "../../src/logger/index.js";
import { openDb } from "../../src/storage/db.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ALLOWED_QUOTE_MINTS = [USDC];

function jsonOnce(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  return new DexScreenerClient({
    profilesLimiter: new SlidingWindowLimiter(1000, 60_000),
    pairsLimiter: new SlidingWindowLimiter(1000, 60_000),
    logger: createMemoryLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

function pairFor(mint: string, liquidityUsd: number) {
  return {
    chainId: "solana",
    pairAddress: `${mint}-pair`,
    baseToken: { address: mint },
    quoteToken: { address: USDC },
    liquidity: { usd: liquidityUsd },
  };
}

describe("pollProfiles", () => {
  it("queues new Solana mints and skips already-seen and non-Solana ones", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonOnce([
        { chainId: "solana", tokenAddress: "NEW1" },
        { chainId: "solana", tokenAddress: "SEEN1" },
        { chainId: "ethereum", tokenAddress: "ETH1" },
      ]),
    );
    const db = openDb(":memory:");
    const store = new PendingStore(db);
    store.markSeen("SEEN1", 0, 5000);

    const result = await pollProfiles({
      dexClient: makeClient(fetchImpl),
      store,
      now: 1000,
      seenMintsCap: 5000,
      logger: createMemoryLogger(),
    });

    expect(result).toEqual({ discovered: 1, skippedSeen: 1, skippedOtherChain: 1, ok: true });
    expect(store.countPending()).toBe(1);
    expect(store.hasSeen("NEW1")).toBe(true);
  });

  it("never throws when the profile fetch fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));
    const db = openDb(":memory:");
    const store = new PendingStore(db);
    const result = await pollProfiles({
      dexClient: makeClient(fetchImpl),
      store,
      now: 1000,
      seenMintsCap: 5000,
      logger: createMemoryLogger(),
    });
    expect(result.discovered).toBe(0);
    expect(result.ok).toBe(false);
  });
});

describe("recheckPending", () => {
  const baseOpts = {
    allowedQuoteMints: ALLOWED_QUOTE_MINTS,
    minLiquidityUsd: 10_000,
    entryWindowMin: 15,
    maxPendingAgeMin: 180,
    maxNoPairChecks: 3,
    reentryEnabled: false,
    logger: createMemoryLogger(),
  };

  it("keeps a mint pending (never READY) once it clears checks 1-4, and records firstEligibleAt", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonOnce([pairFor("MINT1", 20_000)]));
    const db = openDb(":memory:");
    const store = new PendingStore(db);
    store.addPending("MINT1", 0);

    const result = await recheckPending({ dexClient: makeClient(fetchImpl), store, now: 1000, ...baseOpts });

    expect(result).toMatchObject({ checked: 1, passed: 1, removedPermanent: 0, removedAged: 0 });
    const row = store.listPending()[0]!;
    expect(row.status).toBe("pending"); // Phase 1 has no READY state
    expect(row.firstEligibleAt).toBe(1000);
    expect(row.lastGateResult).toBe("passed");
  });

  it("removes a mint after MAX_NO_PAIR_CHECKS consecutive no-pair checks", async () => {
    const db = openDb(":memory:");
    const store = new PendingStore(db);
    store.addPending("MINT1", 0);

    for (let i = 0; i < 3; i++) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonOnce([]));
      await recheckPending({ dexClient: makeClient(fetchImpl), store, now: 1000 + i, ...baseOpts });
    }

    expect(store.countPending()).toBe(0);
  });

  it("removes a mint once MAX_PENDING_AGE_MIN has passed since discovery", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonOnce([pairFor("MINT1", 20_000)]));
    const db = openDb(":memory:");
    const store = new PendingStore(db);
    store.addPending("MINT1", 0);

    const now = 181 * 60_000; // maxPendingAgeMin is 180
    const result = await recheckPending({ dexClient: makeClient(fetchImpl), store, now, ...baseOpts });

    expect(result.removedAged).toBe(1);
    expect(store.countPending()).toBe(0);
  });

  it("removes a mint once the entry window expires (permanent failure)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonOnce([pairFor("MINT1", 20_000)]));
    const db = openDb(":memory:");
    const store = new PendingStore(db);
    store.addPending("MINT1", 0);
    store.updatePending("MINT1", { firstEligibleAt: 0 });

    const now = 16 * 60_000; // entryWindowMin is 15
    const result = await recheckPending({ dexClient: makeClient(fetchImpl), store, now, ...baseOpts });

    expect(result.removedPermanent).toBe(1);
    expect(result.skipReasons.entryWindow).toBe(1);
    expect(store.countPending()).toBe(0);
  });

  it("keeps a mint pending on a temporary liquidity failure, without bumping noPairChecks", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonOnce([pairFor("MINT1", 500)]));
    const db = openDb(":memory:");
    const store = new PendingStore(db);
    store.addPending("MINT1", 0);

    const result = await recheckPending({ dexClient: makeClient(fetchImpl), store, now: 1000, ...baseOpts });

    expect(result.skipReasons.liquidity).toBe(1);
    const row = store.listPending()[0]!;
    expect(row.status).toBe("pending");
    expect(row.noPairChecks).toBe(0);
  });

  it("batches pending mints into groups of at most 30 per DexScreener call", async () => {
    const db = openDb(":memory:");
    const store = new PendingStore(db);
    for (let i = 0; i < 35; i++) store.addPending(`MINT${i}`, 0);

    const fetchImpl = vi.fn().mockImplementation(async () => jsonOnce([]));
    await recheckPending({ dexClient: makeClient(fetchImpl), store, now: 1000, ...baseOpts });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchImpl.mock.calls[0] as [string];
    const [secondUrl] = fetchImpl.mock.calls[1] as [string];
    expect(firstUrl.split(",").length).toBe(30);
    expect(secondUrl.split(",").length).toBe(5);
  });

  it("leaves a batch untouched (retried next cycle) when its pairs fetch fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));
    const db = openDb(":memory:");
    const store = new PendingStore(db);
    store.addPending("MINT1", 0);

    const result = await recheckPending({ dexClient: makeClient(fetchImpl), store, now: 1000, ...baseOpts });

    expect(result.checked).toBe(0);
    expect(result.failedBatches).toBe(1);
    expect(store.countPending()).toBe(1);
  });
});
