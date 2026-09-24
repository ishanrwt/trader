import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shadowEntry, shadowStep, shadowValue } from "../../src/tracking/shadows.js";
import { initialExitState, type ExitStateMachineConfig } from "../../src/monitor/stateMachine.js";

const CFG: ExitStateMachineConfig = {
  stopLossPct: 15,
  extraTargetPct: 10,
  maxTargetExtensions: 1,
  holdMinutes: 15,
  fastGainPct: 15,
  fastWindowMinutes: 5,
  fastMinHistorySec: 60,
  fastConfirmPolls: 2,
  maxTimerRestarts: 3,
  maxTotalHoldMinutes: 60,
  trailPct: 4,
  breakevenTriggerPct: 20,
  breakevenFloorPct: 2,
  flatBandPct: 3,
  liqDropExitPct: 30,
  liqDropConfirmReads: 2,
  noRouteExitSec: 30,
};

describe("shadow cost math (hand-checked)", () => {
  it("shadowEntry, with fees disabled: entryPrice = priceUsd * (1 + size/R)", () => {
    const result = shadowEntry(100, 1, 2000, { poolFeePct: 0, extraSlippagePct: 0, feeUsdPerTx: 0 });
    expect(result.entryPrice).toBeCloseTo(1.1, 10); // R=1000, 1*(1+100/1000)=1.1
    expect(result.tokens).toBeCloseTo(100 / 1.1, 10);
    expect(result.costBasis).toBe(100);
  });

  it("shadowEntry adds fees to cost basis and inflates entry price", () => {
    const result = shadowEntry(100, 1, 2000, { poolFeePct: 1, extraSlippagePct: 2, feeUsdPerTx: 0.05 });
    expect(result.costBasis).toBe(100.05);
    expect(result.entryPrice).toBeGreaterThan(1.1); // fees push the effective entry price up
  });

  it("shadowValue, with fees disabled: proceeds = V * R'/(R'+V)", () => {
    const proceeds = shadowValue(100, 1, 2000, { poolFeePct: 0, extraSlippagePct: 0, feeUsdPerTx: 0 });
    expect(proceeds).toBeCloseTo(1000 / 11, 10); // V=100, R'=1000 -> 100*1000/1100
  });

  it("shadowValue applies pool fee, slippage and the flat fee: exact hand-checked result", () => {
    const proceeds = shadowValue(100, 1, 2000, { poolFeePct: 1, extraSlippagePct: 2, feeUsdPerTx: 0.05 });
    // grossProceeds = 100*1000/1100 = 1000/11; * (1-0.01) = 90 exactly (1000/11 * 0.99 = 90);
    // * (1-0.02) = 88.2; - 0.05 = 88.15.
    expect(proceeds).toBeCloseTo(88.15, 6);
  });
});

describe("shadowStep", () => {
  const state = initialExitState({ entryTime: 0, entryLiquidity: 10_000, targetProfitPct: 30, holdMinutes: 15, entryPnlPct: 0 });

  it("never asks for a second quote: a stop-loss reading resolves in one call", () => {
    const result = shadowStep(state, { now: 1000, pnlPct: -20 }, CFG); // would be NEED_CONFIRM for a real position
    expect(result).toMatchObject({ action: "SELL", reason: "stop" });
  });

  it("a missing pair (null pnlPct) is treated as no route, same as a real position", () => {
    const result = shadowStep(state, { now: 1000, pnlPct: null }, CFG);
    expect(result.action).toBe("HOLD");
    expect(result.newState.noRouteSince).toBe(1000);
  });
});

describe("shadows never call Jupiter", () => {
  it("the source file makes no reference to Jupiter at all", () => {
    const filePath = fileURLToPath(new URL("../../src/tracking/shadows.ts", import.meta.url));
    const source = fs.readFileSync(filePath, "utf8");
    expect(source.toLowerCase()).not.toContain("jupiter");
    expect(path.basename(filePath)).toBe("shadows.ts");
  });
});
