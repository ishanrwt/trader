import { describe, expect, it } from "vitest";
import { replayAsIfLive, type ReplayConfig } from "../../src/report/asIfLive.js";
import { formatReport, goLiveChecklist, type ReplayableTradeRecord } from "../../src/report/index.js";

const TZ = "Asia/Kolkata";
const ist = (hhmm: string, day = "2026-09-25") => Date.parse(`${day}T${hhmm}:00+05:30`);
const CFG: ReplayConfig = { maxDailyLossUsd: 30, consecutiveLossPause: 3, lossPauseMinutes: 60, tradingDayTz: TZ };

let nextId = 1;
/** A paper trade with a test-only `id` for readable assertions. */
function t(entry: string, exit: string, netPnlUsd: number, extra: Partial<ReplayableTradeRecord> & { day?: string } = {}): ReplayableTradeRecord & { id: number } {
  const day = extra.day ?? "2026-09-25";
  return {
    id: nextId++,
    mode: "paper",
    entryTime: ist(entry, day),
    exitTime: ist(exit, day),
    tradingDay: day,
    exitReason: netPnlUsd > 0 ? "target" : "stop",
    netPnlUsd,
    netPnlPct: (netPnlUsd / 25) * 100,
    m5ChangePct: null,
    h1ChangePct: null,
    buyPressurePct: null,
    liquidityUsd: null,
    pairAgeMs: null,
    top10Pct: null,
    score: null,
    scoreComponents: null,
    ...extra,
  };
}
const ids = (xs: ReadonlyArray<{ id: number }>) => xs.map((x) => x.id);

describe("replayAsIfLive (section 11.4)", () => {
  it("drops entries during a replayed pause, and those dropped losses don't extend the replayed streak", () => {
    nextId = 1;
    const trades = [
      t("10:00", "10:05", -1), // 1
      t("10:10", "10:15", -1), // 2
      t("10:20", "10:25", -1), // 3: streak 3 -> replayed pause until 11:25
      t("10:30", "10:35", -1), // 4: dropped (paper took it; had it counted, the pause would run to 11:35)
      t("11:00", "11:10", -1), // 5: dropped (had it counted, the pause would run to 12:10)
      t("11:30", "11:40", 2), //  6: kept - only the kept losses set the pause, which ended at 11:25
    ];
    const r = replayAsIfLive(trades, CFG);
    expect(ids(r.kept)).toEqual([1, 2, 3, 6]);
    expect(r.dropped.map((d) => [d.trade.id, d.reasons])).toEqual([
      [4, ["loss_streak"]],
      [5, ["loss_streak"]],
    ]);
  });

  it("a kept trade still open at the next entry doesn't count yet (only realized exits feed the state)", () => {
    nextId = 1;
    const trades = [t("10:00", "10:05", -1), t("10:06", "10:07", -1), t("10:08", "12:00", -1), t("10:30", "10:40", -1)];
    // At 10:30 only two losses have exited, so no pause yet: all four kept.
    expect(ids(replayAsIfLive(trades, CFG).kept)).toEqual([1, 2, 3, 4]);
  });

  it("the daily-loss halt holds for the rest of that trading day only, and a trade entered before the halt is kept", () => {
    nextId = 1;
    const trades = [
      t("10:00", "10:05", -20), // 1: day -20
      t("10:10", "10:30", -15), // 2: exits at 10:30, day -35 <= -30 -> halted for 2026-09-25
      t("10:20", "10:50", 5), //   3: entered before the halt: kept
      t("10:31", "10:40", 4), //   4: dropped (daily_loss)
      t("23:00", "23:10", 3), //   5: dropped, still the same trading day
      t("09:00", "09:10", 1, { day: "2026-09-26" }), // 6: next trading day: kept
    ];
    const r = replayAsIfLive(trades, CFG);
    expect(ids(r.kept)).toEqual([1, 2, 3, 6]);
    expect(r.dropped.map((d) => [d.trade.id, d.reasons])).toEqual([
      [4, ["daily_loss"]],
      [5, ["daily_loss"]],
    ]);
  });

  it("reports both reasons when both would block", () => {
    nextId = 1;
    const trades = [t("10:00", "10:05", -10), t("10:06", "10:10", -10), t("10:11", "10:15", -10), t("10:20", "10:30", 1)];
    const r = replayAsIfLive(trades, CFG);
    expect(r.dropped.map((d) => [d.trade.id, d.reasons])).toEqual([[4, ["daily_loss", "loss_streak"]]]);
  });

  it("an exit at the same instant as an entry is applied first", () => {
    nextId = 1;
    const trades = [t("10:00", "10:05", -1), t("10:06", "10:10", -1), t("10:11", "10:25", -1), t("10:25", "10:30", 1)];
    expect(replayAsIfLive(trades, CFG).dropped.map((d) => d.trade.id)).toEqual([4]);
  });

  it("proceeds_unknown trades count toward the daily loss but not the streak", () => {
    nextId = 1;
    const trades = [
      t("10:00", "10:05", -1),
      t("10:06", "10:10", -25.3, { proceedsUnknown: true }), // day -26.3, streak unchanged at 1
      t("10:11", "10:15", -1), // streak 2, day -27.3
      t("10:20", "10:25", -3), // streak 3 -> pause; day -30.3 -> halt
      t("10:30", "10:40", 1),
    ];
    const r = replayAsIfLive(trades, CFG);
    expect(r.dropped.map((d) => [d.trade.id, d.reasons])).toEqual([[5, ["daily_loss", "loss_streak"]]]);
    const noHaltYet = replayAsIfLive(trades.slice(0, 3).concat([t("10:16", "10:18", 1)]), CFG);
    expect(noHaltYet.dropped).toEqual([]); // two counted losses (the unknown one skipped): no pause
  });
});

