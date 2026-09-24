import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

import { DexScreenerClient } from "./clients/dexscreener.js";
import { JupiterClient } from "./clients/jupiter.js";
import { SolanaRpcClient } from "./clients/rpc.js";
import { TelegramClient } from "./clients/telegram.js";
import { ConfigError, KNOWN_ENV_KEYS, loadConfig, unknownKeys, type Config } from "./config/index.js";
import { WRAPPED_SOL_MINT } from "./constants.js";
import { pollProfiles, recheckPending } from "./discovery/index.js";
import { PendingStore } from "./discovery/pendingStore.js";
import { JupiterLaneBudget } from "./limiters/jupiterBudget.js";
import { SlidingWindowLimiter } from "./limiters/slidingWindow.js";
import { createLogger, type Logger, type LogLevel } from "./logger/index.js";
import { pollAndHandleCommands, PAUSED_KEY, PAUSE_REASON_KEY } from "./notify/commands.js";
import { buildDigest, type Phase1DigestInput } from "./notify/digest.js";
import { detectStartup, heartbeat } from "./notify/lifecycle.js";
import { OutageTracker } from "./notify/outageTracker.js";
import { buildOutageRecoveredMessage, buildOutageStartedMessage, buildStartupMessage } from "./notify/urgent.js";
import { SolPriceTracker } from "./solPrice/index.js";
import { openDb } from "./storage/db.js";
import { StateStore } from "./storage/state.js";
import type { GateCheckId } from "./gate/index.js";

const cwd = process.cwd();
const ENV_PATH = path.join(cwd, ".env");
const DB_PATH = path.join(cwd, "trader.db");
const LOG_DIR = path.join(cwd, "logs");

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runLoop(name: string, intervalMs: number, logger: Logger, signal: AbortSignal, fn: () => Promise<void>): Promise<void> {
  while (!signal.aborted) {
    try {
      await fn();
    } catch (err) {
      logger.error(`${name} loop iteration failed`, { error: String(err) });
    }
    await sleep(intervalMs, signal);
  }
}

function loadEnv(): { env: NodeJS.ProcessEnv; fileKeys: string[] } {
  let fileKeys: string[] = [];
  if (fs.existsSync(ENV_PATH)) {
    const parsed = dotenv.parse(fs.readFileSync(ENV_PATH));
    fileKeys = Object.keys(parsed);
    dotenv.config({ path: ENV_PATH });
  }
  return { env: process.env, fileKeys };
}

interface FunnelCounters {
  discovered: number;
  skipReasons: Partial<Record<GateCheckId, number>>;
}

function emptyFunnelCounters(): FunnelCounters {
  return { discovered: 0, skipReasons: {} };
}

interface HealthCounters {
  dexScreenerErrors: number;
  rpcErrors: number;
  jupiter429s: number;
  downtimeGaps: Array<{ from: number; to: number }>;
}

function emptyHealthCounters(): HealthCounters {
  return { dexScreenerErrors: 0, rpcErrors: 0, jupiter429s: 0, downtimeGaps: [] };
}

