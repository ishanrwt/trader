import { describe, expect, it, vi } from "vitest";
import { DexScreenerClient } from "../../src/clients/dexscreener.js";
import { SlidingWindowLimiter } from "../../src/limiters/slidingWindow.js";
import { createMemoryLogger } from "../../src/logger/index.js";
import { SolPriceTracker } from "../../src/solPrice/index.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

function client(fetchImpl: ReturnType<typeof vi.fn>) {
  return new DexScreenerClient({
    profilesLimiter: new SlidingWindowLimiter(1000, 60_000),
    pairsLimiter: new SlidingWindowLimiter(1000, 60_000),
    logger: createMemoryLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe("SolPriceTracker", () => {
  it("refreshes the price from the highest-liquidity SOL/USDC or SOL/USDT pair", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            chainId: "solana",
            pairAddress: "sol-usdc",
            baseToken: { address: SOL },
            quoteToken: { address: USDC },
            liquidity: { usd: 1000 },
            priceUsd: "150.25",
          },
          {
            chainId: "solana",
            pairAddress: "sol-usdt",
            baseToken: { address: SOL },
            quoteToken: { address: USDT },
            liquidity: { usd: 90000 },
            priceUsd: "150.50",
          },
        ]),
        { status: 200 },
      ),
    );
    const tracker = new SolPriceTracker(client(fetchImpl), [USDC, USDT], createMemoryLogger(), { now: () => 5000 });
    await tracker.refresh();
    expect(tracker.get()).toEqual({ priceUsd: 150.5, updatedAt: 5000 });
  });

  it("keeps the last known price when no valid pair is found", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const logger = createMemoryLogger();
    const tracker = new SolPriceTracker(client(fetchImpl), [USDC, USDT], logger, { now: () => 5000 });
    await tracker.refresh();
    expect(tracker.get()).toEqual({ priceUsd: null, updatedAt: null });
    expect(logger.entries.some((e) => e.level === "warn")).toBe(true);
  });

  it("never throws when the DexScreener call fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network error"));
    const tracker = new SolPriceTracker(client(fetchImpl), [USDC, USDT], createMemoryLogger());
    await expect(tracker.refresh()).resolves.toBeUndefined();
    expect(tracker.get().priceUsd).toBeNull();
  });
});
