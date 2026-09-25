import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { TelegramUpdate } from "../../src/clients/telegram.js";
import { createMemoryLogger } from "../../src/logger/index.js";
import { pollAndHandleCommands, type CommandsTelegram } from "../../src/notify/commands.js";
import { buildWindowsReport, formatWindowStats, localMinuteOfDay, windowStats, type WindowTrade } from "../../src/report/windows.js";
import { openDb, type Db } from "../../src/storage/db.js";
import { logEvent, recentEvents } from "../../src/storage/events.js";
import { FeeLossesStore } from "../../src/storage/feeLosses.js";
import { StateStore } from "../../src/storage/state.js";
import { TradesStore, type NewTradeRow } from "../../src/storage/trades.js";

const TZ = "Asia/Kolkata";
const DAY = "2026-09-25";
/** A wall-clock time on DAY in Asia/Kolkata, as UTC epoch ms. */
const ist = (hhmm: string, sec = "00.000") => Date.parse(`${DAY}T${hhmm}:${sec}+05:30`);
const OPTS = { day: DAY, timeZone: TZ, intervalMin: 120 };

function t(exitTime: number, netPnlUsd: number, proceedsUnknown = false): WindowTrade {
  return { exitTime, netPnlUsd, proceedsUnknown };
}

function trade(overrides: Partial<NewTradeRow>): NewTradeRow {
  return {
    mode: "paper", mint: "MINT", symbol: "SYM", pairAddress: "PAIR", entryTime: 0, exitTime: 0, sizeUsd: 25, costBasis: 25.05, proceeds: 25,
    netPnlUsd: 0, netPnlPct: 0, exitReason: "stop", peakPnl: 0, timerRestarts: 0, targetExtensions: 0, feesUsd: 0.1, entryPairSnapshot: null,
    top1Pct: null, top10Pct: null, score: null, scoreComponents: null, animalFlag: null, tradingDay: DAY, tokenAmount: 1, tokenDecimals: 6,
    entryValuationPnlPct: null, entryQuoteInAmount: null, entryQuoteOutAmount: null, exitQuoteInAmount: null, exitQuoteOutAmount: null,
    ...overrides,
  };
}

function insertTrade(db: Db, exitTime: number, netPnlUsd: number, overrides: Partial<NewTradeRow> = {}): void {
  new TradesStore(db).insert(trade({ exitTime, entryTime: exitTime - 60_000, netPnlUsd, ...overrides }));
}