async function main(): Promise<void> {
  const { env, fileKeys } = loadEnv();

  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  // config.LOG_LEVEL is runtime-validated against this exact set by the zod enum in schema.ts.
  const logger = createLogger({ level: config.LOG_LEVEL as LogLevel, secrets: config.secrets, logDir: LOG_DIR });

  for (const key of unknownKeys(fileKeys, KNOWN_ENV_KEYS)) {
    logger.warn(`Unknown key in .env, ignored: ${key}`);
  }
  if (config.jupiter.stretched) {
    logger.warn(`POLL_SECONDS auto-stretched to ${config.jupiter.effectivePollSeconds} to fit the Jupiter budget (AUTO_STRETCH_POLL=true)`);
  }

  const db = openDb(DB_PATH);
  const stateStore = new StateStore(db);
  const pendingStore = new PendingStore(db);

  const dexProfilesLimiter = new SlidingWindowLimiter(config.DEX_PROFILES_MAX_PER_MIN, 60_000);
  const dexPairsLimiter = new SlidingWindowLimiter(config.DEX_PAIRS_MAX_PER_MIN, 60_000);
  const rpcLimiter = new SlidingWindowLimiter(config.RPC_MAX_RPS, 1_000);
  const jupiterPhysicalLimiter = new SlidingWindowLimiter(config.JUPITER_MAX_REQ_PER_MIN, 60_000, config.JUPITER_MIN_INTERVAL_MS);
  // Constructed and startup-validated in Phase 1 (SPEC.md section 9.3); not called yet —
  // sellability/drift quotes and exit polling are Phase 2.
  const jupiterLaneBudget = new JupiterLaneBudget({
    jupiterMaxReqPerMin: config.JUPITER_MAX_REQ_PER_MIN,
    exitReserve: config.jupiter.exitReserve,
  });
  void jupiterLaneBudget;

  const dexClient = new DexScreenerClient({
    profilesLimiter: dexProfilesLimiter,
    pairsLimiter: dexPairsLimiter,
    logger,
  });
  // Idle in Phase 1 (no gate checks 5-8, no slot filling yet) but built and startup-validated.
  const rpcClient = new SolanaRpcClient({ url: config.SOLANA_RPC_URL, limiter: rpcLimiter, logger });
  void rpcClient;
  const jupiterClient = new JupiterClient({
    apiKey: config.JUPITER_API_KEY,
    physicalLimiter: jupiterPhysicalLimiter,
    logger,
  });
  void jupiterClient;

  const telegram = new TelegramClient({
    botToken: config.TRADER_TELEGRAM_BOT_TOKEN,
    chatId: config.TRADER_TELEGRAM_CHAT_ID,
    logger,
  });

  const quoteMintsForSol = config.ALLOWED_QUOTE_MINTS.filter((m) => m !== WRAPPED_SOL_MINT);
  const solPriceTracker = new SolPriceTracker(dexClient, quoteMintsForSol, logger);

  const dexOutage = new OutageTracker(config.OUTAGE_ALERT_MINUTES);
  const startedAt = Date.now();
  const funnel = emptyFunnelCounters();
  const health = emptyHealthCounters();

  const startup = detectStartup(stateStore, startedAt);
  heartbeat(stateStore, startedAt);
  if (config.URGENT_ALERTS) {
    await telegram.sendMessage(
      buildStartupMessage({ mode: config.MODE.toUpperCase(), isRestart: startup.isRestart, downtimeMs: startup.downtimeMs }),
    );
  }
  logger.info(startup.isRestart ? "Restarted" : "Started", { downtimeMs: startup.downtimeMs });

  const controller = new AbortController();
  const { signal } = controller;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      logger.info(`Received ${sig}, shutting down`);
      heartbeat(stateStore, Date.now());
      controller.abort();
    });
  }

  async function handleOutage(service: "DexScreener" | "RPC" | "Jupiter", success: boolean): Promise<void> {
    const event = dexOutage.recordResult(service, success, Date.now());
    if (!event || !config.URGENT_ALERTS) return;
    const text =
      event.type === "started"
        ? buildOutageStartedMessage(service, config.OUTAGE_ALERT_MINUTES)
        : buildOutageRecoveredMessage(service);
    await telegram.sendMessage(text);
  }

  // ---- Discovery loops (SPEC.md section 4) ----
  void runLoop("discovery-profiles", config.DISCOVERY_SECONDS * 1000, logger, signal, async () => {
    const result = await pollProfiles({
      dexClient,
      store: pendingStore,
      now: Date.now(),
      seenMintsCap: config.SEEN_MINTS_CAP,
      logger,
    });
    funnel.discovered += result.discovered;
    if (!result.ok) health.dexScreenerErrors++;
    await handleOutage("DexScreener", result.ok);
  });

  void runLoop("discovery-recheck", config.PENDING_RECHECK_SECONDS * 1000, logger, signal, async () => {
    const result = await recheckPending({
      dexClient,
      store: pendingStore,
      now: Date.now(),
      allowedQuoteMints: config.ALLOWED_QUOTE_MINTS,
      minLiquidityUsd: config.MIN_LIQUIDITY_USD,
      entryWindowMin: config.ENTRY_WINDOW_MIN,
      maxPendingAgeMin: config.MAX_PENDING_AGE_MIN,
      maxNoPairChecks: config.MAX_NO_PAIR_CHECKS,
      reentryEnabled: config.REENTRY_ENABLED,
      logger,
    });
    for (const [check, count] of Object.entries(result.skipReasons)) {
      const key = check as GateCheckId;
      funnel.skipReasons[key] = (funnel.skipReasons[key] ?? 0) + (count ?? 0);
    }
    health.dexScreenerErrors += result.failedBatches;
    await handleOutage("DexScreener", result.failedBatches === 0);
    heartbeat(stateStore, Date.now());
  });

  // ---- SOL/USD price (section 3) ----
  void runLoop("sol-price", 5 * 60 * 1000, logger, signal, async () => {
    await solPriceTracker.refresh();
  });

  // ---- Telegram commands (section 10) ----
  void runLoop("commands", 1000, logger, signal, async () => {
    const offset = stateStore.get<number>("telegramOffset", 0);
    const { nextOffset } = await pollAndHandleCommands({
      telegram,
      stateStore,
      offset,
      timeoutSec: 20,
      buildDigest: () => renderDigest(),
      logger,
    });
    if (nextOffset !== offset) stateStore.set("telegramOffset", nextOffset);
  });

  function renderDigest(): string {
    const input: Phase1DigestInput = {
      mode: config.MODE.toUpperCase() as "PAPER" | "LIVE",
      now: Date.now(),
      startedAt,
      paused: stateStore.get<boolean>(PAUSED_KEY, false),
      ...(stateStore.get<string | null>(PAUSE_REASON_KEY, null)
        ? { pauseReason: stateStore.get<string | null>(PAUSE_REASON_KEY, null) as string }
        : {}),
      solPriceUsd: solPriceTracker.get().priceUsd,
      funnel: { discovered: funnel.discovered, pendingNow: pendingStore.countPending(), skipReasons: funnel.skipReasons },
      health: {
        dexScreenerErrors: health.dexScreenerErrors,
        rpcErrors: health.rpcErrors,
        jupiterRequestsPerMinAvg: 0,
        jupiterRequestsPerMinPeak: 0,
        jupiter429s: health.jupiter429s,
        deferredEntryChecks: 0,
        downtimeGaps: health.downtimeGaps,
      },
    };
    return buildDigest(input);
  }

  // ---- Digest (section 10), sent even if nothing happened (doubles as a heartbeat) ----
  void runLoop("digest", config.DIGEST_INTERVAL_MINUTES * 60 * 1000, logger, signal, async () => {
    await telegram.sendMessage(renderDigest());
    funnel.discovered = 0;
    funnel.skipReasons = {};
    health.downtimeGaps = [];
  });

  logger.info("Trader running (Phase 1: discovery only, no trading decisions)", {
    mode: config.MODE,
    pollSeconds: config.jupiter.effectivePollSeconds,
  });

  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve());
  });
  db.close();
  logger.info("Shutdown complete");
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
