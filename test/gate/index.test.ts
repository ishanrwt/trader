import { describe, expect, it } from "vitest";
import { evaluatePhase1Gate } from "../../src/gate/index.js";
import type { DexPair } from "../../src/types.js";

const MINT = "Mint111111111111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function validPair(liquidityUsd: number): DexPair {
  return {
    chainId: "solana",
    pairAddress: "p1",
    baseToken: { address: MINT },
    quoteToken: { address: USDC },
    liquidity: { usd: liquidityUsd },
  };
}

const baseInput = {
  now: 1_000_000,
  isHeld: false,
  wasTradedBefore: false,
  reentryEnabled: false,
  pair: validPair(20_000),
  minLiquidityUsd: 10_000,
  firstEligibleAt: null,
  entryWindowMin: 15,
};

describe("evaluatePhase1Gate", () => {
  it("passes when checks 1-4 all clear, and sets firstEligibleAt on first pass", () => {
    const result = evaluatePhase1Gate(baseInput);
    expect(result).toEqual({ outcome: "passed", firstEligibleAt: 1_000_000 });
  });

  it("check 1 (duplicate, permanent): fails when the mint is currently held", () => {
    const result = evaluatePhase1Gate({ ...baseInput, isHeld: true });
    expect(result).toMatchObject({ outcome: "permanent_fail", check: "duplicate" });
  });

  it("check 1 (duplicate, permanent): fails when traded before and re-entry is disabled", () => {
    const result = evaluatePhase1Gate({ ...baseInput, wasTradedBefore: true, reentryEnabled: false });
    expect(result).toMatchObject({ outcome: "permanent_fail", check: "duplicate" });
  });

  it("check 1: passes when traded before but re-entry is enabled", () => {
    const result = evaluatePhase1Gate({ ...baseInput, wasTradedBefore: true, reentryEnabled: true });
    expect(result.outcome).toBe("passed");
  });

  it("check 2 (pair, temporary): fails when there's no valid pair", () => {
    const result = evaluatePhase1Gate({ ...baseInput, pair: null });
    expect(result).toMatchObject({ outcome: "temporary_fail", check: "pair" });
  });

  it("check 3 (liquidity, temporary): fails below MIN_LIQUIDITY_USD and does not set firstEligibleAt", () => {
    const result = evaluatePhase1Gate({ ...baseInput, pair: validPair(5_000) });
    expect(result).toMatchObject({ outcome: "temporary_fail", check: "liquidity", firstEligibleAt: null });
  });

  it("check 3: preserves an already-set firstEligibleAt rather than resetting it", () => {
    const result = evaluatePhase1Gate({ ...baseInput, firstEligibleAt: 500_000 });
    expect(result).toMatchObject({ outcome: "passed", firstEligibleAt: 500_000 });
  });

  it("check 4 (entry window, permanent): fails once now - firstEligibleAt exceeds ENTRY_WINDOW_MIN", () => {
    const firstEligibleAt = 1_000_000;
    const now = firstEligibleAt + 16 * 60_000; // 16 minutes later, window is 15
    const result = evaluatePhase1Gate({ ...baseInput, now, firstEligibleAt });
    expect(result).toMatchObject({ outcome: "permanent_fail", check: "entryWindow" });
  });

  it("check 4: passes exactly at the window boundary", () => {
    const firstEligibleAt = 1_000_000;
    const now = firstEligibleAt + 15 * 60_000; // exactly 15 minutes, not yet exceeded
    const result = evaluatePhase1Gate({ ...baseInput, now, firstEligibleAt });
    expect(result.outcome).toBe("passed");
  });

  it("uses only pairs matching the quote-mint filter (via a pre-selected pair)", () => {
    // selectPair() already filters by quote mint before the gate ever sees a pair;
    // if nothing qualified, the gate receives pair: null and fails check 2.
    const result = evaluatePhase1Gate({ ...baseInput, pair: null });
    expect(result).toMatchObject({ outcome: "temporary_fail", check: "pair" });
  });
});