describe("windowStats (SPEC.md section 11.4 --windows)", () => {
  it("groups trades into clock-aligned windows from local midnight, stacked in order, like the example", () => {
    const trades = [
      t(ist("16:05"), -1.0), t(ist("16:40"), 2.0), t(ist("17:10"), -5.0), t(ist("17:50"), 0.9), // 4 trades, 2 wins, -3.10
      t(ist("18:15"), -4.0), t(ist("19:00"), 1.6), t(ist("19:30"), -6.0), // 3 trades, 1 win, -8.40
      t(ist("20:10"), 5.3), t(ist("21:00"), 7.0), // 2 trades, 2 wins, +12.30
    ];
    const text = formatWindowStats("paper", windowStats(trades, [], { ...OPTS, now: ist("21:30") }));
    expect(text).toContain("PAPER: trading day 2026-09-25 (Asia/Kolkata), 120-min windows");
    expect(text).toContain("  16:00-18:00: 4 trades, 2 wins, net -$3.10\n  18:00-20:00: 3 trades, 1 win, net -$8.40\n  20:00-22:00 (current): 2 trades, 2 wins, net +$12.30");
    expect(text).toContain("  day total: 9 trades, 5 wins, net +$0.80");
  });

  it("lists empty windows from midnight and stops at the current window", () => {
    const r = windowStats([t(ist("03:00"), 1)], [], { ...OPTS, now: ist("05:59") });
    expect(r.rows.map((x) => [x.startMin, x.trades, x.current])).toEqual([
      [0, 0, false],
      [120, 1, false],
      [240, 0, true],
    ]);
    expect(formatWindowStats("paper", r)).toContain("  00:00-02:00: 0 trades");
  });

  it("a trade exactly on a boundary belongs to the later window", () => {
    const r = windowStats([t(ist("17:59", "59.999"), 1), t(ist("18:00", "00.000"), 2)], [], { ...OPTS, now: ist("19:00") });
    expect(r.rows[8]).toMatchObject({ startMin: 960, trades: 1, netUsd: 1 });
    expect(r.rows[9]).toMatchObject({ startMin: 1080, trades: 1, netUsd: 2 });
  });

  it("uses the local wall clock: 19:00 UTC on the 24th is 00:30 on the 25th in Asia/Kolkata, the first window", () => {
    const utc = Date.parse("2026-09-24T19:00:00Z");
    expect(localMinuteOfDay(utc, TZ)).toBe(30);
    const r = windowStats([t(utc, 3)], [], { ...OPTS, now: ist("01:00") });
    expect(r.rows[0]).toMatchObject({ startMin: 0, trades: 1 });
  });

  it("the day total equals the sum of the windows", () => {
    const trades = [t(ist("01:00"), 1.25), t(ist("09:00"), -2.5), t(ist("09:30"), 4), t(ist("23:10"), -0.75)];
    const r = windowStats(trades, [{ ts: ist("09:15"), usd: 0.4 }], { ...OPTS, now: ist("23:59") });
    const sum = r.rows.reduce((a, x) => ({ trades: a.trades + x.trades, wins: a.wins + x.wins, net: a.net + x.netUsd }), { trades: 0, wins: 0, net: 0 });
    expect(r.total.trades).toBe(sum.trades);
    expect(r.total.wins).toBe(sum.wins);
    expect(r.total.netUsd).toBeCloseTo(sum.net, 10);
    expect(r.total.netUsd).toBeCloseTo(1.25 - 2.5 + 4 - 0.75 - 0.4, 10);
  });

  it("proceeds_unknown trades are counted but kept out of wins and net", () => {
    const r = windowStats([t(ist("10:00"), -25.3, true), t(ist("10:30"), 2)], [], { ...OPTS, now: ist("11:00") });
    expect(r.rows[5]).toMatchObject({ trades: 2, wins: 1, proceedsUnknown: 1, netUsd: 2 });
    expect(formatWindowStats("live", r)).toContain("  10:00-12:00 (current): 2 trades, 1 win, net +$2.00 (1 proceeds unknown, not in wins or net)");
  });

  it("live fee losses count toward the window's net and are shown; paper never shows fee losses", () => {
    const r = windowStats([t(ist("12:10"), 1)], [{ ts: ist("12:40"), usd: 0.25 }], { ...OPTS, now: ist("13:00") });
    expect(formatWindowStats("live", r)).toContain("  12:00-14:00 (current): 1 trade, 1 win, fee losses $0.25, net +$0.75");
    expect(formatWindowStats("paper", windowStats([t(ist("12:10"), 1)], [], { ...OPTS, now: ist("13:00") }))).not.toContain("fee losses");
  });

  it("a past day lists every window with none marked current; a future day has none", () => {
    const past = windowStats([], [], { ...OPTS, now: Date.parse("2026-09-26T12:00:00+05:30") });
    expect(past.rows).toHaveLength(12);
    expect(past.rows.some((r) => r.current)).toBe(false);
    expect(past.rows[11]).toMatchObject({ startMin: 1320, endMin: 1440 });
    const future = windowStats([], [], { ...OPTS, now: Date.parse("2026-09-24T12:00:00+05:30") });
    expect(formatWindowStats("paper", future)).toContain("(no windows yet)");
  });

  it("an interval that doesn't divide the day gives a shorter last window, labelled with its real end", () => {
    const r = windowStats([], [], { ...OPTS, intervalMin: 420, now: Date.parse("2026-09-26T12:00:00+05:30") });
    expect(r.rows.map((x) => [x.startMin, x.endMin])).toEqual([[0, 420], [420, 840], [840, 1260], [1260, 1440]]);
    expect(formatWindowStats("paper", r)).toContain("21:00-24:00");
  });
});

