import { describe, expect, it, vi } from "vitest";
import { DexScreenerClient, selectPair } from "../../src/clients/dexscreener.js";
import { SlidingWindowLimiter } from "../../src/limiters/slidingWindow.js";
import { createMemoryLogger } from "../../src/logger/index.js";
import type { DexPair } from "../../src/types.js";

const MINT = "TokenMint111111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOL = "So11111111111111111111111111111111111111112";
const OTHER = "OtherMint1111111111111111111111111111111111";

function pair(overrides: Partial<DexPair>): DexPair {
  return {
    chainId: "solana",
    pairAddress: "pair",
    baseToken: { address: MINT },
    quoteToken: { address: USDC },
    liquidity: { usd: 1000 },
    ...overrides,
  };
}

describe("selectPair", () => {
  it("picks the highest-liquidity pair among valid candidates", () => {
    const pairs = [
      pair({ pairAddress: "low", liquidity: { usd: 500 } }),
      pair({ pairAddress: "high", liquidity: { usd: 5000 } }),
    ];
    const result = selectPair(pairs, MINT, [USDC, USDT]);
    expect(result?.pairAddress).toBe("high");
  });

  it("ignores pairs where the mint is only the quote token", () => {
    const pairs = [pair({ pairAddress: "wrong-side", baseToken: { address: USDC }, quoteToken: { address: MINT } })];
    expect(selectPair(pairs, MINT, [USDC, USDT])).toBeNull();
  });

  it("ignores pairs whose quote token isn't in the allowed list", () => {
    const pairs = [pair({ pairAddress: "bad-quote", quoteToken: { address: OTHER } })];
    expect(selectPair(pairs, MINT, [USDC, USDT])).toBeNull();
  });

  it("ignores pairs on a different chain", () => {
    const pairs = [pair({ pairAddress: "wrong-chain", chainId: "ethereum" })];
    expect(selectPair(pairs, MINT, [USDC, USDT])).toBeNull();
  });

  it("returns null when there are no candidates", () => {
    expect(selectPair([], MINT, [USDC, USDT])).toBeNull();
  });

  it("selects the SOL/USD pair with base=wrapped SOL and quote=USDC or USDT", () => {
    const pairs = [
      pair({ pairAddress: "sol-usdc", baseToken: { address: SOL }, quoteToken: { address: USDC }, liquidity: { usd: 2000 } }),
      pair({ pairAddress: "sol-usdt", baseToken: { address: SOL }, quoteToken: { address: USDT }, liquidity: { usd: 9000 } }),
      pair({ pairAddress: "sol-other", baseToken: { address: SOL }, quoteToken: { address: OTHER }, liquidity: { usd: 99999 } }),
    ];
    const result = selectPair(pairs, SOL, [USDC, USDT]);
    expect(result?.pairAddress).toBe("sol-usdt");
  });
});

function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  return new DexScreenerClient({
    profilesLimiter: new SlidingWindowLimiter(1000, 60_000),
    pairsLimiter: new SlidingWindowLimiter(1000, 60_000),
    logger: createMemoryLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe("DexScreenerClient", () => {
  it("fetches and maps latest token profiles", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ chainId: "solana", tokenAddress: MINT, description: "x" }]), { status: 200 }),
    );
    const client = makeClient(fetchImpl);
    const profiles = await client.getLatestProfiles();
    expect(profiles).toEqual([{ chainId: "solana", tokenAddress: MINT, description: "x" }]);
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe("https://api.dexscreener.com/token-profiles/latest/v1");
  });

  it("drops profiles with no tokenAddress", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ chainId: "solana" }, { chainId: "solana", tokenAddress: MINT }]), { status: 200 }),
    );
    const client = makeClient(fetchImpl);
    const profiles = await client.getLatestProfiles();
    expect(profiles).toHaveLength(1);
  });

  it("fetches pairs for a batch of addresses, comma-joined in the URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const client = makeClient(fetchImpl);
    await client.getPairs("solana", [MINT, OTHER]);
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe(`https://api.dexscreener.com/tokens/v1/solana/${MINT},${OTHER}`);
  });

  it("refuses to fetch more than 30 addresses in one request", async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl);
    const addrs = Array.from({ length: 31 }, (_, i) => `mint${i}`);
    await expect(client.getPairs("solana", addrs)).rejects.toThrow(/exceeds the max/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns an empty array for an empty address list without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl);
    expect(await client.getPairs("solana", [])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("goes through the pairs limiter before each pairs request", async () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const client = new DexScreenerClient({
      profilesLimiter: new SlidingWindowLimiter(1000, 60_000),
      pairsLimiter: limiter,
      logger: createMemoryLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.getPairs("solana", [MINT]);
    expect(limiter.count()).toBe(1);
  });
});
