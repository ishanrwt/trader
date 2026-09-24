import { describe, expect, it, vi } from "vitest";
import { fetchJson, HttpRequestError } from "../../src/clients/http.js";
import { createMemoryLogger } from "../../src/logger/index.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("fetchJson", () => {
  it("returns parsed JSON on a 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const result = await fetchJson("https://example.com/x", { fetchImpl });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 with backoff, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const result = await fetchJson("https://example.com/x", { fetchImpl, baseDelayMs: 1, retries: 2 });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 502 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const result = await fetchJson("https://example.com/x", { fetchImpl, baseDelayMs: 1, retries: 2 });
    expect(result).toEqual({ ok: true });
  });

  it("throws HttpRequestError after exhausting retries on repeated 429s", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
    await expect(fetchJson("https://example.com/x", { fetchImpl, baseDelayMs: 1, retries: 2 })).rejects.toThrow(
      HttpRequestError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry on a non-retryable 4xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    await expect(fetchJson("https://example.com/x", { fetchImpl, retries: 2 })).rejects.toThrow(HttpRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries on a thrown network error, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const result = await fetchJson("https://example.com/x", { fetchImpl, baseDelayMs: 1, retries: 2 });
    expect(result).toEqual({ ok: true });
  });

  it("logs retries through the injected logger without throwing", async () => {
    const logger = createMemoryLogger();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await fetchJson("https://example.com/x", { fetchImpl, baseDelayMs: 1, retries: 2, logger, label: "Test" });
    expect(logger.entries.some((e) => e.msg.includes("Test returned 429"))).toBe(true);
  });
});
