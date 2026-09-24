import type { DexPair } from "../types.js";

export type GateCheckId = "duplicate" | "pair" | "liquidity" | "entryWindow";

export interface Phase1GateInput {
  now: number;
  /** Checks 1-4 only (SPEC.md section 15); checks 5-8 need positions/trades/RPC data that don't exist until Phase 2. */
  isHeld: boolean;
  wasTradedBefore: boolean;
  reentryEnabled: boolean;
  /** Already selected via clients/dexscreener.ts selectPair(), or null if none valid. */
  pair: DexPair | null;
  minLiquidityUsd: number;
  /** Persisted on the pending row; null until liquidity first passes. */
  firstEligibleAt: number | null;
  entryWindowMin: number;
}

export type Phase1GateResult =
  | { outcome: "permanent_fail"; check: GateCheckId; reason: string; firstEligibleAt: number | null }
  | { outcome: "temporary_fail"; check: GateCheckId; reason: string; firstEligibleAt: number | null }
  /** Cleared checks 1-4. Stays "pending" — Phase 1 has no checks 5-8, so READY is never reached. */
  | { outcome: "passed"; firstEligibleAt: number };

/**
 * SPEC.md section 5, checks 1-4, evaluated in order; the first failure wins.
 * Checks 5-8 (momentum, buy pressure, mint safety, holders) are Phase 2.
 */
export function evaluatePhase1Gate(input: Phase1GateInput): Phase1GateResult {
  // 1. Duplicate (permanent)
  if (input.isHeld || (input.wasTradedBefore && !input.reentryEnabled)) {
    return {
      outcome: "permanent_fail",
      check: "duplicate",
      reason: input.isHeld
        ? "mint is currently held"
        : "mint was traded before and REENTRY_ENABLED is false",
      firstEligibleAt: input.firstEligibleAt,
    };
  }

  // 2. Pair (temporary)
  if (!input.pair) {
    return {
      outcome: "temporary_fail",
      check: "pair",
      reason: "no valid pair under the pair selection rule",
      firstEligibleAt: input.firstEligibleAt,
    };
  }

  // 3. Liquidity (temporary)
  const liquidityUsd = input.pair.liquidity?.usd ?? 0;
  if (liquidityUsd < input.minLiquidityUsd) {
    return {
      outcome: "temporary_fail",
      check: "liquidity",
      reason: `liquidity $${liquidityUsd} < MIN_LIQUIDITY_USD $${input.minLiquidityUsd}`,
      firstEligibleAt: input.firstEligibleAt,
    };
  }
  const firstEligibleAt = input.firstEligibleAt ?? input.now;

  // 4. Entry window (permanent)
  const ageMs = input.now - firstEligibleAt;
  const windowMs = input.entryWindowMin * 60_000;
  if (ageMs > windowMs) {
    return {
      outcome: "permanent_fail",
      check: "entryWindow",
      reason: `entry window of ${input.entryWindowMin}m expired ${Math.round((ageMs - windowMs) / 1000)}s ago`,
      firstEligibleAt,
    };
  }

  return { outcome: "passed", firstEligibleAt };
}
