import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/storage/db.js";
import { TradesStore, type NewTradeRow } from "../../src/storage/trades.js";
import { TradeHistoryStore } from "../../src/storage/tradeHistory.js";

const CLI_PATH = fileURLToPath(new URL("../../src/report/cli.ts", import.meta.url));
// An absolute file:// URL to tsx's loader, not the bare "tsx/esm" specifier: a bare
// specifier would need to resolve through node_modules starting from the child
// process's cwd, which is deliberately the temp dir below (not the project root) so
// the child never finds — and therefore never loads — the real project .env.
const TSX_LOADER_URL = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;

function seedTrade(dbPath: string, overrides: Partial<NewTradeRow> = {}): number {
  const db = openDb(dbPath);
  const id = new TradesStore(db).insert({
    mode: "paper",
    mint: "MINT1",
    symbol: "FOO",
    pairAddress: "pair1",
    entryTime: 1000,
    exitTime: 2000,
    sizeUsd: 25,
    costBasis: 25.05,
    proceeds: 30,
    netPnlUsd: 4.95,
    netPnlPct: 19.76,
    exitReason: "target",
    peakPnl: 20,
    timerRestarts: 0,
    targetExtensions: 0,
    feesUsd: 0.1,
    entryPairSnapshot: null,
    top1Pct: 5,
    top10Pct: 20,
    score: 0.6,
    scoreComponents: null,
    animalFlag: null,
    tradingDay: "2026-01-01",
    tokenAmount: 1000,
    tokenDecimals: 6,
    entryValuationPnlPct: -1.5,
    entryQuoteInAmount: null,
    entryQuoteOutAmount: null,
    exitQuoteInAmount: null,
    exitQuoteOutAmount: null,
    ...overrides,
  });
  db.close();
  return id;
}

describe("report CLI entry point (src/report/cli.ts), not just the report functions", () => {
  it("runs with no secrets anywhere in the environment and prints a report against a seeded database", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-report-cli-"));
    const dbPath = path.join(tmpDir, "trader.db");
    try {
      seedTrade(dbPath);

      // A deliberately secret-free, .env-free environment: cwd is the temp dir (no .env
      // there to find), and the explicit env below has none of SOLANA_RPC_URL,
      // JUPITER_API_KEY, TRADER_TELEGRAM_BOT_TOKEN or TRADER_TELEGRAM_CHAT_ID — this is
      // exactly the ConfigError scenario the bug report described, run through the real
      // CLI entry point, not just the report functions.
      const output = execFileSync(process.execPath, ["--import", TSX_LOADER_URL, CLI_PATH, "--db", dbPath, "--mode", "paper"], {
        cwd: tmpDir,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
        encoding: "utf8",
      });

      expect(output).toContain("=== Report (1 trades) ===");
      expect(output).toContain("Go-live checklist (as if live):"); // paper: the checklist uses the as-if-live view (section 11.4)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("--trades prints per-trade detail, including preserved trade_history, with no secrets in the environment", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-report-cli-trades-"));
    const dbPath = path.join(tmpDir, "trader.db");
    try {
      const tradeId = seedTrade(dbPath, { tokenAmount: 68_306.48291, tokenDecimals: 6, entryValuationPnlPct: -3.2 });
      const db = openDb(dbPath);
      new TradeHistoryStore(db).insertMany(tradeId, [
        { t: 1000, pnl: -3.2 },
        { t: 1010, pnl: -1.1 },
      ]);
      db.close();

      const output = execFileSync(process.execPath, ["--import", TSX_LOADER_URL, CLI_PATH, "--db", dbPath, "--trades"], {
        cwd: tmpDir,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
        encoding: "utf8",
      });

      expect(output).toContain(`=== Trade ${tradeId}: FOO (MINT1) ===`);
      expect(output).toContain("tokens received: 68306.48291  decimals: 6");
      expect(output).toContain("entry valuation (first exit-lane quote after fill): -3.20%");
      expect(output).toContain("history (2 of 2): (1000, -3.20%), (1010, -1.10%)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("--trades shows both the first 5 and last 5 trade_history points when there are more than 10", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-report-cli-trades-long-"));
    const dbPath = path.join(tmpDir, "trader.db");
    try {
      const tradeId = seedTrade(dbPath);
      const db = openDb(dbPath);
      const points = Array.from({ length: 12 }, (_, i) => ({ t: i * 1000, pnl: i }));
      new TradeHistoryStore(db).insertMany(tradeId, points);
      db.close();

      const output = execFileSync(process.execPath, ["--import", TSX_LOADER_URL, CLI_PATH, "--db", dbPath, "--trades"], {
        cwd: tmpDir,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
        encoding: "utf8",
      });

      expect(output).toContain("history, first 5 of 12:");
      expect(output).toContain("history, last 5 of 12");
      expect(output).toContain("(11000, 11.00%)"); // the actual last point, not truncated away
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("still runs (and reports zero trades) against a brand-new, empty database", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-report-cli-empty-"));
    const dbPath = path.join(tmpDir, "trader.db");
    try {
      const output = execFileSync(process.execPath, ["--import", TSX_LOADER_URL, CLI_PATH, "--db", dbPath], {
        cwd: tmpDir,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
        encoding: "utf8",
      });
      expect(output).toContain("=== Report (0 trades) ===");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
