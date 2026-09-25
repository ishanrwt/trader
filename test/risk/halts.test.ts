import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeHalts, entryBlockerReason, evaluateHalts, readHalts, recordTradeForStreak, wouldBlockTag, type HaltConfig } from "../../src/risk/halts.js";
import { openDb } from "../../src/storage/db.js";
import { StateStore } from "../../src/storage/state.js";

const TZ = "Asia/Kolkata";
/** Wall-clock time in Asia/Kolkata on the given day, as UTC ms. */
const ist = (hhmmss: string, day = "2026-09-25") => Date.parse(`${day}T${hhmmss}+05:30`);

function cfg(overrides: Partial<HaltConfig> = {}): HaltConfig {
  return {
    mode: "paper",
    tradingDayTz: TZ,
    maxDailyLossUsd: 60,
    consecutiveLossPause: 5,
    lossPauseMinutes: 60,
    observeOnly: false,
    urgentAlerts: true,
    ...overrides,
  };
}

/** Records what the bot would send and log. */
function effects() {
  const sent: string[] = [];
  const events: Array<{ type: string; message: string; meta: unknown }> = [];
  return { sent, events, fx: { send: (t: string) => void sent.push(t), logEvent: (type: string, message: string, meta: unknown) => void events.push({ type, message, meta }) } };
}

const NO_LOSS = { realizedNetPnlToday: 0, unrealizedLossSum: 0 };
const OTHER_CLEAR = { killed: false, paused: false, consecutiveErrors: 0, openPositionsCount: 0, maxConsecutiveErrors: 5, maxConcurrent: 3 };

/** Five losses in a row, the last at 20:44:22 IST: the pause runs until 21:44:22 IST. */
function fiveLosses(store: StateStore, c: HaltConfig): void {
  const times = ["20:30:00", "20:35:00", "20:40:00", "20:41:32", "20:44:22"];
  for (const t of times) recordTradeForStreak(store, c, { netPnlUsd: -2, proceedsUnknown: false }, ist(t));
}

function recordDailyHalt(store: StateStore, c: HaltConfig, fx: ReturnType<typeof effects>["fx"], at = ist("20:00:00")): void {
  evaluateHalts(store, c, { now: at, realizedNetPnlToday: -50, unrealizedLossSum: -12.1 }, fx);
}

describe("activeHalts / wouldBlockTag (section 11.1 tags)", () => {
  it("names each halt in force, in every combination", () => {
    const now = ist("21:00:00");
    const pause = ist("21:44:22");
    expect(wouldBlockTag(activeHalts({ haltDay: null, pauseUntil: null }, now, TZ))).toBe("none");
    expect(wouldBlockTag(activeHalts({ haltDay: "2026-09-25", pauseUntil: null }, now, TZ))).toBe("daily_loss");
    expect(wouldBlockTag(activeHalts({ haltDay: null, pauseUntil: pause }, now, TZ))).toBe("loss_streak");
    expect(wouldBlockTag(activeHalts({ haltDay: "2026-09-25", pauseUntil: pause }, now, TZ))).toBe("daily_loss+loss_streak");
  });

  it("an expired pause or a previous day's halt is not in force", () => {
    expect(activeHalts({ haltDay: "2026-09-24", pauseUntil: ist("20:00:00") }, ist("21:00:00"), TZ)).toEqual([]);
  });
});

