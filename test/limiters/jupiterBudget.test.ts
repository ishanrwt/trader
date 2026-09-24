import { describe, expect, it } from "vitest";
import { JupiterLaneBudget } from "../../src/limiters/jupiterBudget.js";

// Spec defaults: MAX_CONCURRENT=3, POLL_SECONDS=10, EXIT_RESERVE_EXTRA_PER_MIN=5
// -> exitReserve = 3*ceil(60/10)+5 = 23. JUPITER_MAX_REQ_PER_MIN=45.
const EXIT_RESERVE = 23;
const MAX_PER_MIN = 45;

describe("JupiterLaneBudget", () => {
  it("with 3 open positions using 18 exit calls/min, the entry lane still gets about 20 calls/min", () => {
    const budget = new JupiterLaneBudget({ jupiterMaxReqPerMin: MAX_PER_MIN, exitReserve: EXIT_RESERVE });

    // All 18 exit calls happen first, at t=0, and are never gated.
    for (let i = 0; i < 18; i++) budget.recordExit(0);
    expect(budget.usageSnapshot(0).exitUsed).toBe(18);

    let admitted = 0;
    while (budget.canEnterNow(0)) {
      budget.recordEntry(0);
      admitted++;
      if (admitted > 100) throw new Error("runaway loop"); // safety net
    }

    // exitUsed(18) + entryUsed + max(0, 23-18) < 45  =>  entryUsed < 22  =>  22 admitted (0..21)
    expect(admitted).toBe(22);
    expect(admitted).toBeGreaterThanOrEqual(20);
    expect(admitted).toBeLessThan(23);
  });

  it("exit calls are never blocked by entry usage, even once the entry lane is exhausted", () => {
    const budget = new JupiterLaneBudget({ jupiterMaxReqPerMin: MAX_PER_MIN, exitReserve: EXIT_RESERVE });

    for (let i = 0; i < 18; i++) budget.recordExit(0);
    while (budget.canEnterNow(0)) budget.recordEntry(0);
    expect(budget.canEnterNow(0)).toBe(false);

    // Exit lane keeps accepting calls regardless of the exhausted entry lane.
    expect(() => {
      for (let i = 0; i < 10; i++) budget.recordExit(0);
    }).not.toThrow();
    expect(budget.usageSnapshot(0).exitUsed).toBe(28);
  });

  it("with no exit usage, the entry lane can use the full budget minus the reserve", () => {
    const budget = new JupiterLaneBudget({ jupiterMaxReqPerMin: MAX_PER_MIN, exitReserve: EXIT_RESERVE });

    let admitted = 0;
    while (budget.canEnterNow(0)) {
      budget.recordEntry(0);
      admitted++;
    }
    // exitUsed(0) + entryUsed + max(0, 23-0) < 45 => entryUsed < 22 => 22 admitted
    expect(admitted).toBe(22);
  });

  it("counts and resets deferred entry checks for the digest health section", () => {
    const budget = new JupiterLaneBudget({ jupiterMaxReqPerMin: MAX_PER_MIN, exitReserve: EXIT_RESERVE });
    budget.recordDeferredEntry();
    budget.recordDeferredEntry();
    expect(budget.takeDeferredEntryCount()).toBe(2);
    expect(budget.takeDeferredEntryCount()).toBe(0);
  });

  it("prunes usage older than the 60s window", () => {
    const budget = new JupiterLaneBudget({ jupiterMaxReqPerMin: MAX_PER_MIN, exitReserve: EXIT_RESERVE });
    for (let i = 0; i < 18; i++) budget.recordExit(0);
    expect(budget.usageSnapshot(60_001).exitUsed).toBe(0);
  });
});
