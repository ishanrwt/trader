import { describe, expect, it, vi } from "vitest";
import { pollOpenPositions, type PollPositionInput } from "../../src/monitor/index.js";
import { initialExitState, type ExitStateMachineConfig } from "../../src/monitor/stateMachine.js";
import { logStopConfirm, stopCloseFields } from "../../src/monitor/stopConfirm.js";
import { createMemoryLogger } from "../../src/logger/index.js";
import { openDb } from "../../src/storage/db.js";
import { recentEvents } from "../../src/storage/events.js";
import { PositionsStore, type NewPositionRow } from "../../src/storage/positions.js";
import { TradesStore } from "../../src/storage/trades.js";

const CFG: ExitStateMachineConfig = {
  stopLossPct: 15, extraTargetPct: 10, maxTargetExtensions: 1, holdMinutes: 15, fastGainPct: 15, fastWindowMinutes: 5, fastMinHistorySec: 60,
  fastConfirmPolls: 2, maxTimerRestarts: 3, maxTotalHoldMinutes: 60, trailPct: 4, breakevenTriggerPct: 20, breakevenFloorPct: 2, flatBandPct: 3,
  liqDropExitPct: 30, liqDropConfirmReads: 2, noRouteExitSec: 30,
};

function position(mint: string): NewPositionRow {
  return {
    mode: "paper", mint, symbol: mint, pairAddress: "PAIR", status: "open", entryTime: 0, sizeUsd: 25, tokenAmount: 100, costBasis: 25.05,
    entryLiquidityUsd: 10_000, entryPairSnapshot: { dexId: "pumpswap" }, score: 0.5, scoreComponents: null, safetyResult: null, holdersResult: null,
    peakPnl: 0, currentTarget: 30, targetExtensions: 0, timerRestarts: 0, lastRestartAt: null, deadline: 900_000, trailArmed: false, fastStreak: 0,
    lowLiqStreak: 0, noRouteSince: null, closingSince: null, pendingExitReason: null, lastPnlPct: null, lastValueUsd: null, lastPolledAt: null,
    tokenDecimals: 6, entryValuationPnlPct: null, entryQuoteInAmount: null, entryQuoteOutAmount: null,
    sellabilityLossPct: 3.1, sellabilityCheckedAt: -5_000, dexId: "pumpswap",
  };
}

function state() {
  return initialExitState({ entryTime: 0, entryLiquidity: 10_000, targetProfitPct: 30, holdMinutes: 15, entryPnlPct: 0 });
}

describe("stopCloseFields", () => {
  it("returns both values for a stop, including a null (no-route) confirmation", () => {
    expect(stopCloseFields("stop", { pollPnlPct: -16, confirmPnlPct: -18, confirmed: true })).toEqual({ stopPollPnlPct: -16, stopConfirmPnlPct: -18 });
    expect(stopCloseFields("stop", { pollPnlPct: -16, confirmPnlPct: null, confirmed: true })).toEqual({ stopPollPnlPct: -16, stopConfirmPnlPct: null });
  });

  it("returns nothing for other exits or when there was no confirmation round trip", () => {
    expect(stopCloseFields("target", undefined)).toEqual({});
    expect(stopCloseFields("liq_pull", { pollPnlPct: -16, confirmPnlPct: -18, confirmed: true })).toEqual({});
    expect(stopCloseFields("stop", undefined)).toEqual({});
  });
});

describe("stop confirmation end to end (real DB, the same handlers src/index.ts uses)", () => {
  it("a confirmed stop lands both values on the trade; a disagreeing confirmation is held; each round trip logs one stop_confirm event", async () => {
    const db = openDb(":memory:");
    const positions = new PositionsStore(db);
    const trades = new TradesStore(db);
    const stoppedId = positions.insert(position("STOPPED"));
    const heldId = positions.insert(position("HELD"));
    const now = 60_000;

    const inputs: PollPositionInput[] = [
      { id: stoppedId, state: state(), fetchPnlPct: vi.fn().mockResolvedValueOnce(-16.4).mockResolvedValueOnce(-17.02) },
      { id: heldId, state: state(), fetchPnlPct: vi.fn().mockResolvedValueOnce(-15.5).mockResolvedValueOnce(-9.8) },
    ];
    await pollOpenPositions({
      positions: inputs,
      now,
      cfg: CFG,
      onHold: async () => {},
      onStopCheck: (id, check) => logStopConfirm(db, now, id, check),
      onSell: (id, reason, _newState, stopCheck) =>
        positions.update(id, { status: "closing", closingSince: now, pendingExitReason: reason, ...stopCloseFields(reason, stopCheck) }),
      logger: createMemoryLogger(),
    });

    // The position carries the values while closing (survives a restart)...
    const closing = positions.get(stoppedId)!;
    expect(closing).toMatchObject({ status: "closing", pendingExitReason: "stop", stopPollPnlPct: -16.4, stopConfirmPnlPct: -17.02 });
    expect(positions.get(heldId)).toMatchObject({ status: "open", stopPollPnlPct: null, stopConfirmPnlPct: null });

    // ...and finalizeTrade copies them (with the sellability and dexId fields) onto the trade.
    const tradeId = trades.insert({
      mode: closing.mode, mint: closing.mint, symbol: closing.symbol, pairAddress: closing.pairAddress, entryTime: closing.entryTime, exitTime: now,
      sizeUsd: closing.sizeUsd, costBasis: closing.costBasis, proceeds: 20.8, netPnlUsd: -4.25, netPnlPct: -16.97, exitReason: "stop",
      peakPnl: 0, timerRestarts: 0, targetExtensions: 0, feesUsd: 0.1, entryPairSnapshot: closing.entryPairSnapshot, top1Pct: null, top10Pct: null,
      score: closing.score, scoreComponents: null, animalFlag: null, tradingDay: "2026-09-25", tokenAmount: closing.tokenAmount,
      tokenDecimals: closing.tokenDecimals, entryValuationPnlPct: null, entryQuoteInAmount: null, entryQuoteOutAmount: null,
      exitQuoteInAmount: null, exitQuoteOutAmount: null,
      sellabilityLossPct: closing.sellabilityLossPct, sellabilityCheckedAt: closing.sellabilityCheckedAt, dexId: closing.dexId,
      stopPollPnlPct: closing.stopPollPnlPct, stopConfirmPnlPct: closing.stopConfirmPnlPct,
    });
    expect(trades.get(tradeId)).toMatchObject({
      stopPollPnlPct: -16.4, stopConfirmPnlPct: -17.02, sellabilityLossPct: 3.1, sellabilityCheckedAt: -5_000, dexId: "pumpswap",
    });

    const events = recentEvents(db, 0).filter((e) => e.type === "stop_confirm");
    expect(events).toHaveLength(2);
    expect(events.find((e) => (e.meta as { id: number }).id === stoppedId)).toMatchObject({
      message: `Position ${stoppedId} stop confirmed`,
      meta: { id: stoppedId, pollPnlPct: -16.4, confirmPnlPct: -17.02, confirmed: true },
    });
    expect(events.find((e) => (e.meta as { id: number }).id === heldId)).toMatchObject({
      message: `Position ${heldId} stop not confirmed, held`,
      meta: { id: heldId, pollPnlPct: -15.5, confirmPnlPct: -9.8, confirmed: false },
    });
  });
});
