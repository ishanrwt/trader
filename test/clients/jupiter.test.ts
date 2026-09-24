import { describe, expect, it, vi } from "vitest";
import { JupiterClient } from "../../src/clients/jupiter.js";
import { SlidingWindowLimiter } from "../../src/limiters/slidingWindow.js";
import { createMemoryLogger } from "../../src/logger/index.js";

describe("JupiterClient", () => {
  it("builds the quote URL with query params and the x-api-key header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ inputMint: "A", inAmount: "1", outputMint: "B", outAmount: "2" }), {
        status: 200,
      }),
    );
    const client = new JupiterClient({
      apiKey: "jup-secret",
      physicalLimiter: new SlidingWindowLimiter(1000, 60_000),
      logger: createMemoryLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.getQuote({ inputMint: "A", outputMint: "B", amount: "1000000", slippageBps: 300 });
    expect(result.outAmount).toBe("2");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.jup.ag/swap/v1/quote?inputMint=A&outputMint=B&amount=1000000&slippageBps=300");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("jup-secret");
  });

  it("goes through the physical limiter before each call", async () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ inputMint: "A", inAmount: "1", outputMint: "B", outAmount: "2" }), {
        status: 200,
      }),
    );
    const client = new JupiterClient({
      apiKey: "k",
      physicalLimiter: limiter,
      logger: createMemoryLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.getQuote({ inputMint: "A", outputMint: "B", amount: "1", slippageBps: 50 });
    expect(limiter.count()).toBe(1);
  });

  it("logs and rethrows on failure", async () => {
    const logger = createMemoryLogger();
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 400 }));
    const client = new JupiterClient({
      apiKey: "k",
      physicalLimiter: new SlidingWindowLimiter(1000, 60_000),
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
    });
    await expect(
      client.getQuote({ inputMint: "A", outputMint: "B", amount: "1", slippageBps: 50 }),
    ).rejects.toThrow();
    expect(logger.entries.some((e) => e.level === "error" && e.msg === "Jupiter quote failed")).toBe(true);
  });
});
