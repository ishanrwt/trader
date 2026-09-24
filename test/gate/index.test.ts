import { describe, expect, it } from "vitest";
import {
  evaluateHolders,
  evaluateMintSafety,
  evaluateMomentumAndBuyPressure,
  evaluatePhase1Gate,
  parseMintAccountInfo,
  type HoldersConfig,
  type MomentumBuyPressureConfig,
} from "../../src/gate/index.js";
import { SPL_TOKEN_2022_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from "../../src/constants.js";
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

const M56_CFG: MomentumBuyPressureConfig = {
  minM5ChangePct: 0,
  minH1ChangePct: 0,
  minH24ChangePct: 0,
  maxH1ChangePct: 0,
  minM5Txns: 10,
  minM5BuySellRatio: 1.0,
  minM5VolumeUsd: 1000,
};

function pairWithMomentum(overrides: Partial<DexPair> = {}): DexPair {
  return {
    ...validPair(20_000),
    priceChange: { m5: 5, h1: 10, h24: 20 },
    txns: { m5: { buys: 8, sells: 4 } },
    volume: { m5: 2000 },
    ...overrides,
  };
}

describe("evaluateMomentumAndBuyPressure", () => {
  it("passes when momentum and buy pressure both clear", () => {
    expect(evaluateMomentumAndBuyPressure(pairWithMomentum(), M56_CFG)).toEqual({ passed: true });
  });

  it("check 5 (momentum, temporary): missing priceChange fields fail", () => {
    const result = evaluateMomentumAndBuyPressure(pairWithMomentum({ priceChange: { m5: 5 } }), M56_CFG);
    expect(result).toMatchObject({ passed: false, check: "momentum" });
  });

  it("check 5: fails when m5/h1/h24 don't clear their minimums", () => {
    expect(evaluateMomentumAndBuyPressure(pairWithMomentum({ priceChange: { m5: 0, h1: 10, h24: 20 } }), M56_CFG)).toMatchObject({
      passed: false,
      check: "momentum",
    });
  });

  it("check 5: fails when h1 exceeds MAX_H1_CHANGE_PCT (when enabled)", () => {
    const cfg = { ...M56_CFG, maxH1ChangePct: 50 };
    const result = evaluateMomentumAndBuyPressure(pairWithMomentum({ priceChange: { m5: 5, h1: 60, h24: 20 } }), cfg);
    expect(result).toMatchObject({ passed: false, check: "momentum" });
  });

  it("check 6 (buy pressure, temporary): fails below MIN_M5_TXNS", () => {
    const result = evaluateMomentumAndBuyPressure(pairWithMomentum({ txns: { m5: { buys: 2, sells: 1 } } }), M56_CFG);
    expect(result).toMatchObject({ passed: false, check: "buyPressure" });
  });

  it("check 6: fails below MIN_M5_BUY_SELL_RATIO", () => {
    const result = evaluateMomentumAndBuyPressure(pairWithMomentum({ txns: { m5: { buys: 4, sells: 8 } } }), M56_CFG);
    expect(result).toMatchObject({ passed: false, check: "buyPressure" });
  });

  it("check 6: fails below MIN_M5_VOLUME_USD", () => {
    const result = evaluateMomentumAndBuyPressure(pairWithMomentum({ volume: { m5: 100 } }), M56_CFG);
    expect(result).toMatchObject({ passed: false, check: "buyPressure" });
  });
});

describe("parseMintAccountInfo + evaluateMintSafety", () => {
  const ALLOWED_EXTENSIONS = ["metadataPointer", "tokenMetadata", "groupPointer", "groupMemberPointer", "tokenGroup", "tokenGroupMember"];
  const SAFETY_CFG = { requireMintRevoked: true, requireFreezeRevoked: true, allowedToken2022Extensions: ALLOWED_EXTENSIONS };

  function rawMint(opts: { owner: string; mintAuthority?: string | null; freezeAuthority?: string | null; extensions?: string[] }) {
    return {
      owner: opts.owner,
      data: {
        parsed: {
          type: "mint",
          info: {
            mintAuthority: opts.mintAuthority ?? null,
            freezeAuthority: opts.freezeAuthority ?? null,
            ...(opts.extensions ? { extensions: opts.extensions.map((extension) => ({ extension })) } : {}),
          },
        },
      },
    };
  }

  it("check 7 (permanent): passes for a plain SPL Token mint with both authorities revoked", () => {
    const info = parseMintAccountInfo(rawMint({ owner: SPL_TOKEN_PROGRAM_ID }));
    expect(evaluateMintSafety(info, SAFETY_CFG)).toEqual({ passed: true, reason: "ok" });
  });

  it("fails when mint authority is not revoked", () => {
    const info = parseMintAccountInfo(rawMint({ owner: SPL_TOKEN_PROGRAM_ID, mintAuthority: "Someone1111111111111111111111111111111111" }));
    expect(evaluateMintSafety(info, SAFETY_CFG).passed).toBe(false);
  });

  it("fails when freeze authority is not revoked", () => {
    const info = parseMintAccountInfo(rawMint({ owner: SPL_TOKEN_PROGRAM_ID, freezeAuthority: "Someone1111111111111111111111111111111111" }));
    expect(evaluateMintSafety(info, SAFETY_CFG).passed).toBe(false);
  });

  it("fails when the owner isn't the SPL Token or Token-2022 program", () => {
    const info = parseMintAccountInfo(rawMint({ owner: "SomeOtherProgram111111111111111111111111" }));
    expect(evaluateMintSafety(info, SAFETY_CFG).passed).toBe(false);
  });

  it("fails when the account doesn't exist / isn't a parsed mint", () => {
    expect(evaluateMintSafety(parseMintAccountInfo(null), SAFETY_CFG).passed).toBe(false);
  });

  it("Token-2022 allowlist: passes when only allowlisted extensions are present", () => {
    const info = parseMintAccountInfo(rawMint({ owner: SPL_TOKEN_2022_PROGRAM_ID, extensions: ["metadataPointer", "tokenMetadata"] }));
    expect(evaluateMintSafety(info, SAFETY_CFG)).toEqual({ passed: true, reason: "ok" });
  });

  it("Token-2022 allowlist: fails when a disallowed extension is present", () => {
    const info = parseMintAccountInfo(rawMint({ owner: SPL_TOKEN_2022_PROGRAM_ID, extensions: ["metadataPointer", "transferFeeConfig"] }));
    const result = evaluateMintSafety(info, SAFETY_CFG);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("transferFeeConfig");
  });
});

describe("evaluateHolders", () => {
  const HOLDERS_CFG: HoldersConfig = { maxTop1Pct: 15, maxTop10Pct: 40, poolVaultTolerancePct: 2, burnAddresses: ["Burn1111111111111111111111111111111111111"] };

  it("check 8 (temporary): passes when top1/top10 shares are within limits", () => {
    const largest = [
      { address: "A", uiAmount: 5_000 },
      { address: "B", uiAmount: 3_000 },
    ];
    const result = evaluateHolders(largest, 100_000, [], HOLDERS_CFG);
    expect(result.passed).toBe(true);
    expect(result.top1Pct).toBeCloseTo(5);
  });

  it("fails when top1 share exceeds MAX_TOP1_PCT", () => {
    const largest = [{ address: "A", uiAmount: 20_000 }];
    const result = evaluateHolders(largest, 100_000, [], HOLDERS_CFG);
    expect(result).toMatchObject({ passed: false });
    expect(result.reason).toContain("top1");
  });

  it("fails when top10 share exceeds MAX_TOP10_PCT", () => {
    const largest = Array.from({ length: 10 }, (_, i) => ({ address: `H${i}`, uiAmount: 5_000 }));
    const result = evaluateHolders(largest, 100_000, [], HOLDERS_CFG); // 50,000 / 100,000 = 50% > 40%
    expect(result).toMatchObject({ passed: false });
    expect(result.reason).toContain("top10");
  });

  it("pool-vault exclusion: excludes an account within 2% of a valid pair's liquidity.base", () => {
    const pair: DexPair = { ...validPair(20_000), liquidity: { usd: 20_000, base: 1_000_000 } };
    const largest = [
      { address: "PoolVault", uiAmount: 1_005_000 }, // within 2% of 1,000,000
      { address: "Whale", uiAmount: 4_000 },
    ];
    const result = evaluateHolders(largest, 100_000, [pair], HOLDERS_CFG);
    expect(result.top1Pct).toBeCloseTo(4); // the pool vault is excluded; only "Whale" counts
  });

  it("excludes known burn addresses", () => {
    const largest = [
      { address: "Burn1111111111111111111111111111111111111", uiAmount: 50_000 },
      { address: "Whale", uiAmount: 3_000 },
    ];
    const result = evaluateHolders(largest, 100_000, [], HOLDERS_CFG);
    expect(result.top1Pct).toBeCloseTo(3);
  });
});