describe("entry blockers with PAPER_HALTS_OBSERVE_ONLY (section 9.1)", () => {
  it("observe mode does not block on the daily-loss halt, the loss-streak pause, or both", () => {
    const store = new StateStore(openDb(":memory:"));
    const c = cfg({ observeOnly: true });
    const { fx } = effects();
    recordDailyHalt(store, c, fx);
    expect(entryBlockerReason(store, c, { now: ist("20:01:00"), ...NO_LOSS }, fx, OTHER_CLEAR)).toBeNull();
    fiveLosses(store, c);
    expect(readHalts(store, "paper")).toMatchObject({ haltDay: "2026-09-25", streak: 5, pauseUntil: ist("21:44:22") }); // still computed and stored
    expect(entryBlockerReason(store, c, { now: ist("21:00:00"), ...NO_LOSS }, fx, OTHER_CLEAR)).toBeNull();
  });

  it("observe mode still blocks on the kill switch, /pause, the error halt and full slots", () => {
    const store = new StateStore(openDb(":memory:"));
    const c = cfg({ observeOnly: true });
    const { fx } = effects();
    const at = { now: ist("21:00:00"), ...NO_LOSS };
    expect(entryBlockerReason(store, c, at, fx, { ...OTHER_CLEAR, killed: true })).toBe("kill_switch");
    expect(entryBlockerReason(store, c, at, fx, { ...OTHER_CLEAR, paused: true })).toBe("paused");
    expect(entryBlockerReason(store, c, at, fx, { ...OTHER_CLEAR, consecutiveErrors: 5 })).toBe("error_halt");
    expect(entryBlockerReason(store, c, at, fx, { ...OTHER_CLEAR, openPositionsCount: 3 })).toBe("slots_full");
  });

  it("with observe mode off (and in live mode) both halts block", () => {
    for (const c of [cfg(), cfg({ mode: "live" })]) {
      const store = new StateStore(openDb(":memory:"));
      const { fx } = effects();
      fiveLosses(store, c);
      expect(entryBlockerReason(store, c, { now: ist("21:00:00"), ...NO_LOSS }, fx, OTHER_CLEAR)).toBe("loss_streak_pause");
      recordDailyHalt(store, c, fx, ist("21:00:00"));
      expect(entryBlockerReason(store, c, { now: ist("21:01:00"), ...NO_LOSS }, fx, OTHER_CLEAR)).toBe("daily_loss_halt");
    }
  });

  it("turning observe mode off mid-day enforces the halt and the pause already recorded, immediately, without re-alerting", () => {
    const store = new StateStore(openDb(":memory:"));
    const observing = cfg({ observeOnly: true });
    const { fx, sent } = effects();
    fiveLosses(store, observing);
    expect(entryBlockerReason(store, observing, { now: ist("20:50:00"), ...NO_LOSS }, fx, OTHER_CLEAR)).toBeNull();

    const enforcing = cfg({ observeOnly: false });
    expect(entryBlockerReason(store, enforcing, { now: ist("20:50:01"), ...NO_LOSS }, fx, OTHER_CLEAR)).toBe("loss_streak_pause");

    recordDailyHalt(store, observing, fx, ist("20:55:00"));
    expect(entryBlockerReason(store, observing, { now: ist("20:56:00"), ...NO_LOSS }, fx, OTHER_CLEAR)).toBeNull();
    expect(entryBlockerReason(store, enforcing, { now: ist("20:56:01"), ...NO_LOSS }, fx, OTHER_CLEAR)).toBe("daily_loss_halt");
    expect(sent).toHaveLength(2); // one per halt, sent while observing; the switch doesn't re-send
  });
});

describe("halt alerts (sections 9.1 and 10)", () => {
  it("daily-loss halt: enforcing wording with the real values, sent once, event logged", () => {
    const store = new StateStore(openDb(":memory:"));
    const { fx, sent, events } = effects();
    recordDailyHalt(store, cfg(), fx);
    evaluateHalts(store, cfg(), { now: ist("20:10:00"), realizedNetPnlToday: -70, unrealizedLossSum: 0 }, fx);
    expect(sent).toEqual(["Daily loss halt: net PnL for the day is -$62.10, past the -$60.00 cap. Entries halted until the next trading day."]);
    expect(events).toEqual([expect.objectContaining({ type: "daily_loss_halt", meta: expect.objectContaining({ haltDay: "2026-09-25", dailyLossUsd: -62.1, capUsd: 60 }) })]);
  });

  it("daily-loss halt in live mode keeps the enforcing wording", () => {
    const store = new StateStore(openDb(":memory:"));
    const { fx, sent } = effects();
    recordDailyHalt(store, cfg({ mode: "live" }), fx);
    expect(sent).toEqual(["Daily loss halt: net PnL for the day is -$62.10, past the -$60.00 cap. Entries halted until the next trading day."]);
  });

  it("daily-loss halt in observe mode is labelled as observing only", () => {
    const store = new StateStore(openDb(":memory:"));
    const { fx, sent } = effects();
    recordDailyHalt(store, cfg({ observeOnly: true }), fx);
    expect(sent).toEqual(["PAPER: daily-loss halt would trigger (day -$62.10 vs -$60.00 cap). Observing only, trading continues."]);
  });

  it("loss-streak pause: sent when the pause starts, with the streak and the end time in TRADING_DAY_TZ", () => {
    const store = new StateStore(openDb(":memory:"));
    const { fx, sent, events } = effects();
    fiveLosses(store, cfg());
    evaluateHalts(store, cfg(), { now: ist("20:44:23"), ...NO_LOSS }, fx);
    expect(sent).toEqual(["Loss-streak pause: 5 losing trades in a row. Entries paused until 21:44 IST."]);
    expect(events[0]).toMatchObject({ type: "loss_streak_pause", meta: { streak: 5, pauseUntil: ist("21:44:22"), observeOnly: false } });
  });

  it("loss-streak pause in observe mode is labelled as observing only", () => {
    const store = new StateStore(openDb(":memory:"));
    const c = cfg({ observeOnly: true });
    const { fx, sent } = effects();
    fiveLosses(store, c);
    evaluateHalts(store, c, { now: ist("20:44:23"), ...NO_LOSS }, fx);
    expect(sent).toEqual(["PAPER: loss-streak pause would trigger (streak 5, until 21:44 IST). Observing only, trading continues."]);
  });

  it("extensions of an active pause don't re-alert; a new pause after the old one expires does", () => {
    const store = new StateStore(openDb(":memory:"));
    const c = cfg();
    const { fx, sent } = effects();
    fiveLosses(store, c);
    evaluateHalts(store, c, { now: ist("20:44:23"), ...NO_LOSS }, fx);
    recordTradeForStreak(store, c, { netPnlUsd: -1, proceedsUnknown: false }, ist("21:00:00")); // streak 6: extends to 22:00
    evaluateHalts(store, c, { now: ist("21:00:01"), ...NO_LOSS }, fx);
    expect(sent).toHaveLength(1);
    expect(readHalts(store, "paper").pauseUntil).toBe(ist("22:00:00"));

    recordTradeForStreak(store, c, { netPnlUsd: -1, proceedsUnknown: false }, ist("22:30:00")); // after expiry: a new pause
    evaluateHalts(store, c, { now: ist("22:30:01"), ...NO_LOSS }, fx);
    expect(sent).toEqual([
      "Loss-streak pause: 5 losing trades in a row. Entries paused until 21:44 IST.",
      "Loss-streak pause: 7 losing trades in a row. Entries paused until 23:30 IST.",
    ]);
  });

  it("with URGENT_ALERTS=false nothing is sent immediately, but the halt is still logged and marked handled", () => {
    const store = new StateStore(openDb(":memory:"));
    const c = cfg({ urgentAlerts: false });
    const { fx, sent, events } = effects();
    recordDailyHalt(store, c, fx);
    fiveLosses(store, c);
    evaluateHalts(store, c, { now: ist("20:45:00"), ...NO_LOSS }, fx);
    evaluateHalts(store, c, { now: ist("20:46:00"), ...NO_LOSS }, fx);
    expect(sent).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["daily_loss_halt", "loss_streak_pause"]);
  });
});

