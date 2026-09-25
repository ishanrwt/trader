import { describe, expect, it, vi } from "vitest";
import { JupiterClient } from "../../src/clients/jupiter.js";
import { createMemoryLogger } from "../../src/logger/index.js";

describe("JupiterClient.build: GET /swap/v2/build (SPEC.md section 16.1, A1)", () => {
  it("calls the Router path with taker, slippage, CU-price percentile and wrapAndUnwrapSol, never a tipAmount, through the physical limiter", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ inAmount: "1" }), { status: 200 }));
    const acquire = vi.fn(async () => undefined);
    const client = new JupiterClient({ apiKey: "k", physicalLimiter: { acquire } as never, logger: createMemoryLogger(), fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.build({ inputMint: "IN", outputMint: "OUT", amount: "25000000", taker: "WALLET", slippageBps: 300, computeUnitPricePercentile: "high" });
    expect(acquire).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe("https://api.jup.ag/swap/v2/build");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      inputMint: "IN",
      outputMint: "OUT",
      amount: "25000000",
      taker: "WALLET",
      slippageBps: "300",
      computeUnitPricePercentile: "high",
      wrapAndUnwrapSol: "true",
    });
    expect(u.searchParams.has("tipAmount")).toBe(false);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });
});
