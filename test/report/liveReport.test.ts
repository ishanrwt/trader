import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { TelegramUpdate } from "../../src/clients/telegram.js";
import { createMemoryLogger } from "../../src/logger/index.js";
import { pollAndHandleCommands, type CommandsTelegram } from "../../src/notify/commands.js";
import { buildDigest, type DigestInput } from "../../src/notify/digest.js";
import { computeTotals, formatReport, formatTradeDetail, type TradeRecord } from "../../src/report/index.js";
import { openDb } from "../../src/storage/db.js";
import { FeeLossesStore } from "../../src/storage/feeLosses.js";
import { StateStore } from "../../src/storage/state.js";
import { TradesStore, type NewTradeRow } from "../../src/storage/trades.js";

function rec(o: Partial<TradeRecord>): TradeRecord {
  return {
    mode: "live", exitTime: 1, tradingDay: "2026-09-25", exitReason: "target", netPnlUsd: 0, netPnlPct: 0, m5ChangePct: null, h1ChangePct: null,
    buyPressurePct: null, liquidityUsd: null, pairAgeMs: null, top10Pct: null, score: null, scoreComponents: null, ...o,
  };
}

describe("report: proceeds_unknown trades and fee losses (SPEC.md sections 11.4, 16.3, 16.5)", () => {
  const trades = [
    rec({ exitTime: 1000, netPnlUsd: 10, netPnlPct: 40 }),
    rec({ exitTime: 2000, netPnlUsd: -5, netPnlPct: -20 }),
    rec({ exitTime: 3000, netPnlUsd: -25, netPnlPct: -100, exitReason: "reconciled", proceedsUnknown: true }),
  ];
  const feeLosses = [{ ts: 1500, tradingDay: "2026-09-25", usd: 2 }];

  it("excludes proceeds_unknown trades from win rate, median and mean, but counts them in total and drawdown", () => {
    const t = computeTotals(trades, feeLosses);
    expect(t.winRate).toBe(0.5); // 1 win of the 2 known trades
    expect(t.medianNetPnlPct).toBeCloseTo(10, 10); // median of [40, -20]
    expect(t.proceedsUnknownCount).toBe(1);
    expect(t.totalNetPnlUsd).toBeCloseTo(10 - 5 - 25 - 2, 10);
    // Chronological: +10, fee -2, -5, -25 -> cumulative 10, 8, 3, -22 -> max drawdown 32
    expect(t.maxDrawdownUsd).toBeCloseTo(32, 10);
    expect(t.feeLossUsd).toBe(2);
  });

  it("formatReport shows proceeds_unknown trades and fee losses separately, and names the mode", () => {
    const text = formatReport({
      trades,
      paperTrades: [],
      skipTracks: [],
      hasStuckPositions: false,
      goLiveConfig: { minTrades: 1, minDays: 0, minMedianPnlPct: 0, minTotalPnlUsd: 0, minP10PnlPct: -50 },
      feeLosses,
      modeLabel: "LIVE",
    });
    expect(text).toContain("##### LIVE #####");
    expect(text).toMatch(/Proceeds unknown .*: 1 trades, \$-25\.00/);
    expect(text).toMatch(/Fee losses from failed transactions .*: 1, \$2\.0000 \(2026-09-25: \$2\.0000\)/);
  });

  it("--trades detail prints the live fields and flags proceeds_unknown", () => {
    const text = formatTradeDetail([
      {
        id: 1, mint: "M", symbol: "S", entryTime: 0, exitTime: 1000, sizeUsd: 25, costBasis: 25.3, tokenAmount: 1, tokenDecimals: 6, proceeds: 0, netPnlUsd: -25.3,
        netPnlPct: -100, peakPnl: 0, exitReason: "reconciled", entryLiquidityUsd: null, entryValuationPnlPct: null, entryQuoteInAmount: null, entryQuoteOutAmount: null,
        exitQuoteInAmount: null, exitQuoteOutAmount: null, history: [],
        live: {
          mode: "live", entrySignature: "ENTRYSIG", exitSignature: null, entryUsdcRaw: "25000000", entryTokensRaw: "990000", exitTokensRaw: null, exitUsdcRaw: null,
          entryFeeLamports: 5180, exitFeeLamports: null, entryFeeUsd: 0.000777, exitFeeUsd: null, rentPaidLamports: 2039280, rentReclaimedLamports: null, rentPaidUsd: 0.3,
          rentReclaimedUsd: null, entrySolPriceUsd: 150, exitSolPriceUsd: null, sellAttempts: null, failedSellFeesLamports: null, failedSellFeesUsd: null, proceedsUnknown: true,
        },
      },
    ]);
    expect(text).toContain("PROCEEDS UNKNOWN");
    expect(text).toContain("entry tx: ENTRYSIG  USDC spent (raw): 25000000  tokens received (raw): 990000");
    expect(text).toContain("rent: paid 2039280 lamports");
  });
});

