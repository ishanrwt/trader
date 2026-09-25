import { describe, expect, it, vi } from "vitest";
import {
  computePositionSizeUsd,
  pickNextCandidate,
  runSlotFilling,
  type ReadyCandidate,
  type SellabilityMeasurement,
  type SlotFillingDeps,
} from "../../src/selection/index.js";
import { createMemoryLogger } from "../../src/logger/index.js";

function candidate(overrides: Partial<ReadyCandidate> = {}): ReadyCandidate {
  return {
    mint: "MINT",
    score: 0.5,
    firstEligibleAt: 1000,
    liquidityUsd: 20_000,
    // Matches baseDeps' default execution quote (sizeUsd 25 / tokensOut 1000 = 0.025) so the
    // drift check clears by default; tests exercising drift override priceUsd/tokensOut explicitly.
    priceUsd: 0.025,
    lastCheckedAt: 1000,
    ...overrides,
  };
}

describe("pickNextCandidate", () => {
  it("picks the highest score", () => {
    const a = candidate({ mint: "A", score: 0.3 });
    const b = candidate({ mint: "B", score: 0.8 });
    const pick = pickNextCandidate([a, b], { minScore: 0, now: 1000, pendingRecheckSeconds: 30, inFlight: new Set() });
    expect(pick?.mint).toBe("B");
  });

  it("tie-breaks on earlier firstEligibleAt", () => {
    const a = candidate({ mint: "A", score: 0.5, firstEligibleAt: 2000 });
    const b = candidate({ mint: "B", score: 0.5, firstEligibleAt: 1000 });
    const pick = pickNextCandidate([a, b], { minScore: 0, now: 3000, pendingRecheckSeconds: 30, inFlight: new Set() });
    expect(pick?.mint).toBe("B");
  });

  it("excludes candidates below MIN_SCORE", () => {
    const pick = pickNextCandidate([candidate({ score: 0.1 })], { minScore: 0.5, now: 1000, pendingRecheckSeconds: 30, inFlight: new Set() });
    expect(pick).toBeNull();
  });

  it("excludes mints already entering (in flight)", () => {
    const pick = pickNextCandidate([candidate({ mint: "A" })], {
      minScore: 0,
      now: 1000,
      pendingRecheckSeconds: 30,
      inFlight: new Set(["A"]),
    });
    expect(pick).toBeNull();
  });

  it("skips a candidate whose cached snapshot is older than 2x PENDING_RECHECK_SECONDS", () => {
    const stale = candidate({ mint: "STALE", lastCheckedAt: 0 });
    const fresh = candidate({ mint: "FRESH", lastCheckedAt: 55_000, score: 0.1 }); // lower score but fresh
    const now = 61_000; // 61s later; 2x30s=60s cutoff -> STALE is too old, FRESH is not
    const pick = pickNextCandidate([stale, fresh], { minScore: 0, now, pendingRecheckSeconds: 30, inFlight: new Set() });
    expect(pick?.mint).toBe("FRESH");
  });
});

describe("computePositionSizeUsd", () => {
  it("caps size at MAX_POSITION_PCT_OF_LIQ of liquidity when smaller than POSITION_USD", () => {
    expect(computePositionSizeUsd(25, 1000, 1)).toBe(10); // 1000 * 1% = 10 < 25
  });

  it("uses POSITION_USD when liquidity headroom is larger", () => {
    expect(computePositionSizeUsd(25, 1_000_000, 1)).toBe(25);
  });
});

function baseDeps(overrides: Partial<SlotFillingDeps> = {}): SlotFillingDeps {
  return {
    now: 1000,
    maxConcurrent: 3,
    minScore: 0,
    pendingRecheckSeconds: 30,
    maxEntryDriftPct: 10,
    candidates: [],
    openPositionsCount: 0,
    inFlight: new Set(),
    getSellabilityCache: () => undefined,
    setSellabilityCache: () => {},
    checkSellability: vi.fn().mockResolvedValue({ passed: true, roundTripLossPct: 2.5 }),
    getExecutionQuote: vi.fn().mockResolvedValue({ tokensOut: 1000 }),
    positionSizeUsd: () => 25,
    paperFeeUsdPerTx: 0.05,
    canAfford: () => true,
    openPosition: vi.fn().mockResolvedValue(undefined),
    markUnsellable: vi.fn(),
    entryBlocked: () => false,
    logger: createMemoryLogger(),
    ...overrides,
  };
}

