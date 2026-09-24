import { describe, expect, it } from "vitest";
import { finalPeakPnl, initialExitState, step, type ExitState, type ExitStateMachineConfig } from "../../src/monitor/stateMachine.js";

// Spec defaults (SPEC.md section 13).
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

function entryState(overrides: Partial<Parameters<typeof initialExitState>[0]> = {}): ExitState {
  return initialExitState({ entryTime: 0, entryLiquidity: 10_000, targetProfitPct: 30, holdMinutes: 15, entryPnlPct: 0, ...overrides });
}

describe("initialExitState: entry valuation (SPEC.md section 8.1)", () => {
  it("records a negative first history point when the entry-valuation sell quote returns less than cost basis", () => {
    // A caller computes entryPnlPct from a real exit-lane quote fetched right after the
    // entry fill; round-trip fees/slippage/price-impact typically put this below zero.
    const s = initialExitState({ entryTime: 5000, entryLiquidity: 10_000, targetProfitPct: 30, holdMinutes: 15, entryPnlPct: -3.2 });
    expect(s.history).toEqual([{ t: 5000, pnl: -3.2 }]);
    expect(s.peakPnl).toBe(-3.2);
  });

  it("quote-failure fallback: history starts empty and the first regular poll becomes history[0]", () => {
    const s = initialExitState({ entryTime: 5000, entryLiquidity: 10_000, targetProfitPct: 30, holdMinutes: 15, entryPnlPct: null });
    expect(s.history).toEqual([]);
    expect(s.peakPnl).toBe(Number.NEGATIVE_INFINITY); // no reading yet — never a fabricated 0%

    // The first real poll pushes the actual reading and correctly becomes the peak via step 4's
    // Math.max, whatever its sign — nothing floors it at a guessed starting value.
    const result = step(s, { now: 20_000, pnlPct: -8 }, CFG);
    expect(result.newState.history).toEqual([{ t: 20_000, pnl: -8 }]);
    expect(result.newState.peakPnl).toBe(-8);
  });

  it("compound edge case: a confirmed stop on the very first real poll (step 4 never runs) leaves peakPnl at -Infinity — finalPeakPnl is what cleans this up before it's ever persisted", () => {
    const s = initialExitState({ entryTime: 5000, entryLiquidity: 10_000, targetProfitPct: 30, holdMinutes: 15, entryPnlPct: null });
    const result = step(s, { now: 20_000, pnlPct: -30, confirmPnlPct: -30 }, CFG);
    expect(result).toMatchObject({ action: "SELL", reason: "stop" });
    expect(result.newState.peakPnl).toBe(Number.NEGATIVE_INFINITY); // the pure state machine faithfully reports this
    expect(finalPeakPnl(result.newState.peakPnl, -30)).toBe(-30); // the caller sanitizes it at close time
  });
});

describe("finalPeakPnl", () => {
  it("is a no-op when the recorded peak is already at or above the final pnl", () => {
    expect(finalPeakPnl(25, 10)).toBe(25);
    expect(finalPeakPnl(10, 10)).toBe(10);
  });

  it("raises the peak to the final pnl when the recorded peak understates it (e.g. the -Infinity sentinel)", () => {
    expect(finalPeakPnl(Number.NEGATIVE_INFINITY, -12.5)).toBe(-12.5);
    expect(finalPeakPnl(0, 5)).toBe(5); // a HOLD path can't decrease pnl below a prior peak, but this documents the general rule
  });
});

