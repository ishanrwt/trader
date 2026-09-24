import { describe, expect, it, vi } from "vitest";
import { paperEntryFill, paperExitFill, shouldWriteOff } from "../../src/executor/paper.js";

const CFG = { latencySec: 3, extraSlippagePct: 2, feeUsdPerTx: 0.05 };
const noopSleep = async () => {};

describe("paperEntryFill", () => {
  it("waits PAPER_LATENCY_SEC before quoting", async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    await paperEntryFill(25, async () => ({ tokensOut: 1000 }), CFG, sleepFn);
    expect(sleepFn).toHaveBeenCalledWith(3000);
  });

  it("applies PAPER_EXTRA_SLIPPAGE_PCT to the quoted tokens and adds the fee to cost basis", async () => {
    const result = await paperEntryFill(25, async () => ({ tokensOut: 1000 }), CFG, noopSleep);
    expect(result).toEqual({ tokens: 980, costBasis: 25.05 }); // 1000 * (1 - 0.02) = 980
  });

  it("returns null when there's no route", async () => {
    const result = await paperEntryFill(25, async () => null, CFG, noopSleep);
    expect(result).toBeNull();
  });
});

describe("paperExitFill", () => {
  it("applies extra slippage and subtracts the fee from proceeds", async () => {
    const result = await paperExitFill(async () => ({ usdcOut: 100 }), CFG, noopSleep);
    expect(result).toEqual({ proceeds: 100 * 0.98 - 0.05 });
  });

  it("returns null when there's no route", async () => {
    const result = await paperExitFill(async () => null, CFG, noopSleep);
    expect(result).toBeNull();
  });
});

describe("shouldWriteOff", () => {
  it("is false before STUCK_WRITE_OFF_MIN has elapsed since closingSince, true at/after", () => {
    const closingSince = 0;
    expect(shouldWriteOff(closingSince, 29 * 60_000, 30)).toBe(false);
    expect(shouldWriteOff(closingSince, 30 * 60_000, 30)).toBe(true);
  });
});
