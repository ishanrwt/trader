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

    expect(result).toMatchObject({ checked: 1, passed: 1, eligible: 1, removedPermanent: 0, removedAged: 0 });
    const row = store.listPending()[0]!;
    expect(row.status).toBe("pending"); // Phase 1 has no READY state
    expect(row.firstEligibleAt).toBe(1000);
    expect(row.lastGateResult).toBe("passed");
  });

  it("counts eligible only the first time firstEligibleAt is set, not on later passing rechecks", async () => {
    const db = openDb(":memory:");
    const store = new PendingStore(db);
    store.addPending("MINT1", 0);

    const fetch1 = vi.fn().mockResolvedValueOnce(jsonOnce([pairFor("MINT1", 20_000)]));
    const first = await recheckPending({ dexClient: makeClient(fetch1), store, now: 1000, ...baseOpts });
    expect(first.eligible).toBe(1);

    const fetch2 = vi.fn().mockResolvedValueOnce(jsonOnce([pairFor("MINT1", 20_000)]));
    const second = await recheckPending({ dexClient: makeClient(fetch2), store, now: 2000, ...baseOpts });
    expect(second.eligible).toBe(0);
    expect(second.passed).toBe(1);
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
    expect(result.skippedMints.entryWindow).toEqual(["MINT1"]);
    expect(store.countPending()).toBe(0);
  });

  it("keeps a mint pending on a temporary liquidity failure, without bumping noPairChecks", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonOnce([pairFor("MINT1", 500)]));
    const db = openDb(":memory:");
    const store = new PendingStore(db);
    store.addPending("MINT1", 0);

    const result = await recheckPending({ dexClient: makeClient(fetchImpl), store, now: 1000, ...baseOpts });

    expect(result.skippedMints.liquidity).toEqual(["MINT1"]);
    const row = store.listPending()[0]!;
    expect(row.status).toBe("pending");
    expect(row.noPairChecks).toBe(0);
  });

  it("returns the failing mint again on each call, leaving de-duplication to the caller's per-window Set", async () => {
    const db = openDb(":memory:");
    const store = new PendingStore(db);
    store.addPending("MINT1", 0);

    const skippedMintsAcrossWindow = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonOnce([pairFor("MINT1", 500)]));
      const result = await recheckPending({ dexClient: makeClient(fetchImpl), store, now: 1000 + i, ...baseOpts });
      expect(result.skippedMints.liquidity).toEqual(["MINT1"]); // every call reports it again
      for (const mint of result.skippedMints.liquidity ?? []) skippedMintsAcrossWindow.add(mint);
    }
    // 5 evaluations of the same mint collapse to 1 unique mint for the window.
    expect(skippedMintsAcrossWindow.size).toBe(1);
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

  describe("Phase 2: checks 5-8 via the phase2 deps", () => {
    function readyPair(mint: string) {
      return {
        ...pairFor(mint, 20_000),
        priceChange: { m5: 5, h1: 10, h24: 20 },
        txns: { m5: { buys: 8, sells: 4 } },
        volume: { m5: 2000 },
      };
    }

    const M56_CFG = { minM5ChangePct: 0, minH1ChangePct: 0, minH24ChangePct: 0, maxH1ChangePct: 0, minM5Txns: 10, minM5BuySellRatio: 1, minM5VolumeUsd: 1000 };

    it("reaches READY when checks 5-8 all pass, stores a snapshot, and fires onNewlyReady exactly once", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonOnce([readyPair("MINT1")]));
      const db = openDb(":memory:");
      const store = new PendingStore(db);
      store.addPending("MINT1", 0);
      const onNewlyReady = vi.fn();

      const phase2 = {
        momentumBuyPressureCfg: M56_CFG,
        getMintSafety: vi.fn().mockResolvedValue({ passed: true, reason: "ok" }),
        getHolders: vi.fn().mockResolvedValue({ passed: true, reason: "ok", top1Pct: 5, top10Pct: 20 }),
        computeSnapshot: () => ({ score: 0.7, snapshotJson: JSON.stringify({ score: 0.7 }) }),
        onNewlyReady,
      };

      const result = await recheckPending({ dexClient: makeClient(fetchImpl), store, now: 1000, ...baseOpts, phase2 });
      expect(result.ready).toBe(1);
      const row = store.listReady()[0]!;
      expect(row.mint).toBe("MINT1");
      expect(row.snapshot).toBe(JSON.stringify({ score: 0.7 }));
      expect(onNewlyReady).toHaveBeenCalledTimes(1);
      expect(onNewlyReady).toHaveBeenCalledWith("MINT1", expect.objectContaining({ baseToken: { address: "MINT1" } }));
    });

    it("does not re-fire onNewlyReady on a later recheck that's still READY", async () => {
      const db = openDb(":memory:");
      const store = new PendingStore(db);
      store.addPending("MINT1", 0);
      const onNewlyReady = vi.fn();
      const phase2 = {
        momentumBuyPressureCfg: M56_CFG,
        getMintSafety: vi.fn().mockResolvedValue({ passed: true, reason: "ok" }),
        getHolders: vi.fn().mockResolvedValue({ passed: true, reason: "ok", top1Pct: 5, top10Pct: 20 }),
        computeSnapshot: () => ({ score: 0.7, snapshotJson: "{}" }),
        onNewlyReady,
      };

      await recheckPending({
        dexClient: makeClient(vi.fn().mockResolvedValueOnce(jsonOnce([readyPair("MINT1")]))),
        store,
        now: 1000,
        ...baseOpts,
        phase2,
      });
      await recheckPending({
        dexClient: makeClient(vi.fn().mockResolvedValueOnce(jsonOnce([readyPair("MINT1")]))),
        store,
        now: 2000,
        ...baseOpts,
        phase2,
      });
      expect(onNewlyReady).toHaveBeenCalledTimes(1);
    });

    it("check 7 (mint safety) failing is permanent: removed from pending, not marked READY", async () => {
      const db = openDb(":memory:");
      const store = new PendingStore(db);
      store.addPending("MINT1", 0);
      const phase2 = {
        momentumBuyPressureCfg: M56_CFG,
        getMintSafety: vi.fn().mockResolvedValue({ passed: false, reason: "mint authority not revoked" }),
        getHolders: vi.fn(),
        computeSnapshot: vi.fn(),
        onNewlyReady: vi.fn(),
      };
      const result = await recheckPending({
        dexClient: makeClient(vi.fn().mockResolvedValueOnce(jsonOnce([readyPair("MINT1")]))),
        store,
        now: 1000,
        ...baseOpts,
        phase2,
      });
      expect(result.removedPermanent).toBe(1);
      expect(result.skippedMints.mintSafety).toEqual(["MINT1"]);
      expect(store.countPending()).toBe(0);
      expect(phase2.getHolders).not.toHaveBeenCalled(); // never reached
    });

    it("check 8 (holders) failing is temporary: stays pending, not READY", async () => {
      const db = openDb(":memory:");
      const store = new PendingStore(db);
      store.addPending("MINT1", 0);
      const phase2 = {
        momentumBuyPressureCfg: M56_CFG,
        getMintSafety: vi.fn().mockResolvedValue({ passed: true, reason: "ok" }),
        getHolders: vi.fn().mockResolvedValue({ passed: false, reason: "top1 too concentrated", top1Pct: 50, top10Pct: 80 }),
        computeSnapshot: vi.fn(),
        onNewlyReady: vi.fn(),
      };
      const result = await recheckPending({
        dexClient: makeClient(vi.fn().mockResolvedValueOnce(jsonOnce([readyPair("MINT1")]))),
        store,
        now: 1000,
        ...baseOpts,
        phase2,
      });
      expect(result.skippedMints.holders).toEqual(["MINT1"]);
      expect(result.ready).toBe(0);
      const row = store.listPending()[0]!;
      expect(row.status).toBe("pending");
    });

    it("checks 5-6 failing (momentum/buy pressure) never reach RPC", async () => {
      const db = openDb(":memory:");
      const store = new PendingStore(db);
      store.addPending("MINT1", 0);
      const weakPair = { ...pairFor("MINT1", 20_000), priceChange: { m5: 0, h1: 0, h24: 0 }, txns: { m5: { buys: 1, sells: 1 } }, volume: { m5: 0 } };
      const phase2 = {
        momentumBuyPressureCfg: M56_CFG,
        getMintSafety: vi.fn(),
        getHolders: vi.fn(),
        computeSnapshot: vi.fn(),
        onNewlyReady: vi.fn(),
      };
      const result = await recheckPending({
        dexClient: makeClient(vi.fn().mockResolvedValueOnce(jsonOnce([weakPair]))),
        store,
        now: 1000,
        ...baseOpts,
        phase2,
      });
      expect(result.skippedMints.momentum).toEqual(["MINT1"]);
      expect(phase2.getMintSafety).not.toHaveBeenCalled();
    });
  });
});
