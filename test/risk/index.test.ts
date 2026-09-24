import { describe, expect, it } from "vitest";
import {
  checkEntryBlockers,
  checkKillSwitch,
  recordTradeOutcome,
  updateDailyLossHalt,
  type EntryBlockerState,
} from "../../src/risk/index.js";

const BLOCKER_CFG = { maxConsecutiveErrors: 5, maxConcurrent: 3 };

function baseState(overrides: Partial<EntryBlockerState> = {}): EntryBlockerState {
  return {
    killed: false,
    paused: false,
    dailyLossHaltDay: null,
    pauseUntil: null,
    consecutiveErrors: 0,
    openPositionsCount: 0,
    ...overrides,
  };
}

describe("checkEntryBlockers", () => {
  it("returns null when nothing blocks", () => {
    expect(checkEntryBlockers(baseState(), 1000, BLOCKER_CFG)).toBeNull();
  });

  it("kill switch wins over everything else", () => {
    expect(checkEntryBlockers(baseState({ killed: true, paused: true }), 1000, BLOCKER_CFG)).toBe("kill_switch");
  });

  it("paused blocks entries", () => {
    expect(checkEntryBlockers(baseState({ paused: true }), 1000, BLOCKER_CFG)).toBe("paused");
  });

  it("daily loss halt blocks entries", () => {
    expect(checkEntryBlockers(baseState({ dailyLossHaltDay: "2026-01-01" }), 1000, BLOCKER_CFG)).toBe("daily_loss_halt");
  });

  it("loss-streak pause blocks entries only until pauseUntil", () => {
    const state = baseState({ pauseUntil: 5000 });
    expect(checkEntryBlockers(state, 1000, BLOCKER_CFG)).toBe("loss_streak_pause");
    expect(checkEntryBlockers(state, 5000, BLOCKER_CFG)).toBeNull(); // pause has elapsed
  });

  it("error halt blocks entries once MAX_CONSECUTIVE_ERRORS is reached", () => {
    expect(checkEntryBlockers(baseState({ consecutiveErrors: 4 }), 1000, BLOCKER_CFG)).toBeNull();
    expect(checkEntryBlockers(baseState({ consecutiveErrors: 5 }), 1000, BLOCKER_CFG)).toBe("error_halt");
  });

  it("slots_full blocks entries once open positions reach MAX_CONCURRENT", () => {
    expect(checkEntryBlockers(baseState({ openPositionsCount: 2 }), 1000, BLOCKER_CFG)).toBeNull();
    expect(checkEntryBlockers(baseState({ openPositionsCount: 3 }), 1000, BLOCKER_CFG)).toBe("slots_full");
  });
});

describe("updateDailyLossHalt", () => {
  const CFG = { maxDailyLossUsd: 30, tradingDayTz: "Asia/Kolkata" };

  it("triggers when realized + unrealized losses cross -MAX_DAILY_LOSS_USD", () => {
    const now = Date.UTC(2026, 0, 1, 6); // mid-day IST
    const halted = updateDailyLossHalt(null, -20, -15, now, CFG); // total -35 <= -30
    expect(halted).not.toBeNull();
  });

  it("does not trigger above the threshold", () => {
    const now = Date.UTC(2026, 0, 1, 6);
    expect(updateDailyLossHalt(null, -10, -5, now, CFG)).toBeNull();
  });

  it("stays halted for the rest of the trading day even if unrealized losses shrink back (not clearable by /resume)", () => {
    const now = Date.UTC(2026, 0, 1, 6);
    const haltedDay = updateDailyLossHalt(null, -20, -15, now, CFG);
    expect(haltedDay).not.toBeNull();
    // Unrealized loss recovers later the same day; halt must stay sticky.
    const stillHalted = updateDailyLossHalt(haltedDay, -20, 0, now + 60_000, CFG);
    expect(stillHalted).toBe(haltedDay);
  });

  it("clears only once a new trading day begins", () => {
    const day1 = Date.UTC(2026, 0, 1, 6);
    const haltedDay = updateDailyLossHalt(null, -40, 0, day1, CFG);
    expect(haltedDay).not.toBeNull();

    const day2 = Date.UTC(2026, 0, 2, 6); // next calendar day in Asia/Kolkata
    const cleared = updateDailyLossHalt(haltedDay, -40, 0, day2, CFG);
    expect(cleared).toBeNull();
  });
});

describe("recordTradeOutcome", () => {
  const CFG = { consecutiveLossPause: 5, lossPauseMinutes: 60 };

  it("a win resets the streak", () => {
    const result = recordTradeOutcome({ consecutiveLosses: 4, pauseUntil: null }, 10, 1000, CFG);
    expect(result).toEqual({ consecutiveLosses: 0, pauseUntil: null });
  });

  it("pauses after CONSECUTIVE_LOSS_PAUSE losses in a row", () => {
    let state = { consecutiveLosses: 0, pauseUntil: null as number | null };
    for (let i = 0; i < 4; i++) state = recordTradeOutcome(state, -5, 1000, CFG);
    expect(state.pauseUntil).toBeNull();
    state = recordTradeOutcome(state, -5, 1000, CFG); // 5th loss
    expect(state.consecutiveLosses).toBe(5);
    expect(state.pauseUntil).toBe(1000 + 60 * 60_000);
  });

  it("a break-even trade (net PnL USD == 0) counts as a loss, matching the win definition", () => {
    const result = recordTradeOutcome({ consecutiveLosses: 0, pauseUntil: null }, 0, 1000, CFG);
    expect(result.consecutiveLosses).toBe(1);
  });
});

describe("checkKillSwitch", () => {
  it("is inactive when neither the KILL file nor the flag is set", () => {
    expect(checkKillSwitch(false, false, false)).toEqual({ active: false, justActivated: false });
  });

  it("activates from the KILL file alone", () => {
    expect(checkKillSwitch(false, true, false)).toEqual({ active: true, justActivated: true });
  });

  it("activates from /killswitch alone", () => {
    expect(checkKillSwitch(false, false, true)).toEqual({ active: true, justActivated: true });
  });

  it("does not report justActivated on repeated checks once already active", () => {
    expect(checkKillSwitch(true, true, false)).toEqual({ active: true, justActivated: false });
  });

  it("is independent of entry blockers: fires even when checkEntryBlockers would already report slots_full", () => {
    // The bug this guards against: an earlier design only checked the kill switch inside
    // the slot-filling attempt, so it silently did nothing once MAX_CONCURRENT was reached.
    const blockerState = baseState({ openPositionsCount: 3 }); // slots full
    expect(checkEntryBlockers(blockerState, 1000, BLOCKER_CFG)).toBe("slots_full");

    // The kill switch's own check runs on its own timer and doesn't consult blocker state at all.
    const killResult = checkKillSwitch(false, true, false);
    expect(killResult.active).toBe(true);
  });
});