describe("buildWindowsReport (real database)", () => {
  it("a trade that closed while no digest was sent (crash, then a delayed digest) still shows in its window", () => {
    const db = openDb(":memory:");
    // Digests went out at 14:00 and then not again until 20:00: the bot crashed at 16:05 and came back at 16:20
    // with a fresh digest timer, and the 18:00 digest never happened. Nothing in events covers 14:00-20:00.
    logEvent(db, ist("14:00"), "digest_sent", "Digest sent");
    logEvent(db, ist("16:20"), "restart", "Restarted after 900000ms downtime");
    logEvent(db, ist("20:00"), "digest_sent", "Digest sent");
    insertTrade(db, ist("16:30"), -2.2); // closed during the gap: never in any digest's "trades closed in the window"
    insertTrade(db, ist("17:45"), 3.5);

    const digestTimes = recentEvents(db, 0).filter((e) => e.type === "digest_sent").map((e) => e.ts);
    expect(digestTimes.some((ts) => ts > ist("14:00") && ts < ist("20:00"))).toBe(false); // the precondition: no digest in the gap

    const text = buildWindowsReport(db, { mode: "paper", ...OPTS, now: ist("20:30") });
    expect(text).toContain("  16:00-18:00: 2 trades, 1 win, net +$1.30");
    expect(text).toContain("  14:00-16:00: 0 trades");
    expect(text).toContain("  18:00-20:00: 0 trades");
    expect(text).toContain("  day total: 2 trades, 1 win, net +$1.30");
  });

  it("paper and live are never mixed; other trading days are excluded", () => {
    const db = openDb(":memory:");
    insertTrade(db, ist("10:00"), 1, { mode: "paper" });
    insertTrade(db, ist("10:10"), -4, { mode: "live" });
    new FeeLossesStore(db).insert({ mode: "live", ts: ist("10:20"), tradingDay: DAY, mint: "M", positionId: null, intentId: null, signature: null, kind: "sell", lamports: 1, usd: 0.5, solPriceUsd: 150 });
    insertTrade(db, Date.parse("2026-09-24T10:00:00+05:30"), 99, { mode: "paper", tradingDay: "2026-09-24" });
    const now = ist("11:00");
    expect(buildWindowsReport(db, { mode: "paper", ...OPTS, now })).toContain("  10:00-12:00 (current): 1 trade, 1 win, net +$1.00");
    expect(buildWindowsReport(db, { mode: "live", ...OPTS, now })).toContain("  10:00-12:00 (current): 1 trade, 0 wins, fee losses $0.50, net -$4.50");
  });
});

describe("/windows command (SPEC.md section 10)", () => {
  function fakeTelegram(text: string): CommandsTelegram & { sent: string[] } {
    const sent: string[] = [];
    const updates: TelegramUpdate[] = [{ update_id: 1, message: { message_id: 1, chat: { id: "chat1" }, text, date: 0 } }];
    return {
      sent,
      getUpdates: vi.fn().mockResolvedValue(updates),
      isFromConfiguredChat: (u) => u.message?.chat?.id === "chat1",
      sendMessage: vi.fn(async (m: string) => {
        sent.push(m);
      }),
    };
  }
  const base = { stateStore: new StateStore(openDb(":memory:")), offset: 0, timeoutSec: 1, buildDigest: () => "DIGEST", buildReport: () => "REPORT", logger: createMemoryLogger() };

  it("replies with the per-window stats", async () => {
    const telegram = fakeTelegram("/windows");
    await pollAndHandleCommands({ ...base, telegram, buildWindows: () => "WINDOWS TEXT" });
    expect(telegram.sent).toEqual(["WINDOWS TEXT"]);
  });

  it("/status is unchanged: still exactly the digest", async () => {
    const telegram = fakeTelegram("/status");
    await pollAndHandleCommands({ ...base, telegram, buildWindows: () => "WINDOWS TEXT" });
    expect(telegram.sent).toEqual(["DIGEST"]);
  });
});

describe("npm run report -- --windows (CLI)", () => {
  const CLI_PATH = fileURLToPath(new URL("../../src/report/cli.ts", import.meta.url));
  const TSX_LOADER_URL = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;

  it("prints one section per mode for the given --day, using DIGEST_INTERVAL_MINUTES and TRADING_DAY_TZ", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-windows-"));
    const dbPath = path.join(tmpDir, "trader.db");
    try {
      const db = openDb(dbPath);
      insertTrade(db, ist("16:30"), -2.2, { mode: "paper" });
      insertTrade(db, ist("17:45"), 3.5, { mode: "paper" });
      insertTrade(db, ist("09:00"), 1, { mode: "live" });
      db.close();
      const run = (...extra: string[]) =>
        execFileSync(process.execPath, ["--import", TSX_LOADER_URL, CLI_PATH, "--db", dbPath, "--windows", "--day", DAY, ...extra], {
          cwd: tmpDir,
          env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TRADING_DAY_TZ: TZ, DIGEST_INTERVAL_MINUTES: "120" },
          encoding: "utf8",
        });
      const both = run();
      const [paper, live] = both.split("LIVE: trading day");
      expect(paper).toContain("PAPER: trading day 2026-09-25 (Asia/Kolkata), 120-min windows");
      expect(paper).toContain("  16:00-18:00: 2 trades, 1 win, net +$1.30");
      expect(live).toContain("  08:00-10:00: 1 trade, 1 win, net +$1.00");
      expect(live).not.toContain("16:00-18:00: 2 trades");
      const paperOnly = run("--mode", "paper");
      expect(paperOnly).not.toContain("LIVE:");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