describe("exit state machine", () => {
  it("records the first history point at entry (section 8.1)", () => {
    const s = entryState();
    expect(s.history).toEqual([{ t: 0, pnl: 0 }]);
  });

  it("initializes peakPnl from the first history point, not a separately hardcoded literal", () => {
    const s = entryState();
    expect(s.peakPnl).toBe(s.history[0]!.pnl);
  });

  it("a trade that stops out on its very first confirmed reading (step 4 never runs) reports the entry reading as its peak, not a stale independent value", () => {
    const s = entryState();
    const result = step(s, { now: 1000, pnlPct: -30, confirmPnlPct: -30 }, CFG); // confirmed stop-loss on the first call
    expect(result).toMatchObject({ action: "SELL", reason: "stop" });
    expect(result.newState.peakPnl).toBe(s.history[0]!.pnl); // still exactly the entry reading (0%), never updated by step 4
  });

  it("target hit while not fast -> SELL target", () => {
    const result = step(entryState(), { now: 1000, pnlPct: 35 }, CFG);
    expect(result).toMatchObject({ action: "SELL", reason: "target" });
  });

  it("target hit while fast -> target raised; reaching the raised target -> SELL target", () => {
    let s = entryState();

    // Two consecutive fast-qualifying polls (gain >= 15 vs the oldest in-window point, >= 60s apart) to reach FAST_CONFIRM_POLLS.
    let r = step(s, { now: 61_000, pnlPct: 20 }, CFG);
    expect(r.action).toBe("HOLD");
    s = r.newState;
    expect(s.fastStreak).toBe(1);

    r = step(s, { now: 122_000, pnlPct: 36 }, CFG);
    s = r.newState;
    expect(s.fastStreak).toBe(2);
    expect(r.action).toBe("HOLD"); // target hit (36 >= 30) while fast -> raised, not sold
    expect((r as { logs: string[] }).logs).toContain("target_raised");
    expect(s.currentTarget).toBe(40);
    expect(s.targetExtensions).toBe(1);
    expect(s.trailArmed).toBe(true);

    // Extension budget (MAX_TARGET_EXTENSIONS=1) is used up: the next time the raised target is hit, it sells.
    r = step(s, { now: 183_000, pnlPct: 41 }, CFG);
    expect(r).toMatchObject({ action: "SELL", reason: "target" });
  });

  it("target hit while fast, then a drop of TRAIL_PCT from the peak -> SELL trail", () => {
    let s = entryState();
    s = step(s, { now: 61_000, pnlPct: 20 }, CFG).newState;
    const raised = step(s, { now: 122_000, pnlPct: 36 }, CFG);
    expect(raised.newState.trailArmed).toBe(true);
    expect(raised.newState.peakPnl).toBe(36);

    // Drop of exactly TRAIL_PCT (4) from the peak (36 -> 32), target not re-hit.
    const result = step(raised.newState, { now: 150_000, pnlPct: 32 }, CFG);
    expect(result).toMatchObject({ action: "SELL", reason: "trail" });
  });

  it("a rebound from a dip is not fast: uses the oldest in-window point, never the window's minimum", () => {
    let s = entryState();
    // Rise to 60.
    s = step(s, { now: 100_000, pnlPct: 60 }, CFG).newState;
    expect(s.fastStreak).toBe(1);
    // Dip to 10 (not fast: gain vs the oldest point {0,0} is only 10).
    s = step(s, { now: 200_000, pnlPct: 10 }, CFG).newState;
    expect(s.fastStreak).toBe(0);
    // "Rebound" to 26: gain vs the dip (10) would be 16 (>= FAST_GAIN_PCT, would wrongly count as fast),
    // but the oldest point still inside the 5-minute window at t=350_000 is {100_000, 60}, not the dip,
    // so gain is 26-60 = -34 -> correctly not fast.
    const result = step(s, { now: 350_000, pnlPct: 26 }, CFG);
    expect(result.newState.fastStreak).toBe(0);
  });

  it("fast requires FAST_CONFIRM_POLLS consecutive qualifying polls", () => {
    let s = entryState();
    s = step(s, { now: 61_000, pnlPct: 20 }, CFG).newState; // 1st qualifying poll
    expect(s.fastStreak).toBe(1);
    const r2 = step(s, { now: 122_000, pnlPct: 40 }, CFG); // 2nd -> isFast only now (fastStreak >= 2)
    expect(r2.newState.fastStreak).toBe(2);
  });

  it("nothing is fast before FAST_MIN_HISTORY_SEC has elapsed", () => {
    const result = step(entryState(), { now: 30_000, pnlPct: 100 }, CFG); // 30s < 60s, huge gain
    expect(result.newState.fastStreak).toBe(0);
  });

  it("breakeven exit", () => {
    let s = entryState();
    // Peak reaches BREAKEVEN_TRIGGER_PCT (20)...
    s = step(s, { now: 1000, pnlPct: 25 }, CFG).newState;
    expect(s.peakPnl).toBe(25);
    // ...then falls to/below BREAKEVEN_FLOOR_PCT (2).
    const result = step(s, { now: 2000, pnlPct: 1 }, CFG);
    expect(result).toMatchObject({ action: "SELL", reason: "breakeven" });
  });

  it("stop-loss: a single bad quote gives NEED_CONFIRM and no sale if the confirmation disagrees; a confirmed stop gives SELL stop", () => {
    const s = entryState();
    const first = step(s, { now: 1000, pnlPct: -16 }, CFG);
    expect(first.action).toBe("NEED_CONFIRM");

    // Confirmation disagrees (back above the stop threshold): re-call on the ORIGINAL state with confirmPnlPct set.
    const disagreeing = step(s, { now: 1000, pnlPct: -16, confirmPnlPct: -5 }, CFG);
    expect(disagreeing.action).not.toBe("SELL");

    // Confirmation agrees: SELL stop.
    const confirmed = step(s, { now: 1000, pnlPct: -16, confirmPnlPct: -20 }, CFG);
    expect(confirmed).toMatchObject({ action: "SELL", reason: "stop" });
  });

  it("stop-loss confirmation: the caller re-calling on the ORIGINAL state (not the NEED_CONFIRM result) applies a concurrent liquidity reading exactly once", () => {
    const s = entryState({ entryLiquidity: 10_000 });
    const inputs = { now: 1000, pnlPct: -16, liquidityUsd: 6000 }; // liquidity reading below entryLiquidity*(1-30%)=7000

    const needConfirm = step(s, inputs, CFG);
    expect(needConfirm.action).toBe("NEED_CONFIRM");
    // The correct calling convention re-issues the SAME inputs plus confirmPnlPct against the ORIGINAL state s,
    // not needConfirm.newState (which already applied the liquidity reading once and must be discarded).
    const resolved = step(s, { ...inputs, confirmPnlPct: -5 }, CFG); // confirmation disagrees, continues past stop-loss
    expect(resolved.action).not.toBe("SELL");
    expect(resolved.newState.lowLiqStreak).toBe(1); // applied exactly once, not twice
  });

  it("liq_pull needs LIQ_DROP_CONFIRM_READS readings", () => {
    let s = entryState({ entryLiquidity: 10_000 });
    const dropped = 6000; // below 10_000 * (1 - 30%) = 7000

    const r1 = step(s, { now: 1000, pnlPct: 5, liquidityUsd: dropped }, CFG);
    expect(r1.action).not.toBe("SELL");
    expect(r1.newState.lowLiqStreak).toBe(1);
    s = r1.newState;

    const r2 = step(s, { now: 2000, pnlPct: 5, liquidityUsd: dropped }, CFG);
    expect(r2).toMatchObject({ action: "SELL", reason: "liq_pull" });
  });

  it("a liquidity reading above the threshold resets the streak, and no reading leaves it untouched", () => {
    let s = entryState({ entryLiquidity: 10_000 });
    s = step(s, { now: 1000, pnlPct: 5, liquidityUsd: 6000 }, CFG).newState;
    expect(s.lowLiqStreak).toBe(1);
    s = step(s, { now: 2000, pnlPct: 5, liquidityUsd: 9000 }, CFG).newState; // recovered
    expect(s.lowLiqStreak).toBe(0);
    s = step(s, { now: 3000, pnlPct: 5 }, CFG).newState; // no new reading this poll
    expect(s.lowLiqStreak).toBe(0);
  });

  it("no_route after NO_ROUTE_EXIT_SEC", () => {
    let s = entryState();
    const r1 = step(s, { now: 1000, pnlPct: null }, CFG);
    expect(r1.action).toBe("HOLD");
    expect(r1.newState.noRouteSince).toBe(1000);
    s = r1.newState;

    const r2 = step(s, { now: 1000 + 29_000, pnlPct: null }, CFG);
    expect(r2.action).toBe("HOLD");

    const r3 = step(s, { now: 1000 + 30_000, pnlPct: null }, CFG);
    expect(r3).toMatchObject({ action: "SELL", reason: "no_route" });
  });

  it("a route reappearing clears noRouteSince", () => {
    let s = entryState();
    s = step(s, { now: 1000, pnlPct: null }, CFG).newState;
    expect(s.noRouteSince).toBe(1000);
    s = step(s, { now: 2000, pnlPct: 5 }, CFG).newState;
    expect(s.noRouteSince).toBeNull();
  });

  it("max_hold", () => {
    const result = step(entryState(), { now: 60 * 60_000, pnlPct: 5 }, CFG); // MAX_TOTAL_HOLD_MINUTES=60
    expect(result).toMatchObject({ action: "SELL", reason: "max_hold" });
  });

  it("deadline: time_flat vs time_exit", () => {
    const flat = step(entryState(), { now: 15 * 60_000, pnlPct: 2 }, CFG); // within FLAT_BAND_PCT=3
    expect(flat).toMatchObject({ action: "SELL", reason: "time_flat" });

    const notFlat = step(entryState(), { now: 15 * 60_000, pnlPct: 10 }, CFG);
    expect(notFlat).toMatchObject({ action: "SELL", reason: "time_exit" });
  });

  it("after a restart past the deadline, the first poll sells (absolute-time deadlines need no special restart handling)", () => {
    // Simulates reloading a position from storage after a long downtime: entryTime in the past, deadline already gone.
    const s = entryState({ entryTime: 0, holdMinutes: 15 });
    const result = step(s, { now: 20 * 60_000, pnlPct: 1 }, CFG); // 20 min later, well past the 15-min deadline
    expect(result).toMatchObject({ action: "SELL" });
    expect(["time_flat", "time_exit"]).toContain((result as { reason: string }).reason);
  });

  it("timer restarts: fast growth restarts the timer, the restart cap holds, and no restart fires inside the cooldown", () => {
    // Target is effectively disabled so only timer-restart mechanics are exercised.
    let s = entryState({ targetProfitPct: 1_000_000 });
    const restartTimes: number[] = [];
    let lastTimerRestarts = 0;

    // Once MAX_TIMER_RESTARTS is exhausted, the deadline stops being pushed out and will
    // eventually be reached even under continued fast growth (section 8.3 step 11) — that's
    // expected, so the loop stops there instead of treating it as a failure.
    for (let i = 0; i < 35; i++) {
      const now = (i + 1) * 90_000; // 90s apart, ~52.5 minutes total (< MAX_TOTAL_HOLD_MINUTES=60)
      const pnl = 30 * (i + 1); // strong monotonic growth: gain vs any point within the last 5 min comfortably exceeds FAST_GAIN_PCT
      const result = step(s, { now, pnlPct: pnl }, CFG);
      s = result.newState;
      if (s.timerRestarts > lastTimerRestarts) {
        restartTimes.push(now);
        lastTimerRestarts = s.timerRestarts;
      }
      if (result.action === "SELL") break;
    }

    expect(s.timerRestarts).toBeLessThanOrEqual(CFG.maxTimerRestarts);
    expect(s.timerRestarts).toBe(CFG.maxTimerRestarts); // strong, sustained fast growth exhausts the cap
    for (let i = 1; i < restartTimes.length; i++) {
      expect(restartTimes[i]! - restartTimes[i - 1]!).toBeGreaterThanOrEqual(CFG.fastWindowMinutes * 60_000);
    }
  });
});
