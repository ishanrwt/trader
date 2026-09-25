import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LaneLimiter } from "../../src/limiters/laneLimiter.js";

describe("LaneLimiter (SPEC.md section 16.10)", () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  it("serves waiting transaction-lane calls before waiting read-lane calls", async () => {
    const limiter = new LaneLimiter(1, 1_000, { now: () => Date.now() });
    const order: string[] = [];
    await limiter.acquire("read"); // uses the only slot in this window
    const r1 = limiter.acquire("read").then(() => order.push("read1"));
    const r2 = limiter.acquire("read").then(() => order.push("read2"));
    const t1 = limiter.acquire("tx").then(() => order.push("tx1"));
    await vi.advanceTimersByTimeAsync(3_100);
    await Promise.all([r1, r2, t1]);
    expect(order).toEqual(["tx1", "read1", "read2"]);
  });

  it("never exceeds the per-window cap", async () => {
    const limiter = new LaneLimiter(2, 1_000, { now: () => Date.now() });
    const times: number[] = [];
    const all = Array.from({ length: 5 }, (_, i) => limiter.acquire(i % 2 ? "tx" : "read").then(() => times.push(Date.now())));
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(all);
    for (const t of times) expect(times.filter((u) => u > t - 1_000 && u <= t).length).toBeLessThanOrEqual(2);
  });

  it("a lane view works as a plain { acquire } limiter", async () => {
    const limiter = new LaneLimiter(10, 1_000, { now: () => Date.now() });
    await expect(limiter.lane("read").acquire()).resolves.toBeUndefined();
  });
});
