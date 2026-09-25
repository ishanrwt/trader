import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buyPressurePct,
  formatExitedTooEarly,
  formatFeatureQuartiles,
  formatReport,
  exitedTooEarly,
  tradeRowToRecord,
  type TradeRecord,
} from "../../src/report/index.js";
import { postExitRecordsFor } from "../../src/report/postExitRecords.js";
import { openDb } from "../../src/storage/db.js";
import { PostExitTracksStore, type PostExitTrackRow } from "../../src/storage/postExitTracks.js";
import { SkipTracksStore } from "../../src/storage/skipTracks.js";
import { TradesStore, type NewTradeRow, type TradeRow } from "../../src/storage/trades.js";

const tr = (o: Partial<TradeRecord>): TradeRecord => ({
  mode: "paper", exitTime: 0, tradingDay: "2026-09-25", exitReason: "stop", netPnlUsd: 0, netPnlPct: 0, m5ChangePct: null, h1ChangePct: null,
  buyPressurePct: null, liquidityUsd: null, pairAgeMs: null, top10Pct: null, score: null, scoreComponents: null, ...o,
});
const GOLIVE = { minTrades: 1, minDays: 0, minMedianPnlPct: 0, minTotalPnlUsd: 0, minP10PnlPct: -100 };

describe("totals and breakdowns (section 11.4)", () => {
  const trades = [
    tr({ exitReason: "stop", tradingDay: "2026-09-24", netPnlUsd: -5, netPnlPct: -20 }),
    tr({ exitReason: "stop", tradingDay: "2026-09-25", netPnlUsd: -2.5, netPnlPct: -10 }),
    tr({ exitReason: "target", tradingDay: "2026-09-25", netPnlUsd: 7.5, netPnlPct: 30 }),
    tr({ exitReason: "trail", tradingDay: "2026-09-25", netPnlUsd: 2.5, netPnlPct: 10 }),
  ];
  const text = formatReport({ trades, paperTrades: trades, skipTracks: [], hasStuckPositions: false, goLiveConfig: GOLIVE });

  it("prints every totals field: mean %, median/mean USD, p10, p90, average win vs loss", () => {
    // pcts sorted [-20,-10,10,30]: mean 2.5, p10 = -20 + 0.3*10 = -17, p90 = 10 + 0.7*20 = 24; usd [-5,-2.5,2.5,7.5]: median 0, mean 0.625
    expect(text).toContain("Mean 2.5%, median $0.00, mean $0.63, p10 -17.0%, p90 24.0%, avg win $5.00 vs avg loss $-3.75");
  });

  it("prints results per exit reason and per trading day, not just counts", () => {
    expect(text).toContain("  stop: 2 trades, win rate 0.0%, median -15.0%, total $-7.50");
    expect(text).toContain("  target: 1 trades, win rate 100.0%, median 30.0%, total $7.50");
    expect(text).toContain("  2026-09-24: 1 trades, win rate 0.0%, median -20.0%, total $-5.00");
    expect(text).toContain("  2026-09-25: 3 trades, win rate 66.7%, median 10.0%, total $7.50");
  });
});

describe("entry-feature quartiles (section 11.4)", () => {
  it("buckets each feature into quartiles with their ranges, and counts trades missing the feature", () => {
    const trades = [1, 2, 3, 4, 5, 6, 7, 8].map((m5, i) =>
      tr({ m5ChangePct: m5, netPnlUsd: i % 2 === 0 ? 1 : -1, netPnlPct: i % 2 === 0 ? 4 : -4, pairAgeMs: (i + 1) * 60_000 }),
    );
    trades.push(tr({ m5ChangePct: null, netPnlPct: 1 }));
    const lines = formatFeatureQuartiles(trades);
    expect(lines[0]).toBe("Entry-feature quartiles (Q1 lowest; [range] trades, win rate, median net PnL %):");
    expect(lines[1]).toBe("  m5 change %: Q1 [1.0..2.0] 2, 50%, 0.0% | Q2 [3.0..4.0] 2, 50%, 0.0% | Q3 [5.0..6.0] 2, 50%, 0.0% | Q4 [7.0..8.0] 2, 50%, 0.0%; missing 1");
    expect(lines[3]).toBe("  buy pressure %: no data; missing 9");
    expect(lines[5]).toBe("  pair age min: Q1 [1.0..2.0] 2, 50%, 0.0% | Q2 [3.0..4.0] 2, 50%, 0.0% | Q3 [5.0..6.0] 2, 50%, 0.0% | Q4 [7.0..8.0] 2, 50%, 0.0%; missing 1");
  });

  it("buy pressure comes from the snapshot's m5 txns, and is null without them", () => {
    expect(buyPressurePct({ txns: { m5: { buys: 1190, sells: 138 } } })).toBeCloseTo((1190 / 1328) * 100, 10);
    expect(buyPressurePct({ txns: { m5: { buys: 0, sells: 0 } } })).toBeNull();
    expect(buyPressurePct({ liquidity: { usd: 1 } })).toBeNull();
    expect(buyPressurePct(null)).toBeNull();
  });

  it("the shared record builder fills buy pressure, pair age and the entry features from a stored trade", () => {
    const store = new TradesStore(openDb(":memory:"));
    const row: NewTradeRow = {
      mode: "paper", mint: "M", symbol: "S", pairAddress: "P", entryTime: 1_790_293_844_150, exitTime: 1_790_293_996_291, sizeUsd: 25, costBasis: 25.05,
      proceeds: 18.78, netPnlUsd: -6.27, netPnlPct: -25.05, exitReason: "stop", peakPnl: 4.2, timerRestarts: 0, targetExtensions: 0, feesUsd: 0.1,
      entryPairSnapshot: { txns: { m5: { buys: 1190, sells: 138 } }, priceChange: { m5: 16.9, h1: 141 }, liquidity: { usd: 40663.34 }, pairCreatedAt: 1_790_292_630_000 },
      top1Pct: 1.5, top10Pct: 13.87, score: 0.77, scoreComponents: null, animalFlag: null, tradingDay: "2026-09-25", tokenAmount: 1, tokenDecimals: 6,
      entryValuationPnlPct: null, entryQuoteInAmount: null, entryQuoteOutAmount: null, exitQuoteInAmount: null, exitQuoteOutAmount: null,
    };
    const rec = tradeRowToRecord(store.get(store.insert(row)) as TradeRow);
    expect(rec).toMatchObject({ m5ChangePct: 16.9, h1ChangePct: 141, liquidityUsd: 40663.34, top10Pct: 13.87, mint: "M", entryTime: 1_790_293_844_150 });
    expect(rec.buyPressurePct).toBeCloseTo(89.608, 3);
    expect(rec.pairAgeMs).toBe(1_790_293_844_150 - 1_790_292_630_000);
  });
});

