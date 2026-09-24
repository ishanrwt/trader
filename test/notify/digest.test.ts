import { describe, expect, it } from "vitest";
import { buildDigest, type Phase1DigestInput } from "../../src/notify/digest.js";

function baseInput(overrides: Partial<Phase1DigestInput> = {}): Phase1DigestInput {
  return {
    mode: "PAPER",
    now: 3_600_000,
    startedAt: 0,
    paused: false,
    solPriceUsd: 150.5,
    funnel: { discovered: 10, pendingNow: 4, skipReasons: {} },
    health: {
      dexScreenerErrors: 0,
      rpcErrors: 0,
      jupiterRequestsPerMinAvg: 0,
      jupiterRequestsPerMinPeak: 0,
      jupiter429s: 0,
      deferredEntryChecks: 0,
      downtimeGaps: [],
    },
    ...overrides,
  };
}

describe("buildDigest", () => {
  it("labels the digest with the mode", () => {
    expect(buildDigest(baseInput({ mode: "PAPER" }))).toContain("=== Trader digest (PAPER) ===");
  });

  it("says READY/entered/score are not yet implemented in Phase 1", () => {
    expect(buildDigest(baseInput())).toContain("READY / entered / score range: not yet implemented (Phase 2)");
  });

  it("shows the top skip reasons sorted by count, capped at 3", () => {
    const text = buildDigest(
      baseInput({
        funnel: { discovered: 5, pendingNow: 2, skipReasons: { liquidity: 10, pair: 3, entryWindow: 7, duplicate: 1 } },
      }),
    );
    expect(text).toContain("top skip reasons: liquidity=10, entryWindow=7, pair=3");
  });

  it("shows 'none' when there are no skip reasons", () => {
    expect(buildDigest(baseInput())).toContain("top skip reasons: none");
  });

  it("shows the pause reason when paused", () => {
    const text = buildDigest(baseInput({ paused: true, pauseReason: "manual" }));
    expect(text).toContain("paused: true (manual)");
  });

  it("omits SOL/USD when the price isn't known yet", () => {
    expect(buildDigest(baseInput({ solPriceUsd: null }))).not.toContain("SOL/USD");
  });

  it("lists downtime gaps when present", () => {
    const text = buildDigest(baseInput({ health: { ...baseInput().health, downtimeGaps: [{ from: 0, to: 90_000 }] } }));
    expect(text).toContain("Downtime gaps this period: 1m 30s");
  });
});
