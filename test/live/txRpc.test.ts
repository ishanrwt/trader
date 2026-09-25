import { describe, expect, it, vi } from "vitest";
import { createMemoryLogger } from "../../src/logger/index.js";
import { SendNotPermittedError, SendPermit, TxRpc } from "../../src/live/txRpc.js";

const URL = "https://rpc.example.com/?api-key=secret123";

function makeRpc(permit: SendPermit | null, fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "SIG" }), { status: 200, headers: { "content-type": "application/json" } }))) {
  const logger = createMemoryLogger([URL]);
  const lanes: string[] = [];
  const sendAcquires = { n: 0 };
  const rpc = new TxRpc({
    url: URL,
    limiter: { acquire: async (lane) => void lanes.push(lane) },
    sendLimiter: { acquire: async () => void sendAcquires.n++ },
    permit,
    logger,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { rpc, fetchImpl, logger, lanes, sendAcquires };
}

describe("the send path (SPEC.md section 16.8)", () => {
  it("sendTransaction throws and never touches the network without a live send permit", async () => {
    const { rpc, fetchImpl } = makeRpc(null);
    await expect(rpc.sendTransaction("AAAA")).rejects.toBeInstanceOf(SendNotPermittedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a send permit can't be issued in paper mode", () => {
    expect(() => SendPermit.issue("paper", "live")).toThrow(/paper mode/);
  });

  it("a hand-made object is not accepted as a permit", async () => {
    const forged = Object.create(SendPermit.prototype) as SendPermit;
    const { rpc, fetchImpl } = makeRpc(forged);
    await expect(rpc.sendTransaction("AAAA")).rejects.toBeInstanceOf(SendNotPermittedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("with a live permit, sends base64 bytes with skipPreflight and maxRetries 0, through both limiters", async () => {
    const { rpc, fetchImpl, lanes, sendAcquires } = makeRpc(SendPermit.issue("live", "live"));
    expect(await rpc.sendTransaction("AAAA")).toBe("SIG");
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(body.method).toBe("sendTransaction");
    expect(body.params).toEqual(["AAAA", { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
    expect(lanes).toEqual(["tx"]);
    expect(sendAcquires.n).toBe(1);
  });
});

describe("TxRpc requests", () => {
  it("simulates with sigVerify, inner instructions and jsonParsed post-state of the requested accounts", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: {}, value: { err: null } } }), { status: 200 }));
    const { rpc } = makeRpc(null, fetchImpl as never);
    await rpc.simulate("AAAA", { sigVerify: true, replaceRecentBlockhash: false, accounts: ["A", "B"] });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.params[1]).toEqual({
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: true,
      replaceRecentBlockhash: false,
      innerInstructions: true,
      accounts: { addresses: ["A", "B"], encoding: "jsonParsed" },
    });
  });

  it("puts reconciliation on the read lane and everything else on the transaction lane", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }), { status: 200 }));
    const { rpc, lanes } = makeRpc(null, fetchImpl as never);
    await rpc.getTokenAccountsByOwner("W", "P");
    await rpc.getMultipleAccounts([]);
    expect(lanes).toEqual(["read", "tx"]);
  });

  it("a JSON-RPC error is thrown, and the logged RPC URL is redacted", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "boom" } }), { status: 200 }));
    const { rpc, logger } = makeRpc(null, fetchImpl as never);
    await expect(rpc.getBlockHeight()).rejects.toThrow(/boom/);
    expect(JSON.stringify(logger.entries)).not.toContain("secret123");
  });

  it("fails closed on an unexpected getSignatureStatuses shape", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }), { status: 200 }));
    const { rpc } = makeRpc(null, fetchImpl as never);
    await expect(rpc.getSignatureStatuses(["A"], false)).rejects.toThrow(/unexpected shape/);
  });
});
