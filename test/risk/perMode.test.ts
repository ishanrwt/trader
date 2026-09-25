import { describe, expect, it } from "vitest";
import { applyTradeToLossStreak, perModeKey, realizedNetPnlForDay, recordTradeOutcome, unrealizedLossForMode, updateDailyLossHalt } from "../../src/risk/index.js";
import { openDb } from "../../src/storage/db.js";
import { StateStore } from "../../src/storage/state.js";

const DAY = "2026-09-25";

describe("per-mode accounting (SPEC.md section 9.1, A12)", () => {
  const trades = [
    { mode: "paper", tradingDay: DAY, netPnlUsd: -40 },
    { mode: "live", tradingDay: DAY, netPnlUsd: -5 },
    { mode: "live", tradingDay: "2026-09-24", netPnlUsd: -100 },
  ];
  const feeLosses = [
    { mode: "live", tradingDay: DAY, usd: 0.5 },
    { mode: "live", tradingDay: "2026-09-24", usd: 9 },
  ];

  it("live daily loss counts only live trades and live fee losses of that trading day", () => {
    expect(realizedNetPnlForDay(trades, feeLosses, "live", DAY)).toBeCloseTo(-5.5, 12);
  });

  it("paper daily loss never includes live trades or fee losses", () => {
    expect(realizedNetPnlForDay(trades, feeLosses, "paper", DAY)).toBe(-40);
  });

  it("a paper loss past the cap halts paper entries but not live entries", () => {
    const cfg = { maxDailyLossUsd: 30, tradingDayTz: "UTC" };
    const now = Date.parse(`${DAY}T12:00:00Z`);
    expect(updateDailyLossHalt(null, realizedNetPnlForDay(trades, feeLosses, "paper", DAY), 0, now, cfg)).toBe(DAY);
    expect(updateDailyLossHalt(null, realizedNetPnlForDay(trades, feeLosses, "live", DAY), 0, now, cfg)).toBeNull();
  });

  it("fee losses from failed transactions push live daily loss over the cap", () => {
    const cfg = { maxDailyLossUsd: 30, tradingDayTz: "UTC" };
    const now = Date.parse(`${DAY}T12:00:00Z`);
    const heavy = [...feeLosses, { mode: "live", tradingDay: DAY, usd: 25 }];
    expect(updateDailyLossHalt(null, realizedNetPnlForDay(trades, heavy, "live", DAY), 0, now, cfg)).toBe(DAY);
  });

  it("unrealized losses count only the current mode's open positions", () => {
    const positions = [
      { id: 1, mode: "paper", costBasis: 25 },
      { id: 2, mode: "live", costBasis: 25 },
    ];
    const values = new Map([
      [1, 10],
      [2, 24],
    ]);
    expect(unrealizedLossForMode(positions, values, "live")).toBe(-1);
    expect(unrealizedLossForMode(positions, values, "paper")).toBe(-15);
  });

  it("the loss streak and pause are stored per mode: a paper losing streak never pauses live entries", () => {
    const db = openDb(":memory:");
    const state = new StateStore(db);
    const cfg = { consecutiveLossPause: 2, lossPauseMinutes: 60 };
    for (let i = 0; i < 2; i++) {
      const s = recordTradeOutcome({ consecutiveLosses: state.get(perModeKey("lossStreak", "paper"), 0), pauseUntil: null }, -1, 1_000, cfg);
      state.set(perModeKey("lossStreak", "paper"), s.consecutiveLosses);
      state.set(perModeKey("lossPauseUntil", "paper"), s.pauseUntil);
    }
    expect(state.get(perModeKey("lossPauseUntil", "paper"), null)).not.toBeNull();
    expect(state.get(perModeKey("lossStreak", "live"), 0)).toBe(0);
    expect(state.get(perModeKey("lossPauseUntil", "live"), null)).toBeNull();
    expect(perModeKey("dailyLossHaltDay", "live")).not.toBe(perModeKey("dailyLossHaltDay", "paper"));
    db.close();
  });
});

describe("reconciled closes and the loss streak (SPEC.md section 16.5)", () => {
  const cfg = { consecutiveLossPause: 2, lossPauseMinutes: 60 };
  it("a proceeds_unknown (reconciled) close neither extends nor resets the loss streak", () => {
    const one = { consecutiveLosses: 1, pauseUntil: null };
    expect(applyTradeToLossStreak(one, { netPnlUsd: -25, proceedsUnknown: true }, 1_000, cfg)).toEqual(one);
    // A real loss after it still pauses: the reconciled close didn't reset the count either.
    expect(applyTradeToLossStreak(one, { netPnlUsd: -1, proceedsUnknown: false }, 1_000, cfg)).toEqual({ consecutiveLosses: 2, pauseUntil: 1_000 + 3_600_000 });
  });

  it("a reconciled close still counts in daily loss", () => {
    const trades = [{ mode: "live", tradingDay: DAY, netPnlUsd: -25 }];
    expect(realizedNetPnlForDay(trades, [], "live", DAY)).toBe(-25);
  });
});
