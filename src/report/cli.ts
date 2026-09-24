import path from "node:path";
import { loadEnv } from "../config/loadEnv.js";
import { loadReportConfig, ReportConfigError } from "../config/reportConfig.js";
import { formatReport, type TradeRecord } from "./index.js";
import { openDb } from "../storage/db.js";
import { TradesStore } from "../storage/trades.js";
import { SkipTracksStore } from "../storage/skipTracks.js";
import { PositionsStore } from "../storage/positions.js";
import { shouldWriteOff } from "../executor/paper.js";
import type { DexPair } from "../types.js";

function parseArgs(argv: string[]): { mode?: "paper" | "live"; from?: string; to?: string; db?: string } {
  const out: { mode?: "paper" | "live"; from?: string; to?: string; db?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode") {
      const value = argv[++i];
      if (value) out.mode = value as "paper" | "live";
    } else if (arg === "--from") {
      const value = argv[++i];
      if (value) out.from = value;
    } else if (arg === "--to") {
      const value = argv[++i];
      if (value) out.to = value;
    } else if (arg === "--db") {
      const value = argv[++i];
      if (value) out.db = value;
    }
  }
  return out;
}

function main(): void {
  // The report only ever reads the local SQLite database — no secrets needed,
  // so .env is loaded (for GOLIVE_*/STUCK_WRITE_OFF_MIN overrides, if present)
  // but its absence, or a missing API key, is not an error here.
  const { env } = loadEnv();

  let config;
  try {
    config = loadReportConfig(env);
  } catch (err) {
    if (err instanceof ReportConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const opts = parseArgs(process.argv.slice(2));
  const dbPath = opts.db ?? path.join(process.cwd(), "trader.db");
  const db = openDb(dbPath);

  const tradesStore = new TradesStore(db);
  const skipTracksStore = new SkipTracksStore(db);
  const positionsStore = new PositionsStore(db);

  function toRecords(mode?: "paper" | "live", from?: string, to?: string): TradeRecord[] {
    return tradesStore.listAll({ ...(mode ? { mode } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).map((t) => {
      const snapshot = t.entryPairSnapshot as DexPair | null;
      return {
        mode: t.mode as "paper" | "live",
        exitTime: t.exitTime,
        tradingDay: t.tradingDay,
        exitReason: t.exitReason,
        netPnlUsd: t.netPnlUsd,
        netPnlPct: t.netPnlPct,
        m5ChangePct: snapshot?.priceChange?.m5 ?? null,
        h1ChangePct: snapshot?.priceChange?.h1 ?? null,
        buyPressurePct: null,
        liquidityUsd: snapshot?.liquidity?.usd ?? null,
        pairAgeMs: snapshot?.pairCreatedAt ? t.entryTime - snapshot.pairCreatedAt : null,
        top10Pct: t.top10Pct,
        score: t.score,
        scoreComponents: t.scoreComponents as TradeRecord["scoreComponents"],
      };
    });
  }

  const hasStuck = positionsStore.listClosing().some((r) => shouldWriteOff(r.closingSince ?? Date.now(), Date.now(), config.STUCK_WRITE_OFF_MIN));

  console.log(
    formatReport({
      trades: toRecords(opts.mode, opts.from, opts.to),
      paperTrades: toRecords("paper"),
      skipTracks: skipTracksStore.listAll().map((r) => ({ skipReason: r.skipReason, priceAtSkipUsd: r.priceAtSkipUsd, price15mUsd: r.price15mUsd, price60mUsd: r.price60mUsd })),
      hasStuckPositions: hasStuck,
      goLiveConfig: {
        minTrades: config.GOLIVE_MIN_TRADES,
        minDays: config.GOLIVE_MIN_DAYS,
        minMedianPnlPct: config.GOLIVE_MIN_MEDIAN_PNL_PCT,
        minTotalPnlUsd: config.GOLIVE_MIN_TOTAL_PNL_USD,
        minP10PnlPct: config.GOLIVE_MIN_P10_PNL_PCT,
      },
    }),
  );
  db.close();
}

main();