describe("runSlotFilling", () => {
  it("opens the best candidate when sellability and drift both clear", async () => {
    const openPosition = vi.fn().mockResolvedValue(undefined);
    const deps = baseDeps({ candidates: [candidate({ mint: "A" })], openPosition });
    await runSlotFilling(deps);
    expect(openPosition).toHaveBeenCalledWith(expect.objectContaining({ mint: "A" }), {
      tokens: 1000,
      sizeUsd: 25,
      sellability: { roundTripLossPct: 2.5, checkedAt: 1000 },
    });
  });

  it("checks affordability against size + PAPER_FEE_USD_PER_TX, not size alone", async () => {
    const canAfford = vi.fn().mockReturnValue(true);
    const deps = baseDeps({ candidates: [candidate({ mint: "A" })], positionSizeUsd: () => 25, paperFeeUsdPerTx: 0.05, canAfford });
    await runSlotFilling(deps);
    expect(canAfford).toHaveBeenCalledWith(25.05);
  });

  it("skips opening when the wallet can't afford size + fee", async () => {
    const openPosition = vi.fn().mockResolvedValue(undefined);
    const deps = baseDeps({ candidates: [candidate({ mint: "A" })], canAfford: () => false, openPosition });
    await runSlotFilling(deps);
    expect(openPosition).not.toHaveBeenCalled();
  });

  it("a failed sellability check is permanent and falls through to the next candidate", async () => {
    const markUnsellable = vi.fn();
    const openPosition = vi.fn().mockResolvedValue(undefined);
    const checkSellability = vi.fn().mockImplementation(async (mint: string) => ({ passed: mint !== "BAD", roundTripLossPct: mint === "BAD" ? 40 : 3 }));
    const deps = baseDeps({
      candidates: [candidate({ mint: "BAD", score: 0.9 }), candidate({ mint: "GOOD", score: 0.1 })],
      checkSellability,
      markUnsellable,
      openPosition,
    });
    await runSlotFilling(deps);
    expect(markUnsellable).toHaveBeenCalledWith("BAD");
    expect(openPosition).toHaveBeenCalledWith(expect.objectContaining({ mint: "GOOD" }), expect.anything());
  });

  it("a sellability pass is cached with its measured loss and check time", async () => {
    const checkSellability = vi.fn().mockResolvedValue({ passed: true, roundTripLossPct: 2.5 });
    const cache = new Map<string, SellabilityMeasurement>();
    const deps = baseDeps({
      candidates: [candidate({ mint: "A" })],
      checkSellability,
      getSellabilityCache: (mint, sizeUsd) => cache.get(`${mint}|${sizeUsd}`),
      setSellabilityCache: (mint, sizeUsd, result) => cache.set(`${mint}|${sizeUsd}`, result),
    });
    await runSlotFilling(deps);
    expect(checkSellability).toHaveBeenCalledTimes(1);
    expect(cache.get("A|25")).toEqual({ passed: true, roundTripLossPct: 2.5, checkedAt: 1000 });
  });

  it("a cache hit is not re-checked and carries the cached loss and original check time into the entry", async () => {
    const checkSellability = vi.fn();
    const openPosition = vi.fn().mockResolvedValue(undefined);
    const deps = baseDeps({
      now: 5000,
      candidates: [candidate({ mint: "A", lastCheckedAt: 5000 })],
      checkSellability,
      getSellabilityCache: () => ({ passed: true, roundTripLossPct: 4.2, checkedAt: 1234 }),
      openPosition,
    });
    await runSlotFilling(deps);
    expect(checkSellability).not.toHaveBeenCalled();
    expect(openPosition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sellability: { roundTripLossPct: 4.2, checkedAt: 1234 } }));
  });

  it("the sellability cache is looked up by mint AND size: a loss measured at another size is never reused", async () => {
    const cache = new Map<string, SellabilityMeasurement>([["A|25", { passed: true, roundTripLossPct: 2.5, checkedAt: 500 }]]);
    const getSellabilityCache = vi.fn((mint: string, sizeUsd: number) => cache.get(`${mint}|${sizeUsd}`));
    const checkSellability = vi.fn().mockResolvedValue({ passed: true, roundTripLossPct: 6.1 });
    const openPosition = vi.fn().mockResolvedValue(undefined);
    const deps = baseDeps({
      candidates: [candidate({ mint: "A" })],
      positionSizeUsd: () => 10, // e.g. POSITION_USD changed, or liquidity now caps the size
      getExecutionQuote: vi.fn().mockResolvedValue({ tokensOut: 400 }),
      getSellabilityCache,
      setSellabilityCache: (mint, sizeUsd, result) => cache.set(`${mint}|${sizeUsd}`, result),
      checkSellability,
      openPosition,
    });
    await runSlotFilling(deps);
    expect(getSellabilityCache).toHaveBeenCalledWith("A", 10, 1000);
    expect(checkSellability).toHaveBeenCalledWith("A", 10);
    expect(openPosition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sizeUsd: 10, sellability: { roundTripLossPct: 6.1, checkedAt: 1000 } }));
    expect(cache.get("A|25")?.roundTripLossPct).toBe(2.5); // the other size's entry is untouched
  });

  it("drift skip: an implied price beyond MAX_ENTRY_DRIFT_PCT is skipped (temporary), not opened", async () => {
    const openPosition = vi.fn().mockResolvedValue(undefined);
    // priceUsd 0.001, tokensOut such that impliedPrice = size/tokensOut is way above priceUsd*(1+10%)
    const deps = baseDeps({
      candidates: [candidate({ mint: "A", priceUsd: 0.001 })],
      getExecutionQuote: vi.fn().mockResolvedValue({ tokensOut: 1 }), // implied price = 25/1 = 25, way beyond drift
      openPosition,
    });
    await runSlotFilling(deps);
    expect(openPosition).not.toHaveBeenCalled();
  });

  it("stops filling once MAX_CONCURRENT is reached", async () => {
    const openPosition = vi.fn().mockResolvedValue(undefined);
    const deps = baseDeps({
      maxConcurrent: 1,
      openPositionsCount: 1,
      candidates: [candidate({ mint: "A" })],
      openPosition,
    });
    await runSlotFilling(deps);
    expect(openPosition).not.toHaveBeenCalled();
  });

  it("stops filling when an entry blocker is active, even with open candidates and slots free", async () => {
    const openPosition = vi.fn().mockResolvedValue(undefined);
    const deps = baseDeps({ candidates: [candidate({ mint: "A" })], entryBlocked: () => true, openPosition });
    await runSlotFilling(deps);
    expect(openPosition).not.toHaveBeenCalled();
  });

  it("never has a way to close an open position (no such dependency exists)", () => {
    const deps = baseDeps();
    expect((deps as unknown as Record<string, unknown>).closePosition).toBeUndefined();
  });

  it("does not block opening a second slot on the first fill's completion (fire-and-forget, mirrors exit fills)", async () => {
    let firstFillResolved = false;
    const neverResolving = new Promise<void>(() => {});
    void neverResolving.then(() => {
      firstFillResolved = true;
    });
    const openPosition = vi
      .fn()
      .mockImplementationOnce(() => neverResolving)
      .mockImplementationOnce(async () => {});

    const deps = baseDeps({
      maxConcurrent: 2,
      candidates: [candidate({ mint: "A", score: 0.9 }), candidate({ mint: "B", score: 0.8 })],
      openPosition,
    });
    await runSlotFilling(deps);
    expect(openPosition).toHaveBeenCalledTimes(2); // both attempted despite the first never resolving
    expect(firstFillResolved).toBe(false);
  });
});
