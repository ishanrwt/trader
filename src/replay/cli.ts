import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadEnv } from "../config/loadEnv.js";
import { compareShadowVsActual, pairShadowsWithTrades } from "../report/index.js";
import { shadowRecordsFor } from "../report/shadowRecords.js";
import { MintFeaturesStore } from "../storage/mintFeatures.js";
import { PricePathsStore } from "../storage/pricePaths.js";
import { ShadowsStore } from "../storage/shadows.js";
import { TradeHistoryStore } from "../storage/tradeHistory.js";
import { TradesStore } from "../storage/trades.js";
import { tradingDayKey } from "../time.js";
import { buildVariants, ReplayConfigError } from "./config.js";
import { crossCheck, formatCrossCheck, formatVariant, runVariant, type ReplayPath } from "./index.js";

/**
 * npm run replay -- --config <file.json> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *   [--mode paper|live] [--crosscheck] [--tolerance <pp>] [--include-incomplete] [--db <file>]
 *
 * Offline: opens the database read-only and never calls any network client.
 */
export interface ReplayArgs {
  config?: string;
  from?: string;
  to?: string;
  mode: string;
  crosscheck: boolean;
  tolerance: number;
  includeIncomplete: boolean;
  db?: string;
}

export function parseArgs(argv: string[]): ReplayArgs {
  const out: ReplayArgs = { mode: "paper", crosscheck: false, tolerance: 5, includeIncomplete: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new ReplayConfigError(`${a} needs a value`);
      return v;
    };
    if (a === "--config") out.config = next();
    else if (a === "--from") out.from = next();
    else if (a === "--to") out.to = next();
    else if (a === "--mode") out.mode = next();
    else if (a === "--db") out.db = next();
    else if (a === "--crosscheck") out.crosscheck = true;
    else if (a === "--include-incomplete") out.includeIncomplete = true;
    else if (a === "--tolerance") out.tolerance = Number(next());
    else throw new ReplayConfigError(`unknown argument: ${a}`);
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) throw new ReplayConfigError("--config <file.json> is required");
  const { env } = loadEnv();
  const { baseline, variants, timeZone } = buildVariants(env, JSON.parse(fs.readFileSync(args.config, "utf8")));

  const db = new Database(args.db ?? path.join(process.cwd(), "trader.db"), { readonly: true, fileMustExist: true });
  const pathsStore = new PricePathsStore(db);
  const features = new Map(new MintFeaturesStore(db).listAll(args.mode).map((f) => [f.mint, f]));
  const inPeriod = (ms: number) => {
    const day = tradingDayKey(ms, timeZone);
    return (args.from === undefined || day >= args.from) && (args.to === undefined || day <= args.to);
  };
  const paths: ReplayPath[] = pathsStore
    .listAll(args.mode)
    .filter((p) => inPeriod(p.startedAt))
    .map((p) => ({ path: p, points: pathsStore.listPoints(p.id), features: features.get(p.mint) }));

  const fmtTime = (ms: number) => new Date(ms).toLocaleString("sv-SE", { timeZone }).slice(5, 16);
  const period = `${args.from ?? "start"} to ${args.to ?? "now"}`;
  console.log(`Replay (${args.mode}, paths started ${period}, ${timeZone}). Offline: shadow cost model (SPEC 11.2), real exit state machine (SPEC 8.3).`);
  console.log(
    "Notes: stops confirm on the same mark (no second quote); a position still open when its 60-minute path ends is marked `path_end`; " +
      "variant filters replace the baseline's; drawdown is over exit order.\n",
  );

  const baseResult = runVariant(baseline, paths, { includeIncomplete: args.includeIncomplete });
  console.log(formatVariant(baseResult));
  for (const v of variants) console.log("\n" + formatVariant(runVariant(v, paths, { includeIncomplete: args.includeIncomplete }), baseResult));

  if (args.crosscheck) {
    const trades = new TradesStore(db).listAll({ mode: args.mode, ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}) });
    const history = new TradeHistoryStore(db);
    const real = trades.map((t) => {
      const pnls = history.listForTrade(t.id).map((h) => h.pnl);
      return { ...t, minHistoryPnlPct: pnls.length > 0 ? Math.min(...pnls) : null };
    });
    const result = crossCheck(baseline, real, paths, args.tolerance);
    // The report's own shadow-vs-actual figures over the same period, from the current database.
    const shadows = shadowRecordsFor(new ShadowsStore(db).listAll(), { mode: args.mode, timeZone, ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}) });
    const shadowNow = compareShadowVsActual(pairShadowsWithTrades(shadows, trades));
    console.log("\n" + formatCrossCheck(result, args.tolerance, shadowNow.pairs > 0 ? { ...shadowNow } : null, fmtTime));
  }
  db.close();
}

try {
  main();
} catch (err) {
  if (err instanceof ReplayConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
