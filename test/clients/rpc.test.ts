import { describe, expect, it, vi } from "vitest";
import { SolanaRpcClient } from "../../src/clients/rpc.js";
import { SlidingWindowLimiter } from "../../src/limiters/slidingWindow.js";
import { createMemoryLogger } from "../../src/logger/index.js";

const RPC_URL = "https://rpc.example.com/?api-key=super-secret-key-999";

function makeClient(fetchImpl: ReturnType<typeof vi.fn>, logger = createMemoryLogger([RPC_URL])) {
  return {
    client: new SolanaRpcClient({
      url: RPC_URL,
      limiter: new SlidingWindowLimiter(1000, 60_000),
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
    }),
    logger,
  };
}

describe("SolanaRpcClient", () => {
  it("POSTs a JSON-RPC 2.0 body with jsonParsed encoding for getAccountInfo", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: null } }), { status: 200 }));
    const { client } = makeClient(fetchImpl);
    const result = await client.getAccountInfo("Pubkey111");
    expect(result).toEqual({ value: null });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RPC_URL);
    const body = JSON.parse(init.body as string);
    expect(body.method).toBe("getAccountInfo");
    expect(body.params).toEqual(["Pubkey111", { encoding: "jsonParsed" }]);
  });

  it("calls getTokenLargestAccounts, getTokenSupply and getMultipleAccounts correctly", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), { status: 200 }));
    const { client } = makeClient(fetchImpl);

    await client.getTokenLargestAccounts("Mint1");
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string).method).toBe(
      "getTokenLargestAccounts",
    );

    await client.getTokenSupply("Mint1");
    expect(JSON.parse((fetchImpl.mock.calls[1]![1] as RequestInit).body as string).method).toBe("getTokenSupply");

    await client.getMultipleAccounts(["A", "B"]);
    const call3 = JSON.parse((fetchImpl.mock.calls[2]![1] as RequestInit).body as string);
    expect(call3.method).toBe("getMultipleAccounts");
    expect(call3.params).toEqual([["A", "B"], { encoding: "jsonParsed" }]);
  });

  it("throws on a JSON-RPC error response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid params" } }), {
        status: 200,
      }),
    );
    const { client } = makeClient(fetchImpl);
    await expect(client.getAccountInfo("bad")).rejects.toThrow(/invalid params/);
  });

  it("goes through the RPC limiter before each call", async () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), { status: 200 }));
    const client = new SolanaRpcClient({ url: RPC_URL, limiter, logger: createMemoryLogger(), fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.getTokenSupply("Mint1");
    expect(limiter.count()).toBe(1);
  });

  it("a failed RPC request logs no secrets, even though it logs the RPC URL", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`connect ECONNREFUSED ${RPC_URL}`));
    const { client, logger } = makeClient(fetchImpl);

    await expect(client.getAccountInfo("Pubkey111")).rejects.toThrow();

    expect(logger.entries.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(logger.entries);
    expect(serialized).not.toContain("super-secret-key-999");
    expect(serialized).not.toContain(RPC_URL);
    expect(serialized).toContain("[REDACTED]");
  });
});
