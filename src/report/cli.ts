import path from "node:path";
import { loadEnv } from "../config/loadEnv.js";
import { loadReportConfig, ReportConfigError } from "../config/reportConfig.js";
import { formatReport, formatTradeDetail, tradeRowToDetailRecord, tradeRowToRecord, type ReplayableTradeRecord } from "./index.js";
import { postExitRecordsFor } from "./postExitRecords.js";
import { rugFeaturesFor } from "./rugReport.js";
import { MintFeaturesStore } from "../storage/mintFeatures.js";
import { PostExitTracksStore } from "../storage/postExitTracks.js";
import { buildWindowsReport } from "./windows.js";
import { tradingDayKey } from "../time.js";
import { openDb } from "../storage/db.js";
import { TradesStore } from "../storage/trades.js";
import { ShadowsStore } from "../storage/shadows.js";
import { shadowRecordsFor } from "./shadowRecords.js";
import { TradeHistoryStore } from "../storage/tradeHistory.js";
import { SkipTracksStore } from "../storage/skipTracks.js";
import { PositionsStore } from "../storage/positions.js";
import { FeeLossesStore } from "../storage/feeLosses.js";
import { shouldWriteOff } from "../executor/paper.js";
import type { DexPair } from "../types.js";

export interface ReportArgs {
  mode?: "paper" | "live";
  from?: string;
  to?: string;
  db?: string;
  trades?: boolean;
  windows?: boolean;
  day?: string;
}

export function parseArgs(argv: string[]): ReportArgs {
  const out: ReportArgs = {};
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
    } else if (arg === "--trades") {
      out.trades = true;
    } else if (arg === "--windows") {
      out.windows = true;
    } else if (arg === "--day") {
      const value = argv[++i];
      if (value) out.day = value;
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
  const tradeHistoryStore = new TradeHistoryStore(db);
  const skipTracksStore = new SkipTracksStore(db);
  const positionsStore = new PositionsStore(db);

  if (opts.windows) {
    // Section 11.4: per-window stats for one trading day (default today), each mode separately.
    const now = Date.now();
    const day = opts.day ?? tradingDayKey(now, config.TRADING_DAY_TZ);
    const modes: Array<"paper" | "live"> = opts.mode ? [opts.mode] : ["paper", "live"];
    const windowOpts = { day, timeZone: config.TRADING_DAY_TZ, intervalMin: config.DIGEST_INTERVAL_MINUTES, now };
    console.log(modes.map((mode) => buildWindowsReport(db, { mode, ...windowOpts })).join("\n\n"));
    db.close();
    return;
  }

  if (opts.trades) {
    const rows = tradesStore.listAll({ ...(opts.mode ? { mode: opts.mode } : {}), ...(opts.from ? { from: opts.from } : {}), ...(opts.to ? { to: opts.to } : {}) });
    const detail = rows.map((t) => tradeRowToDetailRecord(t, tradeHistoryStore.listForTrade(t.id)));
    console.log(formatTradeDetail(detail));
    db.close();
    return;
  }

  function toRecords(mode?: "paper" | "live", from?: string, to?: string): ReplayableTradeRecord[] {
    return tradesStore.listAll({ ...(mode ? { mode } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).map(tradeRowToRecord);
  }
  const feeLossesStore = new FeeLossesStore(db);

  const hasStuck = positionsStore
    .listClosing()
    .some((r) => r.stuckState !== null || (r.mode === "paper" && shouldWriteOff(r.closingSince ?? Date.now(), Date.now(), config.STUCK_WRITE_OFF_MIN)));

  // Section 11.4: paper and live are never mixed. Without --mode, every section is printed once per mode.
  const modes: Array<"paper" | "live"> = opts.mode ? [opts.mode] : ["paper", "live"];
  const sections = modes.map((mode) =>
    formatReport({
      trades: toRecords(mode, opts.from, opts.to),
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
      ...(mode === "live"
        ? { feeLosses: feeLossesStore.listAll({ mode: "live", ...(opts.from ? { from: opts.from } : {}), ...(opts.to ? { to: opts.to } : {}) }) }
        : {}),
      ...(opts.mode ? {} : { modeLabel: mode.toUpperCase() }),
      rugFeatures: rugFeaturesFor(new MintFeaturesStore(db).listAll(), { mode, timeZone: config.TRADING_DAY_TZ, ...(opts.from ? { from: opts.from } : {}), ...(opts.to ? { to: opts.to } : {}) }),
      postExit: postExitRecordsFor(new PostExitTracksStore(db).listAll(), tradesStore.listAll(), { mode, ...(opts.from ? { from: opts.from } : {}), ...(opts.to ? { to: opts.to } : {}) }),
      shadows: shadowRecordsFor(new ShadowsStore(db).listAll(), { mode, timeZone: config.TRADING_DAY_TZ, ...(opts.from ? { from: opts.from } : {}), ...(opts.to ? { to: opts.to } : {}) }),
      // Section 11.4: paper also gets the "as if live" view, and the go-live checklist uses it.
      ...(mode === "paper"
        ? {
            asIfLive: {
              cfg: {
                maxDailyLossUsd: config.MAX_DAILY_LOSS_USD,
                consecutiveLossPause: config.CONSECUTIVE_LOSS_PAUSE,
                lossPauseMinutes: config.LOSS_PAUSE_MINUTES,
                tradingDayTz: config.TRADING_DAY_TZ,
              },
              allPaperTrades: toRecords("paper"),
              ...(opts.from ? { from: opts.from } : {}),
              ...(opts.to ? { to: opts.to } : {}),
            },
          }
        : {}),
    }),
  );
  console.log(sections.join("\n\n"));
  db.close();
}

main();
