import { describe, expect, it } from "vitest";
import { formatReport, formatShadowSection, pairShadowsWithTrades, type ShadowRecord, type TradeRecord } from "../../src/report/index.js";
import { shadowRecordsFor } from "../../src/report/shadowRecords.js";
import type { ShadowRow } from "../../src/storage/shadows.js";

const sh = (o: Partial<ShadowRecord>): ShadowRecord => ({ mint: "M", entryTime: 0, outcome: "closed", classification: "unselected", netPnlUsd: null, netPnlPct: null, ...o });
const tr = (o: Partial<TradeRecord>): TradeRecord => ({
  mode: "paper", exitTime: 0, tradingDay: "2026-09-25", exitReason: "stop", netPnlUsd: 0, netPnlPct: 0, m5ChangePct: null, h1ChangePct: null,
  buyPressurePct: null, liquidityUsd: null, pairAgeMs: null, top10Pct: null, score: null, scoreComponents: null, ...o,
});

describe("pairShadowsWithTrades (section 11.4 shadow vs actual)", () => {
  it("pairs a selected, priced shadow with its mint's first trade entered at or after the shadow", () => {
    const shadows = [
      sh({ mint: "A", entryTime: 100, classification: "selected", netPnlUsd: 5, netPnlPct: 20 }),
      sh({ mint: "B", entryTime: 100, classification: "selected", netPnlUsd: -2, netPnlPct: -8 }), // its only trade entered before the shadow
      sh({ mint: "C", entryTime: 100, classification: "unselected", netPnlUsd: 1, netPnlPct: 4 }), // not selected
      sh({ mint: "D", entryTime: 100, classification: "selected" }), // no PnL (no data)
    ];
    const trades = [
      tr({ mint: "A", entryTime: 300, netPnlPct: 11 }),
      tr({ mint: "A", entryTime: 150, netPnlPct: 15 }), // the first at/after the shadow
      tr({ mint: "B", entryTime: 50, netPnlPct: -9 }),
      tr({ mint: "C", entryTime: 150, netPnlPct: 3 }),
      tr({ mint: "D", entryTime: 150, netPnlPct: -1 }),
    ];
    expect(pairShadowsWithTrades(shadows, trades)).toEqual([{ shadowNetPnlPct: 20, actualNetPnlPct: 15 }]);
  });
});

describe("formatShadowSection (section 11.4)", () => {
  it("prints selected vs unselected with count, win rate, median, mean and p10, the no-data/open/unsellable counts, and shadow vs actual", () => {
    const shadows = [
      sh({ mint: "A", entryTime: 1, classification: "selected", netPnlUsd: 5, netPnlPct: 20 }),
      sh({ mint: "B", entryTime: 1, classification: "selected", netPnlUsd: -2.5, netPnlPct: -10 }),
      sh({ mint: "C", entryTime: 1, classification: "selected" }), // no data
      sh({ mint: "D", entryTime: 1, netPnlUsd: 1, netPnlPct: 4 }),
      sh({ mint: "E", entryTime: 1, classification: "unsellable", netPnlUsd: 3, netPnlPct: 12 }),
      sh({ mint: "F", entryTime: 1, outcome: "open", classification: "selected" }),
    ];
    const trades = [tr({ mint: "A", entryTime: 2, netPnlPct: 18 }), tr({ mint: "B", entryTime: 2, netPnlPct: -14 })];
    expect(formatShadowSection(shadows, trades)).toEqual([
      "Shadows (excluding duplicates):",
      // selected: pcts [20, -10] -> median 5, mean 5, p10 = -10 + 0.1 * 30 = -7; usd [5, -2.5] -> median 1.25, mean 1.25
      "  selected: 2 with PnL, win rate 50.0%, median 5.0%, mean 5.0%, p10 -7.0%, median $1.25, mean $1.25; no data 1",
      "  unselected: 1 with PnL, win rate 100.0%, median 4.0%, mean 4.0%, p10 4.0%, median $1.00, mean $1.00; no data 0",
      '  still open 1; unsellable 1 (excluded); "no data" = closed without PnL (classified before the lifecycle fix, never priced)',
      // diffs: 20-18 = +2, -10-(-14) = +4 -> mean |diff| 3.0, mean diff +3.0
      "  shadow vs actual (selected mints): 2 pairs, mean |diff| 3.0pp, mean diff (shadow - actual) +3.0pp, correlation 1.00",
    ]);
  });

  it("says so when there is nothing to compare", () => {
    expect(formatShadowSection([], [])).toEqual([
      "Shadows (excluding duplicates):",
      "  selected: none with PnL; no data 0",
      "  unselected: none with PnL; no data 0",
      '  still open 0; unsellable 0 (excluded); "no data" = closed without PnL (classified before the lifecycle fix, never priced)',
      "  shadow vs actual (selected mints): no pairs",
    ]);
  });

  it("appears in formatReport when shadows are passed", () => {
    const golive = { minTrades: 1, minDays: 0, minMedianPnlPct: 0, minTotalPnlUsd: 0, minP10PnlPct: -100 };
    const text = formatReport({ trades: [], paperTrades: [], skipTracks: [], hasStuckPositions: false, goLiveConfig: golive, shadows: [] });
    expect(text).toContain("Shadows (excluding duplicates):");
  });
});

describe("shadowRecordsFor (mode and period filter)", () => {
  const row = (o: Partial<ShadowRow>): ShadowRow =>
    ({
      id: 1, mint: "A", symbol: null, pairAddress: null, outcome: "closed", classification: "unselected", entryTime: 0, costBasis: 25, tokenAmount: 1,
      entryLiquidityUsd: 1, entryPriceUsd: 1, score: null, scoreComponents: null, peakPnl: 0, currentTarget: 30, targetExtensions: 0, timerRestarts: 0,
      lastRestartAt: null, deadline: 0, trailArmed: false, fastStreak: 0, lowLiqStreak: 0, noRouteSince: null, exitTime: null, exitReason: null,
      proceeds: null, netPnlUsd: null, netPnlPct: null, mode: "paper", duplicateOf: null, ...o,
    }) as ShadowRow;

  it("keeps one mode and the report period by the entry's trading day in TRADING_DAY_TZ", () => {
    const rows = [
      row({ id: 1, mode: "paper", entryTime: Date.parse("2026-09-24T19:00:00Z") }), // 00:30 IST on the 25th
      row({ id: 2, mode: "live", entryTime: Date.parse("2026-09-25T06:00:00Z") }),
      row({ id: 3, mode: "paper", entryTime: Date.parse("2026-09-24T12:00:00Z") }), // the 24th IST
    ];
    const out = shadowRecordsFor(rows, { mode: "paper", timeZone: "Asia/Kolkata", from: "2026-09-25", to: "2026-09-25" });
    expect(out.map((s) => s.entryTime)).toEqual([Date.parse("2026-09-24T19:00:00Z")]);
  });
});