describe("report CLI: paper and live are never mixed (SPEC.md section 11.4)", () => {
  const CLI_PATH = fileURLToPath(new URL("../../src/report/cli.ts", import.meta.url));
  const TSX_LOADER_URL = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;

  function trade(o: Partial<NewTradeRow>): NewTradeRow {
    return {
      mode: "paper", mint: "MINT1", symbol: "FOO", pairAddress: null, entryTime: 1000, exitTime: 2000, sizeUsd: 25, costBasis: 25, proceeds: 30, netPnlUsd: 5, netPnlPct: 20,
      exitReason: "target", peakPnl: 20, timerRestarts: 0, targetExtensions: 0, feesUsd: 0.1, entryPairSnapshot: null, top1Pct: null, top10Pct: null, score: null,
      scoreComponents: null, animalFlag: null, tradingDay: "2026-09-25", tokenAmount: null, tokenDecimals: null, entryValuationPnlPct: null, entryQuoteInAmount: null,
      entryQuoteOutAmount: null, exitQuoteInAmount: null, exitQuoteOutAmount: null, ...o,
    };
  }

  it("without --mode prints a PAPER section and a LIVE section, with live fee losses only in LIVE", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-report-modes-"));
    const dbPath = path.join(tmpDir, "trader.db");
    try {
      const db = openDb(dbPath);
      const store = new TradesStore(db);
      store.insert(trade({ mode: "paper" }));
      store.insert(trade({ mode: "paper", exitTime: 3000 }));
      store.insert(trade({ mode: "live", exitTime: 4000, netPnlUsd: -1, netPnlPct: -4 }));
      new FeeLossesStore(db).insert({ mode: "live", ts: 5000, tradingDay: "2026-09-25", mint: "MINT1", positionId: null, intentId: null, signature: null, kind: "sell", lamports: 505_000, usd: 0.08, solPriceUsd: 150 });
      db.close();
      const output = execFileSync(process.execPath, ["--import", TSX_LOADER_URL, CLI_PATH, "--db", dbPath], {
        cwd: tmpDir,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
        encoding: "utf8",
      });
      const [paper, live] = output.split("##### LIVE #####");
      expect(paper).toContain("##### PAPER #####");
      expect(paper).toContain("=== Report (2 trades) ===");
      expect(paper).not.toContain("Fee losses");
      expect(live).toContain("=== Report (1 trades) ===");
      expect(live).toMatch(/Fee losses from failed transactions .*: 1, \$0\.0800/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("digest: live section and proceeds_unknown trades (SPEC.md section 10)", () => {
  const base: DigestInput = {
    mode: "LIVE", now: 10_000, startedAt: 0, paused: false, killed: false, dailyLossHalted: false, errorHalted: false, lossStreak: 0, solPriceUsd: 150,
    walletUsdc: 80, walletSol: 0.1, tradesClosed: [], openPositions: [],
    tradingDay: { trades: 0, winRate: 0, medianNetPnlPct: 0, meanNetPnlPct: 0, totalNetPnlUsd: 0, biggestWinUsd: null, biggestLossUsd: null, exitReasonBreakdown: {} },
    funnel: { discovered: 0, eligible: 0, ready: 0, entered: 0, pendingNow: 0, skipReasons: {}, skippedSlotsFullCount: 0, scoreRangeOfEntries: null },
    risk: { dailyLossUsd: 0, dailyLossCapUsd: 30 },
    health: { dexScreenerErrors: 0, rpcErrors: 0, jupiterRequestsPerMinAvg: 0, jupiterRequestsPerMinPeak: 0, jupiter429s: 0, deferredEntryChecks: 0, downtimeGaps: [] },
  };

  it("renders the reserve, stuck positions, fee losses, RPC and transaction counts, unknown tokens and empty accounts", () => {
    const text = buildDigest({
      ...base,
      proceedsUnknownTrades: [{ symbol: "GONE", exitReason: "reconciled", netPnlPct: -100, netPnlUsd: -25.3 }],
      live: {
        sellFeeReserveSol: 0.004545,
        closingPositions: [{ symbol: "STK", stuckState: "budget_exhausted", sellAttempts: 11, sellFeesLamports: 5_050_000 }],
        feeLossesToday: { count: 2, usd: 0.15 },
        rpcRequests: 321,
        tx: { sent: 4, landed: 3, failed: 1, expired: 0, refused: 1 },
        unknownTokens: ["UNKNOWNMINT"],
        emptyTokenAccounts: 2,
      },
    });
    expect(text).toContain("=== Trader digest (LIVE) ===");
    expect(text).toContain("SELL_FEE_RESERVE_SOL: 0.004545 SOL");
    expect(text).toContain("Closed with proceeds unknown (reconciled; the loss may not be real):");
    expect(text).toContain("  GONE: recorded -$25.30");
    expect(text).toContain("  STK: budget_exhausted, sell attempts 11, fees spent 0.005050 SOL");
    expect(text).toContain("fee losses from failed transactions: 2, -$0.15");
    expect(text).toContain("RPC requests this window: 321");
    expect(text).toContain("Transactions: sent 4, landed 3, failed 1, expired 0; verification refusals 1");
    expect(text).toContain("unknown tokens (never traded automatically): UNKNOWNMINT");
    expect(text).toContain("empty token accounts left open: 2");
  });

  it("paper digests have no live section", () => {
    const text = buildDigest({ ...base, mode: "PAPER" });
    expect(text).not.toContain("SELL_FEE_RESERVE_SOL");
    expect(text).not.toContain("Wallet reconciliation");
  });
});

describe("/sellretry (decision 3)", () => {
  function telegram(updates: TelegramUpdate[]): CommandsTelegram & { sent: string[] } {
    const sent: string[] = [];
    return { sent, getUpdates: vi.fn().mockResolvedValue(updates), isFromConfiguredChat: (u) => u.message?.chat?.id === "chat1", sendMessage: vi.fn(async (t: string) => void sent.push(t)) };
  }
  const msg = (chat: string, text: string): TelegramUpdate => ({ update_id: 1, message: { message_id: 1, chat: { id: chat }, text, date: 0 } });

  it("in live mode, passes the prefix to the executor and replies with its answer", async () => {
    const t = telegram([msg("chat1", "/sellretry Abc12")]);
    const sellRetry = vi.fn(() => "Granted one more SELL_FEE_BUDGET_SOL to X");
    await pollAndHandleCommands({ telegram: t, stateStore: new StateStore(openDb(":memory:")), offset: 0, timeoutSec: 1, buildDigest: () => "", buildReport: () => "", logger: createMemoryLogger(), sellRetry });
    expect(sellRetry).toHaveBeenCalledWith("Abc12");
    expect(t.sent).toEqual(["Granted one more SELL_FEE_BUDGET_SOL to X"]);
  });

  it("is ignored from any other chat", async () => {
    const t = telegram([msg("other", "/sellretry Abc12")]);
    const sellRetry = vi.fn(() => "x");
    await pollAndHandleCommands({ telegram: t, stateStore: new StateStore(openDb(":memory:")), offset: 0, timeoutSec: 1, buildDigest: () => "", buildReport: () => "", logger: createMemoryLogger(), sellRetry });
    expect(sellRetry).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
  });

  it("in paper mode says it only applies to live mode", async () => {
    const t = telegram([msg("chat1", "/sellretry Abc")]);
    await pollAndHandleCommands({ telegram: t, stateStore: new StateStore(openDb(":memory:")), offset: 0, timeoutSec: 1, buildDigest: () => "", buildReport: () => "", logger: createMemoryLogger() });
    expect(t.sent).toEqual(["/sellretry only applies in live mode."]);
  });
});