describe("the go-live checklist uses the as-if-live view (section 11.4)", () => {
  const GOLIVE = { minTrades: 3, minDays: 0, minMedianPnlPct: 0, minTotalPnlUsd: 0, minP10PnlPct: -100 };

  it("all paper trades meet the trade count, but the as-if-live trades don't: the checklist fails", () => {
    nextId = 1;
    const trades = [t("10:00", "10:05", -1), t("10:06", "10:10", -1), t("10:11", "10:15", -1), t("10:20", "10:30", 5), t("10:40", "10:50", 5)];
    const r = replayAsIfLive(trades, CFG);
    expect(r.kept.length).toBe(3);
    expect(goLiveChecklist(trades, false, { ...GOLIVE, minTrades: 4 })[0]!.pass).toBe(true);
    const text = formatReport({
      trades,
      paperTrades: trades,
      skipTracks: [],
      hasStuckPositions: false,
      goLiveConfig: { ...GOLIVE, minTrades: 4 },
      asIfLive: { cfg: CFG, allPaperTrades: trades },
    });
    expect(text).toContain("Go-live checklist (as if live):\n  [FAIL] closed trades >= 4 (3)");
    expect(text).toContain("Limits used (current .env): MAX_DAILY_LOSS_USD=30, CONSECUTIVE_LOSS_PAUSE=3, LOSS_PAUSE_MINUTES=60");
    expect(text).toContain("Kept 3 of 5; dropped 2 (daily_loss 0, loss_streak 2, both 0)");
  });

  it("and the reverse: dropping losses taken during a would-be pause can make the as-if-live median pass", () => {
    nextId = 1;
    const trades = [
      t("10:00", "10:05", 2),
      t("10:10", "10:15", -1),
      t("10:20", "10:25", -1),
      t("10:30", "10:35", -1), // pause until 11:35
      t("10:40", "10:45", -4), // dropped
      t("10:50", "10:55", -4), // dropped
      t("11:40", "11:45", 3),
      t("11:50", "11:55", 3),
    ];
    const cfgGolive = { ...GOLIVE, minTrades: 1 };
    expect(goLiveChecklist(trades, false, cfgGolive)[2]!.pass).toBe(false); // all trades: median -1
    const text = formatReport({ trades, paperTrades: trades, skipTracks: [], hasStuckPositions: false, goLiveConfig: cfgGolive, asIfLive: { cfg: CFG, allPaperTrades: trades } });
    expect(text).toMatch(/Go-live checklist \(as if live\):[\s\S]*\[PASS\] median net PnL % > 0/);
    expect(text).toContain("By trading day:\n  2026-09-25: 6 trades");
  });

  it("the all-trades view reports how many trades were taken under a would-be halt, from the entry tags", () => {
    nextId = 1;
    const trades = [
      t("10:00", "10:05", 1, { wouldBlockAtEntry: "none" }),
      t("10:10", "10:15", 1, { wouldBlockAtEntry: "loss_streak" }),
      t("10:20", "10:25", 1, { wouldBlockAtEntry: "daily_loss+loss_streak" }),
      t("10:30", "10:35", 1, { wouldBlockAtEntry: null }),
    ];
    const text = formatReport({ trades, paperTrades: trades, skipTracks: [], hasStuckPositions: false, goLiveConfig: GOLIVE, asIfLive: { cfg: CFG, allPaperTrades: trades } });
    expect(text).toContain("Taken under a would-be halt (tagged at entry): 2 (daily_loss 0, loss_streak 1, both 1); not recorded 1");
  });

  it("the live section keeps the plain checklist label and no as-if-live block", () => {
    const text = formatReport({ trades: [], paperTrades: [], skipTracks: [], hasStuckPositions: false, goLiveConfig: GOLIVE });
    expect(text).toContain("Go-live checklist:");
    expect(text).not.toContain("As if live");
  });
});
