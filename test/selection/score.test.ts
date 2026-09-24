import { describe, expect, it } from "vitest";
import { computeScore, type ScoreConfig } from "../../src/selection/score.js";

// Spec defaults (SPEC.md section 13).
const CFG: ScoreConfig = {
  weights: { buyPressure: 0.25, activity: 0.2, momentum: 0.2, depth: 0.15, holders: 0.1, freshness: 0.1 },
  activityCap: 0.5,
  momentumCapPct: 100,
  minLiquidityUsd: 10_000,
  depthCapUsd: 200_000,
  maxTop10Pct: 40,
  entryWindowMin: 15,
};

describe("computeScore", () => {
  it("matches a hand-computed example", () => {
    const result = computeScore(
      {
        buysM5: 8,
        sellsM5: 4,
        volumeM5: 2000,
        liquidityUsd: 20_000,
        m5ChangePct: 5,
        h1ChangePct: 10,
        top10Pct: 20,
        minutesSinceEligible: 5,
      },
      CFG,
    );
    expect(result.components.buyPressure).toBeCloseTo(0.6667, 3);
    expect(result.components.activity).toBeCloseTo(0.2, 4);
    expect(result.components.momentum).toBeCloseTo(0.075, 4);
    expect(result.components.depth).toBeCloseTo(0.23138, 4);
    expect(result.components.holders).toBeCloseTo(0.5, 4);
    expect(result.components.freshness).toBeCloseTo(0.6667, 3);
    expect(result.score).toBeCloseTo(0.37305, 4);
  });

  it("buyPressure is 0, not NaN, when there are no m5 txns", () => {
    const result = computeScore(
      { buysM5: 0, sellsM5: 0, volumeM5: 0, liquidityUsd: 20_000, m5ChangePct: 0, h1ChangePct: 0, top10Pct: 0, minutesSinceEligible: 0 },
      CFG,
    );
    expect(result.components.buyPressure).toBe(0);
    expect(Number.isNaN(result.score)).toBe(false);
  });

  it("clips activity to 1 when volume/liquidity far exceeds the cap", () => {
    const result = computeScore(
      { buysM5: 1, sellsM5: 1, volumeM5: 1_000_000, liquidityUsd: 10_000, m5ChangePct: 0, h1ChangePct: 0, top10Pct: 0, minutesSinceEligible: 0 },
      CFG,
    );
    expect(result.components.activity).toBe(1);
  });

  it("clips momentum to 0 for a negative average and to 1 above the cap", () => {
    const negative = computeScore(
      { buysM5: 1, sellsM5: 1, volumeM5: 0, liquidityUsd: 10_000, m5ChangePct: -50, h1ChangePct: -50, top10Pct: 0, minutesSinceEligible: 0 },
      CFG,
    );
    expect(negative.components.momentum).toBe(0);

    const huge = computeScore(
      { buysM5: 1, sellsM5: 1, volumeM5: 0, liquidityUsd: 10_000, m5ChangePct: 500, h1ChangePct: 500, top10Pct: 0, minutesSinceEligible: 0 },
      CFG,
    );
    expect(huge.components.momentum).toBe(1);
  });

  it("depth is 0 at MIN_LIQUIDITY_USD and 1 at/above DEPTH_CAP_USD", () => {
    const atMin = computeScore(
      { buysM5: 1, sellsM5: 1, volumeM5: 0, liquidityUsd: 10_000, m5ChangePct: 0, h1ChangePct: 0, top10Pct: 0, minutesSinceEligible: 0 },
      CFG,
    );
    expect(atMin.components.depth).toBeCloseTo(0, 6);

    const atCap = computeScore(
      { buysM5: 1, sellsM5: 1, volumeM5: 0, liquidityUsd: 500_000, m5ChangePct: 0, h1ChangePct: 0, top10Pct: 0, minutesSinceEligible: 0 },
      CFG,
    );
    expect(atCap.components.depth).toBe(1);
  });

  it("freshness clips to 0 once minutesSinceEligible exceeds ENTRY_WINDOW_MIN", () => {
    const result = computeScore(
      { buysM5: 1, sellsM5: 1, volumeM5: 0, liquidityUsd: 10_000, m5ChangePct: 0, h1ChangePct: 0, top10Pct: 0, minutesSinceEligible: 30 },
      CFG,
    );
    expect(result.components.freshness).toBe(0);
  });

  it("holders clips to 0 once top10Pct reaches MAX_TOP10_PCT", () => {
    const result = computeScore(
      { buysM5: 1, sellsM5: 1, volumeM5: 0, liquidityUsd: 10_000, m5ChangePct: 0, h1ChangePct: 0, top10Pct: 90, minutesSinceEligible: 0 },
      CFG,
    );
    expect(result.components.holders).toBe(0);
  });

  it("score never leaves [0,1] for well-formed weights, even at extreme inputs", () => {
    const result = computeScore(
      { buysM5: 1000, sellsM5: 0, volumeM5: 10_000_000, liquidityUsd: 500_000, m5ChangePct: 1000, h1ChangePct: 1000, top10Pct: 0, minutesSinceEligible: 0 },
      CFG,
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});
