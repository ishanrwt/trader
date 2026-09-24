import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/storage/db.js";
import { TradesStore, type NewTradeRow } from "../../src/storage/trades.js";

const CLI_PATH = fileURLToPath(new URL("../../src/report/cli.ts", import.meta.url));
// An absolute file:// URL to tsx's loader, not the bare "tsx/esm" specifier: a bare
// specifier would need to resolve through node_modules starting from the child
// process's cwd, which is deliberately the temp dir below (not the project root) so
// the child never finds — and therefore never loads — the real project .env.
const TSX_LOADER_URL = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;

function seedTrade(dbPath: string, overrides: Partial<NewTradeRow> = {}): void {
  const db = openDb(dbPath);
  new TradesStore(db).insert({
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
    ...overrides,
  });
  db.close();
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
      expect(output).toContain("Go-live checklist:");
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
