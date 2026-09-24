import { describe, expect, it } from "vitest";
import { computeJupiterBudget, unknownKeys, validateWeights } from "../../src/config/validate.js";

describe("validateWeights", () => {
  it("accepts weights that sum to exactly 1.0", () => {
    const result = validateWeights({
      wBuyPressure: 0.25,
      wActivity: 0.2,
      wMomentum: 0.2,
      wDepth: 0.15,
      wHolders: 0.1,
      wFreshness: 0.1,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts weights within +/- 0.01 tolerance", () => {
    const result = validateWeights({
      wBuyPressure: 0.25,
      wActivity: 0.2,
      wMomentum: 0.2,
      wDepth: 0.15,
      wHolders: 0.1,
      wFreshness: 0.105,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects weights that sum too far from 1.0", () => {
    const result = validateWeights({
      wBuyPressure: 0.25,
      wActivity: 0.2,
      wMomentum: 0.2,
      wDepth: 0.15,
      wHolders: 0.1,
      wFreshness: 0.2,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sum to/);
  });
});

describe("computeJupiterBudget", () => {
  it("accepts the spec's own defaults without stretching", () => {
    // MAX_CONCURRENT=3, POLL_SECONDS=10 -> exitReserve = 3*ceil(60/10)+5 = 23
    // 23 + ENTRY_MIN_BUDGET_PER_MIN(10) = 33 <= JUPITER_MAX_REQ_PER_MIN(45)
    const result = computeJupiterBudget({
      maxConcurrent: 3,
      pollSeconds: 10,
      exitReserveExtraPerMin: 5,
      entryMinBudgetPerMin: 10,
      jupiterMaxReqPerMin: 45,
      autoStretchPoll: false,
    });
    expect(result).toEqual({ ok: true, pollSeconds: 10, exitReserve: 23, stretched: false });
  });

  it("refuses to start on an over-budget config without AUTO_STRETCH_POLL", () => {
    const result = computeJupiterBudget({
      maxConcurrent: 10,
      pollSeconds: 5,
      exitReserveExtraPerMin: 5,
      entryMinBudgetPerMin: 10,
      jupiterMaxReqPerMin: 45,
      autoStretchPoll: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Jupiter budget exceeded/);
  });

  it("raises POLL_SECONDS until the budget fits when AUTO_STRETCH_POLL is true", () => {
    const result = computeJupiterBudget({
      maxConcurrent: 10,
      pollSeconds: 5,
      exitReserveExtraPerMin: 5,
      entryMinBudgetPerMin: 10,
      jupiterMaxReqPerMin: 45,
      autoStretchPoll: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stretched).toBe(true);
      // exitReserve = 10*ceil(60/poll)+5 must satisfy +10 <= 45 -> exitReserve <= 35 -> ceil(60/poll) <= 3 -> poll >= 20
      expect(result.pollSeconds).toBeGreaterThanOrEqual(20);
      const expectedReserve = 10 * Math.ceil(60 / result.pollSeconds) + 5;
      expect(result.exitReserve).toBe(expectedReserve);
      expect(result.exitReserve + 10).toBeLessThanOrEqual(45);
    }
  });

  it("refuses to start if even the maximum stretch can't fit the budget", () => {
    const result = computeJupiterBudget({
      maxConcurrent: 1000,
      pollSeconds: 5,
      exitReserveExtraPerMin: 5,
      entryMinBudgetPerMin: 10,
      jupiterMaxReqPerMin: 45,
      autoStretchPoll: true,
    });
    expect(result.ok).toBe(false);
  });
});

describe("unknownKeys", () => {
  it("returns keys not present in the known set", () => {
    expect(unknownKeys(["MODE", "FOO_BAR", "POLL_SECONDS"], ["MODE", "POLL_SECONDS"])).toEqual(["FOO_BAR"]);
  });

  it("returns an empty array when everything is known", () => {
    expect(unknownKeys(["MODE"], ["MODE", "POLL_SECONDS"])).toEqual([]);
  });
});