describe("exited too early (section 11.4)", () => {
  it("prints each horizon and how many rows were left out", () => {
    const r = exitedTooEarly([
      { exitPriceUsd: 1, exitPriceSource: "dexscreener_at_exit", price15mUsd: 1.2, price60mUsd: 0.9 },
      { exitPriceUsd: 1, exitPriceSource: "entry_snapshot", price15mUsd: 3, price60mUsd: 3 },
    ]);
    expect(formatExitedTooEarly(r)).toEqual([
      "Exited too early (DexScreener price after exit vs at exit):",
      "  +15m: 1 with data, 100.0% above the exit price, median upside 20.0% among those",
      "  +60m: 1 with data, 0.0% above the exit price, median upside 0.0% among those",
      "  excluded 1 with no valid exit price (recorded before the section 11.3 fix, or the fetch at exit failed)",
    ]);
  });

  it("postExitRecordsFor keeps one mode and the report period by the trade's trading day", () => {
    const row = (id: number, tradeId: number): PostExitTrackRow => ({
      id, tradeId, mint: "M", exitTime: 0, exitPriceUsd: 1, exitPriceSource: "dexscreener_at_exit", price15mUsd: 1, price30mUsd: null, price60mUsd: null, resolved: false,
    });
    const trades = [
      { id: 1, mode: "paper", tradingDay: "2026-09-24" },
      { id: 2, mode: "paper", tradingDay: "2026-09-25" },
      { id: 3, mode: "live", tradingDay: "2026-09-25" },
    ];
    expect(postExitRecordsFor([row(10, 1), row(20, 2), row(30, 3), row(40, 99)], trades, { mode: "paper", from: "2026-09-25" })).toHaveLength(1);
  });
});

describe("npm run report prints every section 11.4 lists (CLI on a seeded database)", () => {
  const CLI_PATH = fileURLToPath(new URL("../../src/report/cli.ts", import.meta.url));
  const TSX_LOADER_URL = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;

  it("totals, breakdowns, quartiles, score, shadows, exited too early, skipped tokens, go-live checklist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-report-sections-"));
    const dbPath = path.join(tmpDir, "trader.db");
    try {
      const db = openDb(dbPath);
      const trades = new TradesStore(db);
      const tradeId = trades.insert({
        mode: "paper", mint: "M", symbol: "S", pairAddress: "P", entryTime: 1000, exitTime: 2000, sizeUsd: 25, costBasis: 25.05, proceeds: 30,
        netPnlUsd: 4.95, netPnlPct: 19.76, exitReason: "target", peakPnl: 20, timerRestarts: 0, targetExtensions: 0, feesUsd: 0.1,
        entryPairSnapshot: { txns: { m5: { buys: 8, sells: 2 } }, priceChange: { m5: 5, h1: 10 }, liquidity: { usd: 20000 }, pairCreatedAt: 0 },
        top1Pct: 2, top10Pct: 20, score: 0.6, scoreComponents: null, animalFlag: null, tradingDay: "2026-01-01", tokenAmount: 1000, tokenDecimals: 6,
        entryValuationPnlPct: null, entryQuoteInAmount: null, entryQuoteOutAmount: null, exitQuoteInAmount: null, exitQuoteOutAmount: null,
      });
      new PostExitTracksStore(db).insert({ tradeId, mint: "M", exitTime: 2000, exitPriceUsd: 1, exitPriceSource: "dexscreener_at_exit" });
      new SkipTracksStore(db).insert({ mint: "X", skipReason: "aged_out", discoveredAt: 0, skippedAt: 10, priceAtSkipUsd: 0.5 });
      db.close();
      const out = execFileSync(process.execPath, ["--import", TSX_LOADER_URL, CLI_PATH, "--db", dbPath, "--mode", "paper"], {
        cwd: tmpDir,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
        encoding: "utf8",
      });
      for (const header of [
        "=== Report (1 trades) ===",
        "Win rate ",
        "Mean ",
        "By exit reason: target=1",
        "  target: 1 trades",
        "Trading days: 1",
        "  2026-01-01: 1 trades",
        "Entry-feature quartiles",
        "  buy pressure %: Q1 [80.0..80.0]",
        "Score quintiles",
        "Component correlations",
        "Shadows (excluding duplicates):",
        "Exited too early (DexScreener price after exit vs at exit):",
        "Skip reasons (median change from the price at skip; only rows with that baseline): aged_out(n=1, with baseline 1",
        "Go-live checklist (as if live):",
      ]) {
        expect(out).toContain(header);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
