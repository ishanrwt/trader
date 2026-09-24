import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter } from "../../src/limiters/slidingWindow.js";

describe("SlidingWindowLimiter", () => {
  it("allows calls immediately while under the window cap", () => {
    const limiter = new SlidingWindowLimiter(3, 60_000);
    expect(limiter.waitMs(0)).toBe(0);
    limiter.record(0);
    expect(limiter.waitMs(1)).toBe(0);
    limiter.record(1);
    expect(limiter.waitMs(2)).toBe(0);
    limiter.record(2);
    expect(limiter.count(2)).toBe(3);
  });

  it("blocks once the window cap is reached until the oldest call ages out", () => {
    const limiter = new SlidingWindowLimiter(2, 60_000);
    limiter.record(0);
    limiter.record(1_000);
    expect(limiter.waitMs(1_500)).toBe(60_000 - 1_500); // waits for the first call to age out
    expect(limiter.waitMs(60_000)).toBe(0); // first call (t=0) just aged out
  });

  it("enforces the minimum interval between calls even under the window cap", () => {
    const limiter = new SlidingWindowLimiter(100, 60_000, 1_100);
    limiter.record(0);
    expect(limiter.waitMs(500)).toBe(600);
    expect(limiter.waitMs(1_100)).toBe(0);
  });

  it("prunes timestamps older than the window", () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    limiter.record(0);
    expect(limiter.count(59_999)).toBe(1);
    expect(limiter.count(60_001)).toBe(0);
  });

  it("acquire() resolves immediately when under budget", async () => {
    const limiter = new SlidingWindowLimiter(5, 60_000);
    await expect(limiter.acquire()).resolves.toBeUndefined();
    expect(limiter.count()).toBe(1);
  });
});