describe("halt alerts are idempotent across restarts (derived from stored state)", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-halts-"));
    dbPath = path.join(dir, "trader.db");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** One bot process: its own database connection and fresh in-memory effects (nothing carries over but the file). */
  function run<T>(fn: (store: StateStore, e: ReturnType<typeof effects>) => T): { result: T; sent: string[] } {
    const db = openDb(dbPath);
    const e = effects();
    try {
      return { result: fn(new StateStore(db), e), sent: e.sent };
    } finally {
      db.close();
    }
  }

  it("a restart does not re-send alerts already sent for the same halt and pause", () => {
    const first = run((store, e) => {
      recordDailyHalt(store, cfg(), e.fx);
      fiveLosses(store, cfg());
      evaluateHalts(store, cfg(), { now: ist("20:45:00"), ...NO_LOSS }, e.fx);
    });
    expect(first.sent).toHaveLength(2);
    const second = run((store, e) => evaluateHalts(store, cfg(), { now: ist("20:50:00"), ...NO_LOSS }, e.fx));
    expect(second.sent).toEqual([]);
    expect(second.result).toMatchObject({ haltDay: "2026-09-25", pauseUntil: ist("21:44:22") });
  });

  it("a halt recorded but not yet alerted when the bot stopped is alerted once after the restart", () => {
    // The process dies inside the send: the halt is stored, the "alerted" marker is not.
    expect(() =>
      run((store) => {
        const dying = { send: () => { throw new Error("process died"); }, logEvent: () => {} };
        evaluateHalts(store, cfg(), { now: ist("20:00:00"), realizedNetPnlToday: -50, unrealizedLossSum: -12.1 }, dying);
      }),
    ).toThrow("process died");
    // A trade closed and the pause started, then the process died before the post-trade evaluation.
    run((store) => fiveLosses(store, cfg()));

    const restarted = run((store, e) => evaluateHalts(store, cfg(), { now: ist("21:00:00"), ...NO_LOSS }, e.fx));
    expect(restarted.sent).toEqual([
      "Daily loss halt: net PnL for the day is -$62.10, past the -$60.00 cap. Entries halted until the next trading day.",
      "Loss-streak pause: 5 losing trades in a row. Entries paused until 21:44 IST.",
    ]);
    const again = run((store, e) => evaluateHalts(store, cfg(), { now: ist("21:01:00"), ...NO_LOSS }, e.fx));
    expect(again.sent).toEqual([]);
  });

  it("a halt or pause that ended while the bot was down is still alerted, marked as sent late", () => {
    run((store) => {
      store.set("dailyLossHaltDay:paper", "2026-09-25"); // as a pre-0006 bot would have left it: recorded, never alerted
      store.set("dailyLossHaltTotalUsd:paper", -62.1);
      fiveLosses(store, cfg());
    });
    const nextMorning = run((store, e) => evaluateHalts(store, cfg(), { now: ist("09:00:00", "2026-09-26"), ...NO_LOSS }, e.fx));
    expect(nextMorning.sent).toEqual([
      "Daily loss halt: net PnL for the day is -$62.10, past the -$60.00 cap. Entries halted until the next trading day. (Sent late: recorded for trading day 2026-09-25, which has already ended.)",
      "Loss-streak pause: 5 losing trades in a row. Entries paused until 21:44 IST. (Sent late: this pause already ended at 21:44 IST.)",
    ]);
    expect(nextMorning.result.haltDay).toBeNull(); // the day rollover still clears the halt
  });
});
