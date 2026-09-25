import fs from "node:fs";
import path from "node:path";

import { DexScreenerClient, selectAllValidPairs, selectPair } from "./clients/dexscreener.js";
import { JupiterClient } from "./clients/jupiter.js";
import { SolanaRpcClient } from "./clients/rpc.js";
import { TelegramClient } from "./clients/telegram.js";
import { ConfigError, KNOWN_ENV_KEYS, loadConfig, unknownKeys, type Config } from "./config/index.js";
import { BASE_FEE_LAMPORTS } from "./config/validate.js";
import { loadEnv } from "./config/loadEnv.js";
import { SOLANA_CHAIN_ID, USDC_DECIMALS, USDC_MINT, WRAPPED_SOL_MINT } from "./constants.js";
import { pollProfiles, recheckPending, type Phase2GateDeps } from "./discovery/index.js";
import { PendingStore } from "./discovery/pendingStore.js";
import {
  evaluateHolders,
  evaluateMintSafety,
  parseMintAccountInfo,
  type GateCheckId,
  type HoldersResult,
} from "./gate/index.js";
import { JupiterLaneBudget } from "./limiters/jupiterBudget.js";
import { sleep as sleepMs } from "./limiters/clock.js";
import { SlidingWindowLimiter } from "./limiters/slidingWindow.js";
import { createLogger, type Logger, type LogLevel } from "./logger/index.js";
import { pollOpenPositions, triggerFireAndForget, type PollPositionInput } from "./monitor/index.js";
import { finalPeakPnl, initialExitState, type ExitState, type ExitStateMachineConfig } from "./monitor/stateMachine.js";
import { logStopConfirm, stopCloseFields } from "./monitor/stopConfirm.js";
import {
  CONSECUTIVE_ERRORS_KEY,
  KILLED_VIA_COMMAND_KEY,
  PAUSED_KEY,
  PAUSE_REASON_KEY,
  pollAndHandleCommands,
} from "./notify/commands.js";
import { buildDigest, type DigestInput } from "./notify/digest.js";
import { detectStartup, heartbeat } from "./notify/lifecycle.js";
import { OutageTracker } from "./notify/outageTracker.js";
import {
  buildErrorHaltMessage,
  buildKillSwitchMessage,
  buildOutageRecoveredMessage,
  buildOutageStartedMessage,
  buildStartupMessage,
  buildStuckSellMessage,
} from "./notify/urgent.js";
import { computeTotals, formatReport, type TradeRecord } from "./report/index.js";
import {
  checkEntryBlockers,
  checkKillSwitch,
  perModeKey,
  realizedNetPnlForDay,
  applyTradeToLossStreak,
  unrealizedLossForMode,
  updateDailyLossHalt,
  type EntryBlockerState,
} from "./risk/index.js";
import { LaneLimiter } from "./limiters/laneLimiter.js";
import { IntentsStore } from "./storage/intents.js";
import { FeeLossesStore } from "./storage/feeLosses.js";
import { modeSwitchRefusal } from "./startup/modeGuard.js";
import { instanceGuardRefusal, markCleanShutdown, readHeartbeatState } from "./startup/instanceGuard.js";
import type { TradeExecutor } from "./executor/types.js";
import type { PositionRow } from "./storage/positions.js";
import type { TradeLiveFields } from "./storage/trades.js";
import { ShutdownCoordinator } from "./shutdown.js";
import { goLiveChecklist } from "./report/index.js";
import { computePositionSizeUsd, pickNextCandidate, runSlotFilling, type EntryExecution, type ReadyCandidate, type SellabilityMeasurement } from "./selection/index.js";
import { computeScore } from "./selection/score.js";
import { SolPriceTracker } from "./solPrice/index.js";
import { openDb } from "./storage/db.js";
import { logEvent } from "./storage/events.js";
import { positionRowToExitState, PositionsStore } from "./storage/positions.js";
import { SafetyCacheStore } from "./storage/safetyCache.js";
import { ShadowsStore, shadowRowToExitState } from "./storage/shadows.js";
import { PostExitTracksStore } from "./storage/postExitTracks.js";
import { SkipTracksStore } from "./storage/skipTracks.js";
import { StateStore } from "./storage/state.js";
import { TradesStore } from "./storage/trades.js";
import { tradeFromPosition } from "./storage/tradeFromPosition.js";
import { TradeHistoryStore } from "./storage/tradeHistory.js";
import { paperEntryFill, paperExitFill, shouldWriteOff } from "./executor/paper.js";
import { shadowEntry, shadowStep, shadowValue } from "./tracking/shadows.js";
import { dueOffsetMinutes as skipDueOffset, isSkipTrackResolved } from "./tracking/skipTracking.js";
import { dueOffsetMinutes as postExitDueOffset, isPostExitTrackResolved } from "./tracking/postExit.js";
import { tradingDayKey } from "./time.js";
import { VirtualWallet } from "./wallet/index.js";
import type { DexPair } from "./types.js";

const cwd = process.cwd();
const DB_PATH = path.join(cwd, "trader.db");
const LOG_DIR = path.join(cwd, "logs");
const KILL_PATH = path.join(cwd, "KILL");

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runLoop(
  name: string,
  intervalMs: number,
  logger: Logger,
  signal: AbortSignal,
  fn: () => Promise<void>,
  opts: { immediate?: boolean } = {},
): Promise<void> {
  // The digest loop passes immediate: false so its first send waits a full
  // DIGEST_INTERVAL_MINUTES instead of firing at t=0, which used to race the
  // very first discovery poll and zero out funnel.discovered before a real
  // window had elapsed.
  if (opts.immediate === false) {
    await sleep(intervalMs, signal);
  }
  while (!signal.aborted) {
    try {
      await fn();
    } catch (err) {
      logger.error(`${name} loop iteration failed`, { error: String(err) });
    }
    await sleep(intervalMs, signal);
  }
}

interface FunnelCounters {
  discovered: number;
  eligible: number;
  ready: number;
  entered: number;
  skippedSlotsFull: number;
  scoreRangeOfEntries: { min: number; max: number } | null;
  /** Per-reason set of mint addresses skipped since the last digest, so a mint re-evaluated every recheck cycle counts once, not once per evaluation. */
  skipReasonMints: Partial<Record<GateCheckId, Set<string>>>;
}

function emptyFunnelCounters(): FunnelCounters {
  return { discovered: 0, eligible: 0, ready: 0, entered: 0, skippedSlotsFull: 0, scoreRangeOfEntries: null, skipReasonMints: {} };
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

const KILL_SWITCH_WAS_ACTIVE_KEY = "killSwitchWasActive";
/** SPEC.md section 16.11: the shutdown wait bound (pm2 kill_timeout is 150 s, above it). */
const SHUTDOWN_WAIT_MS = 120_000;

/**
 * Scrubs secrets (the wallet key in every encoding, in live mode) from
 * anything printed outside the logger: fatal errors and uncaught exceptions
 * (SPEC.md section 16.9). Replaced by the logger's scrubber once it exists.
 */
let scrubFatal: (text: string) => string = (t) => t;

async function main(): Promise<void> {
  // SPEC.md section 16.8: before anything else (no config, no logs, no migrations), refuse to
  // start if another instance may already be running against this folder's database.
  const instanceRefusal = instanceGuardRefusal(readHeartbeatState(DB_PATH), Date.now());
  if (instanceRefusal) {
    console.error(instanceRefusal);
    process.exit(1);
  }

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

  // Live mode only: load the live module (dynamically, so paper mode never loads it)
  // and register every encoding of the wallet key for redaction BEFORE the first log line.
  const liveModule = config.MODE === "live" ? await import("./live/runtime.js") : null;
  const redactions = liveModule ? liveModule.walletKeyRedactions(env) : undefined;

  fs.mkdirSync(LOG_DIR, { recursive: true });
  // config.LOG_LEVEL is runtime-validated against this exact set by the zod enum in schema.ts.
  const logger = createLogger({ level: config.LOG_LEVEL as LogLevel, secrets: config.secrets, logDir: LOG_DIR, ...(redactions ? { redactions } : {}) });
  scrubFatal = logger.scrubText;
  const mode = config.MODE;
  const DAILY_LOSS_HALT_DAY_KEY = perModeKey("dailyLossHaltDay", mode);
  const LOSS_STREAK_KEY = perModeKey("lossStreak", mode);
  const LOSS_PAUSE_UNTIL_KEY = perModeKey("lossPauseUntil", mode);

  for (const key of unknownKeys(fileKeys, KNOWN_ENV_KEYS)) {
    logger.warn(`Unknown key in .env, ignored: ${key}`);
  }
  if (config.jupiter.stretched) {
    logger.warn(`POLL_SECONDS auto-stretched to ${config.jupiter.effectivePollSeconds} to fit the Jupiter budget (AUTO_STRETCH_POLL=true)`);
  }

  const db = openDb(DB_PATH);
  const stateStore = new StateStore(db);
  const pendingStore = new PendingStore(db);
  const positionsStore = new PositionsStore(db);
  const tradesStore = new TradesStore(db);
  const tradeHistoryStore = new TradeHistoryStore(db);
  const shadowsStore = new ShadowsStore(db);
  const skipTracksStore = new SkipTracksStore(db);
  const postExitTracksStore = new PostExitTracksStore(db);
  const safetyCacheStore = new SafetyCacheStore(db);
  const intentsStore = new IntentsStore(db);
  const feeLossesStore = new FeeLossesStore(db);

  // SPEC.md section 16.8: refuse to start while positions or unresolved intents of the other mode exist.
  const refusal = modeSwitchRefusal(mode, positionsStore.listAllActive(), intentsStore.listUnresolved());
  if (refusal) {
    logger.fatal(refusal);
    console.error(refusal);
    db.close();
    process.exit(1);
  }

  const dexProfilesLimiter = new SlidingWindowLimiter(config.DEX_PROFILES_MAX_PER_MIN, 60_000);
  const dexPairsLimiter = new SlidingWindowLimiter(config.DEX_PAIRS_MAX_PER_MIN, 60_000);
  // Section 16.10: one RPC_MAX_RPS window, transaction lane served before the read lane.
  const rpcLanes = new LaneLimiter(config.RPC_MAX_RPS, 1_000);
  const rpcLimiter = rpcLanes.lane("read");
  const jupiterPhysicalLimiter = new SlidingWindowLimiter(config.JUPITER_MAX_REQ_PER_MIN, 60_000, config.JUPITER_MIN_INTERVAL_MS);
  const jupiterLaneBudget = new JupiterLaneBudget({
    jupiterMaxReqPerMin: config.JUPITER_MAX_REQ_PER_MIN,
    exitReserve: config.jupiter.exitReserve,
  });

  const dexClient = new DexScreenerClient({ profilesLimiter: dexProfilesLimiter, pairsLimiter: dexPairsLimiter, logger });
  const rpcClient = new SolanaRpcClient({ url: config.SOLANA_RPC_URL, limiter: rpcLimiter, logger });
  const jupiterClient = new JupiterClient({ apiKey: config.JUPITER_API_KEY, physicalLimiter: jupiterPhysicalLimiter, logger });
  const telegram = new TelegramClient({ botToken: config.TRADER_TELEGRAM_BOT_TOKEN, chatId: config.TRADER_TELEGRAM_CHAT_ID, logger, scrubText: logger.scrubText });

  const wallet = new VirtualWallet(stateStore, { usdc: config.PAPER_STARTING_USDC, sol: config.PAPER_STARTING_SOL });

  const quoteMintsForSol = config.ALLOWED_QUOTE_MINTS.filter((m) => m !== WRAPPED_SOL_MINT);
  const solPriceTracker = new SolPriceTracker(dexClient, quoteMintsForSol, logger);

  const dexOutage = new OutageTracker(config.OUTAGE_ALERT_MINUTES);
  const startedAt = Date.now();
  const funnel = emptyFunnelCounters();
  const health = emptyHealthCounters();

  const exitCfg: ExitStateMachineConfig = {
    stopLossPct: config.STOP_LOSS_PCT,
    extraTargetPct: config.EXTRA_TARGET_PCT,
    maxTargetExtensions: config.MAX_TARGET_EXTENSIONS,
    holdMinutes: config.HOLD_MINUTES,
    fastGainPct: config.FAST_GAIN_PCT,
    fastWindowMinutes: config.FAST_WINDOW_MINUTES,
    fastMinHistorySec: config.FAST_MIN_HISTORY_SEC,
    fastConfirmPolls: config.FAST_CONFIRM_POLLS,
    maxTimerRestarts: config.MAX_TIMER_RESTARTS,
    maxTotalHoldMinutes: config.MAX_TOTAL_HOLD_MINUTES,
    trailPct: config.TRAIL_PCT,
    breakevenTriggerPct: config.BREAKEVEN_TRIGGER_PCT,
    breakevenFloorPct: config.BREAKEVEN_FLOOR_PCT,
    flatBandPct: config.FLAT_BAND_PCT,
    liqDropExitPct: config.LIQ_DROP_EXIT_PCT,
    liqDropConfirmReads: config.LIQ_DROP_CONFIRM_READS,
    noRouteExitSec: config.NO_ROUTE_EXIT_SEC,
  };
  const paperFillCfg = { latencySec: config.PAPER_LATENCY_SEC, extraSlippagePct: config.PAPER_EXTRA_SLIPPAGE_PCT, feeUsdPerTx: config.PAPER_FEE_USD_PER_TX };

  // ---- In-memory caches / trackers (short-lived; a restart naturally invalidates them) ----
  const mintDecimalsCache = new Map<string, number>();
  const holdersCache = new Map<string, { result: HoldersResult; expiresAt: number }>();
  /** Keyed by `${mint}|${sizeUsd}`: a round-trip loss measured at one size is never reused for another. */
  const sellabilityCache = new Map<string, { result: SellabilityMeasurement; expiresAt: number }>();
  const sellabilityCacheKey = (mint: string, sizeUsd: number) => `${mint}|${sizeUsd}`;
  const inFlightEntries = new Set<string>();
  const inFlightExitFills = new Set<number>();
  const pendingLiquidityReadings = new Map<string, number>();
  const lastValueUsdByPosition = new Map<number, number>();

  // SPEC.md section 9.1: "MAX_CONSECUTIVE_ERRORS consecutive failed entries or
  // unhandled loop errors" halts entries until /resume. Every fire-and-forget
  // fill attempt (entry or exit) below funnels its unexpected exceptions here
  // so none of them can become an unhandled promise rejection.
  function incrementConsecutiveErrors(context: string, err: unknown): void {
    const n = stateStore.get<number>(CONSECUTIVE_ERRORS_KEY, 0) + 1;
    stateStore.set(CONSECUTIVE_ERRORS_KEY, n);
    logger.error(`${context} failed unexpectedly`, { error: String(err), consecutiveErrors: n });
    if (n === config.MAX_CONSECUTIVE_ERRORS && config.URGENT_ALERTS) {
      void telegram.sendMessage(buildErrorHaltMessage({ consecutiveErrors: n }));
    }
  }
  function resetConsecutiveErrors(): void {
    if (stateStore.get<number>(CONSECUTIVE_ERRORS_KEY, 0) !== 0) stateStore.set(CONSECUTIVE_ERRORS_KEY, 0);
  }

  async function acquireEntryLane(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!jupiterLaneBudget.canEnterNow()) {
      if (Date.now() >= deadline) {
        jupiterLaneBudget.recordDeferredEntry();
        return;
      }
      await sleepMs(250);
    }
    jupiterLaneBudget.recordEntry();
  }

  // ---- Checks 7-8 (RPC-backed, cached) ----
  async function getMintSafety(mint: string) {
    const cached = safetyCacheStore.get(mint);
    if (cached) return cached;
    let info: unknown = null;
    try {
      info = await rpcClient.getAccountInfo(mint);
      health.rpcErrors += 0;
    } catch (err) {
      health.rpcErrors++;
      logger.warn("getAccountInfo failed for mint safety check", { mint, error: String(err) });
      return { passed: false, reason: "RPC error fetching mint account" };
    }
    const value = (info as { value?: unknown })?.value ?? info;
    const parsed = parseMintAccountInfo(value);
    const result = evaluateMintSafety(parsed, {
      requireMintRevoked: config.REQUIRE_MINT_REVOKED,
      requireFreezeRevoked: config.REQUIRE_FREEZE_REVOKED,
      allowedToken2022Extensions: ["metadataPointer", "tokenMetadata", "groupPointer", "groupMemberPointer", "tokenGroup", "tokenGroupMember"],
    });
    safetyCacheStore.set(mint, result, Date.now());
    // Phase 3: remember the mint's owning token program and decimals (closeAccount uses the mint's own program, section 16.6).
    const v = value as { owner?: unknown; data?: { parsed?: { info?: { decimals?: unknown } } } } | null;
    if (typeof v?.owner === "string" && typeof v.data?.parsed?.info?.decimals === "number") {
      safetyCacheStore.setMintInfo(mint, { tokenProgram: v.owner, decimals: v.data.parsed.info.decimals });
    }
    return result;
  }

  async function getHolders(mint: string, validPairs: readonly DexPair[]): Promise<HoldersResult> {
    const now = Date.now();
    const cached = holdersCache.get(mint);
    if (cached && cached.expiresAt > now) return cached.result;
    try {
      const [largestRaw, supplyRaw] = await Promise.all([rpcClient.getTokenLargestAccounts(mint), rpcClient.getTokenSupply(mint)]);
      const largest = ((largestRaw as { value?: unknown })?.value ?? []) as Array<{ address: string; uiAmount: number | null }>;
      const supply = (supplyRaw as { value?: { uiAmount?: number | null; decimals?: number } })?.value;
      if (typeof supply?.decimals === "number") mintDecimalsCache.set(mint, supply.decimals);
      const result = evaluateHolders(largest, supply?.uiAmount ?? 0, validPairs, {
        maxTop1Pct: config.MAX_TOP1_PCT,
        maxTop10Pct: config.MAX_TOP10_PCT,
        poolVaultTolerancePct: 2,
        burnAddresses: ["1nc1nerator11111111111111111111111111111111", "11111111111111111111111111111111111111111"],
      });
      holdersCache.set(mint, { result, expiresAt: now + config.HOLDERS_CACHE_MIN * 60_000 });
      return result;
    } catch (err) {
      health.rpcErrors++;
      logger.warn("Holders check RPC call failed", { mint, error: String(err) });
      return { passed: false, reason: "RPC error fetching holders", top1Pct: 0, top10Pct: 0 };
    }
  }

  function computeSnapshot(row: { firstEligibleAt: number | null }, pair: DexPair, holders: HoldersResult) {
    const now = Date.now();
    const minutesSinceEligible = row.firstEligibleAt !== null ? (now - row.firstEligibleAt) / 60_000 : 0;
    const { score, components } = computeScore(
      {
        buysM5: pair.txns?.m5?.buys ?? 0,
        sellsM5: pair.txns?.m5?.sells ?? 0,
        volumeM5: pair.volume?.m5 ?? 0,
        liquidityUsd: pair.liquidity?.usd ?? 0,
        m5ChangePct: pair.priceChange?.m5 ?? 0,
        h1ChangePct: pair.priceChange?.h1 ?? 0,
        top10Pct: holders.top10Pct,
        minutesSinceEligible,
      },
      {
        weights: {
          buyPressure: config.W_BUY_PRESSURE,
          activity: config.W_ACTIVITY,
          momentum: config.W_MOMENTUM,
          depth: config.W_DEPTH,
          holders: config.W_HOLDERS,
          freshness: config.W_FRESHNESS,
        },
        activityCap: config.ACTIVITY_CAP,
        momentumCapPct: config.MOMENTUM_CAP_PCT,
        minLiquidityUsd: config.MIN_LIQUIDITY_USD,
        depthCapUsd: config.DEPTH_CAP_USD,
        maxTop10Pct: config.MAX_TOP10_PCT,
        entryWindowMin: config.ENTRY_WINDOW_MIN,
      },
    );
    return { score, snapshotJson: JSON.stringify({ pair, holders, score, components }) };
  }

  let shadowsSkippedForCap = 0;

  function onNewlyReady(mint: string, pair: DexPair): void {
    if (!config.SHADOW_ENABLED) return;
    if (shadowsStore.countOpen() >= config.SHADOW_MAX_OPEN) {
      shadowsSkippedForCap++;
      return;
    }
    const priceUsd = Number(pair.priceUsd ?? "0");
    const liquidityUsd = pair.liquidity?.usd ?? 0;
    if (priceUsd <= 0 || liquidityUsd <= 0) return;
    const sizeUsd = computePositionSizeUsd(config.POSITION_USD, liquidityUsd, config.MAX_POSITION_PCT_OF_LIQ);
    const shadowCfg = { poolFeePct: config.SHADOW_POOL_FEE_PCT, extraSlippagePct: config.PAPER_EXTRA_SLIPPAGE_PCT, feeUsdPerTx: config.PAPER_FEE_USD_PER_TX };
    const entry = shadowEntry(sizeUsd, priceUsd, liquidityUsd, shadowCfg);
    const now = Date.now();
    shadowsStore.insert({
      mint,
      symbol: pair.baseToken.symbol ?? null,
      pairAddress: pair.pairAddress,
      outcome: "open",
      mode: config.MODE,
      entryTime: now,
      costBasis: entry.costBasis,
      tokenAmount: entry.tokens,
      entryLiquidityUsd: liquidityUsd,
      entryPriceUsd: entry.entryPrice,
      score: null,
      scoreComponents: null,
      peakPnl: 0,
      currentTarget: config.TARGET_PROFIT_PCT,
      targetExtensions: 0,
      timerRestarts: 0,
      lastRestartAt: null,
      deadline: now + config.HOLD_MINUTES * 60_000,
      trailArmed: false,
      fastStreak: 0,
      lowLiqStreak: 0,
      noRouteSince: null,
      exitTime: null,
      exitReason: null,
      proceeds: null,
      netPnlUsd: null,
      netPnlPct: null,
    });
  }

  const phase2GateDeps: Phase2GateDeps = {
    momentumBuyPressureCfg: {
      minM5ChangePct: config.MIN_M5_CHANGE_PCT,
      minH1ChangePct: config.MIN_H1_CHANGE_PCT,
      minH24ChangePct: config.MIN_H24_CHANGE_PCT,
      maxH1ChangePct: config.MAX_H1_CHANGE_PCT,
      minM5Txns: config.MIN_M5_TXNS,
      minM5BuySellRatio: config.MIN_M5_BUY_SELL_RATIO,
      minM5VolumeUsd: config.MIN_M5_VOLUME_USD,
    },
    getMintSafety,
    getHolders,
    computeSnapshot,
    onNewlyReady,
  };

  const startup = detectStartup(stateStore, startedAt);
  heartbeat(stateStore, startedAt);
  if (config.URGENT_ALERTS) {
    await telegram.sendMessage(
      buildStartupMessage({ mode: config.MODE.toUpperCase(), isRestart: startup.isRestart, downtimeMs: startup.downtimeMs }),
    );
  }
  logger.info(startup.isRestart ? "Restarted" : "Started", { downtimeMs: startup.downtimeMs });
  logEvent(
    db,
    startedAt,
    startup.isRestart ? "restart" : "startup",
    startup.isRestart ? `Restarted after ${startup.downtimeMs}ms downtime` : "Started",
    { downtimeMs: startup.downtimeMs },
  );

  const controller = new AbortController();
  const { signal } = controller;

  // ---- In-flight paper fills, awaited by graceful shutdown (section 16.11) ----
  const inFlightWork = new Set<Promise<unknown>>();
  function trackWork<T>(p: Promise<T>): Promise<T> {
    inFlightWork.add(p);
    void p.finally(() => inFlightWork.delete(p)).catch(() => undefined);
    return p;
  }
  let shuttingDown = false;

  // ---- Live runtime (Phase 3): only when MODE=live (the module was loaded dynamically above) ----
  type LiveRuntimeT = Awaited<ReturnType<NonNullable<typeof liveModule>["createLiveRuntime"]>>;
  type LiveHooksT = Parameters<NonNullable<typeof liveModule>["createLiveRuntime"]>[0]["hooks"];
  const live: LiveRuntimeT | null = liveModule
    ? await liveModule.createLiveRuntime({
        config,
        env,
        logger,
        rpcLanes,
        jupiter: jupiterClient,
        intents: intentsStore,
        positions: positionsStore,
        feeLosses: feeLossesStore,
        safetyCache: safetyCacheStore,
        hooks: makeLiveHooks(),
      })
    : null;
  const executor: TradeExecutor = live ? makeLiveExecutor(live) : makePaperExecutor();

  const shutdown = new ShutdownCoordinator({
    source: process as unknown as import("./shutdown.js").ShutdownSource,
    logger,
    boundMs: SHUTDOWN_WAIT_MS,
    stopNew: () => {
      shuttingDown = true;
      live?.executor.stopNewTransactions();
      controller.abort();
    },
    waitForInFlight: async (boundMs) => {
      const deadline = Date.now() + boundMs;
      const liveDone = live ? await live.executor.waitIdle(boundMs) : true;
      while (inFlightWork.size > 0 && Date.now() < deadline) {
        await Promise.race([Promise.allSettled([...inFlightWork]), sleepMs(250)]);
      }
      return liveDone && inFlightWork.size === 0;
    },
    finalize: () => {
      const stoppedAt = Date.now();
      heartbeat(stateStore, stoppedAt);
      markCleanShutdown(stateStore, stoppedAt); // lets an immediate restart past the instance guard
      db.close();
    },
    exit: (code) => process.exit(code),
  });
  shutdown.install();

  if (live) {
    logger.info("Live mode: wallet loaded", { address: live.address, sellFeeReserveSol: config.sellFeeReserveSol });
    // Section 16.8: the paper go-live checklist informs, never blocks.
    const checklist = goLiveChecklist(tradeRowsToRecords("paper"), false, {
      minTrades: config.GOLIVE_MIN_TRADES,
      minDays: config.GOLIVE_MIN_DAYS,
      minMedianPnlPct: config.GOLIVE_MIN_MEDIAN_PNL_PCT,
      minTotalPnlUsd: config.GOLIVE_MIN_TOTAL_PNL_USD,
      minP10PnlPct: config.GOLIVE_MIN_P10_PNL_PCT,
    });
    const failed = checklist.filter((c) => !c.pass);
    if (failed.length > 0) {
      const text = `Live mode started while the paper go-live checklist is NOT met (continuing anyway): ${failed.map((c) => `${c.check} (${c.detail})`).join("; ")}`;
      logger.warn(text);
      await telegram.sendMessage(text);
    }
    // Section 16.5: resolve every unresolved intent, then reconcile, before any loop runs.
    await live.executor.startup();
    await live.executor.readWalletBalances().catch((err: unknown) => logger.warn("Initial wallet balance read failed", { error: String(err) }));
  }

  async function handleOutage(service: "DexScreener" | "RPC" | "Jupiter", success: boolean): Promise<void> {
    const event = dexOutage.recordResult(service, success, Date.now());
    if (!event) return;
    logEvent(db, Date.now(), "outage", `${service} ${event.type}`, { service, type: event.type });
    if (!config.URGENT_ALERTS) return;
    const text = event.type === "started" ? buildOutageStartedMessage(service, config.OUTAGE_ALERT_MINUTES) : buildOutageRecoveredMessage(service);
    await telegram.sendMessage(text);
  }

  // ---- Discovery loops (SPEC.md section 4) ----
  void runLoop("discovery-profiles", config.DISCOVERY_SECONDS * 1000, logger, signal, async () => {
    const result = await pollProfiles({ dexClient, store: pendingStore, now: Date.now(), seenMintsCap: config.SEEN_MINTS_CAP, logger });
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
      phase2: phase2GateDeps,
    });
    funnel.eligible += result.eligible;
    funnel.ready += result.ready;
    for (const [check, mints] of Object.entries(result.skippedMints)) {
      const key = check as GateCheckId;
      const set = funnel.skipReasonMints[key] ?? (funnel.skipReasonMints[key] = new Set());
      for (const mint of mints ?? []) set.add(mint);
    }
    health.dexScreenerErrors += result.failedBatches;
    await handleOutage("DexScreener", result.failedBatches === 0);
    heartbeat(stateStore, Date.now());

    const now = Date.now();
    if (config.SKIP_TRACK_MAX_PER_HOUR > 0) {
      for (const removed of result.removedNeverReady) {
        if (skipTracksStore.countInWindow(now - 3_600_000) >= config.SKIP_TRACK_MAX_PER_HOUR) break;
        skipTracksStore.insert({ mint: removed.mint, skipReason: removed.reason, discoveredAt: now, skippedAt: now, priceAtSkipUsd: null });
      }
    }

    await runSlotFillingNow();
  });

  // ---- SOL/USD price (section 3) ----
  void runLoop("sol-price", 5 * 60 * 1000, logger, signal, async () => {
    await solPriceTracker.refresh();
  });

  // ---- Slot filling (section 6.2): after every recheck, and right after every exit ----
  async function runSlotFillingNow(): Promise<void> {
    const now = Date.now();
    const readyRows = pendingStore.listReady();
    const candidates: ReadyCandidate[] = readyRows
      .filter((r) => r.snapshot !== null)
      .map((r) => {
        const snap = JSON.parse(r.snapshot!) as { score: number; pair: DexPair };
        return {
          mint: r.mint,
          score: snap.score,
          firstEligibleAt: r.firstEligibleAt ?? r.discoveredAt,
          liquidityUsd: snap.pair.liquidity?.usd ?? 0,
          priceUsd: Number(snap.pair.priceUsd ?? "0"),
          lastCheckedAt: r.lastCheckedAt ?? r.discoveredAt,
        };
      });

    await runSlotFilling({
      now,
      maxConcurrent: config.MAX_CONCURRENT,
      minScore: config.MIN_SCORE,
      pendingRecheckSeconds: config.PENDING_RECHECK_SECONDS,
      maxEntryDriftPct: config.MAX_ENTRY_DRIFT_PCT,
      candidates,
      openPositionsCount: positionsStore.listOpen().length,
      inFlight: inFlightEntries,
      getSellabilityCache: (mint, sizeUsd) => {
        const c = sellabilityCache.get(sellabilityCacheKey(mint, sizeUsd));
        if (!c || c.expiresAt <= now) return undefined;
        return c.result;
      },
      setSellabilityCache: (mint, sizeUsd, result) => sellabilityCache.set(sellabilityCacheKey(mint, sizeUsd), { result, expiresAt: now + 10 * 60_000 }),
      checkSellability: async (mint, sizeUsd) => {
        try {
          await acquireEntryLane();
          const usdcAmount = Math.round(sizeUsd * 10 ** USDC_DECIMALS).toString();
          const buyQuote = await jupiterClient.getQuote({ inputMint: USDC_MINT, outputMint: mint, amount: usdcAmount, slippageBps: config.BUY_SLIPPAGE_BPS });
          await acquireEntryLane();
          const sellQuote = await jupiterClient.getQuote({ inputMint: mint, outputMint: USDC_MINT, amount: buyQuote.outAmount, slippageBps: config.BUY_SLIPPAGE_BPS });
          const usdcBack = Number(sellQuote.outAmount) / 10 ** USDC_DECIMALS;
          return {
            passed: usdcBack >= (1 - config.MAX_ROUNDTRIP_LOSS_PCT / 100) * sizeUsd,
            roundTripLossPct: ((sizeUsd - usdcBack) / sizeUsd) * 100,
          };
        } catch (err) {
          logger.warn("Sellability check failed", { mint, error: String(err) });
          return { passed: false, roundTripLossPct: null };
        }
      },
      getExecutionQuote: (mint, sizeUsd) => executor.getExecutionQuote(mint, sizeUsd),
      positionSizeUsd: (c) => computePositionSizeUsd(config.POSITION_USD, c.liquidityUsd, config.MAX_POSITION_PCT_OF_LIQ),
      paperFeeUsdPerTx: executor.mode === "paper" ? config.PAPER_FEE_USD_PER_TX : 0,
      canAfford: (usdc) => executor.canAfford(usdc),
      openPosition: async (candidate, execution) => {
        try {
          await executor.open(candidate, execution);
          resetConsecutiveErrors();
        } catch (err) {
          incrementConsecutiveErrors(`Entry fill for ${candidate.mint}`, err);
          throw err; // runSlotFilling's own .catch still logs and releases the in-flight guard
        }
      },
      markUnsellable: (mint) => {
        pendingStore.removePending(mint);
        const shadow = shadowsStore.getOpenByMint(mint);
        if (shadow) shadowsStore.update(shadow.id, { outcome: "unsellable" });
      },
      entryBlocked: () => entryBlocked() !== null,
      logger,
    });
  }

  function entryBlocked(): string | null {
    const now = Date.now();
    const haltDay = updateDailyLossHalt(
      stateStore.get<string | null>(DAILY_LOSS_HALT_DAY_KEY, null),
      realizedNetPnlToday(now),
      unrealizedLossSum(),
      now,
      { maxDailyLossUsd: config.MAX_DAILY_LOSS_USD, tradingDayTz: config.TRADING_DAY_TZ },
    );
    stateStore.set(DAILY_LOSS_HALT_DAY_KEY, haltDay);

    const blockerState: EntryBlockerState = {
      killed: fs.existsSync(KILL_PATH) || stateStore.get<boolean>(KILLED_VIA_COMMAND_KEY, false),
      paused: stateStore.get<boolean>(PAUSED_KEY, false),
      dailyLossHaltDay: haltDay,
      pauseUntil: stateStore.get<number | null>(LOSS_PAUSE_UNTIL_KEY, null),
      consecutiveErrors: stateStore.get<number>(CONSECUTIVE_ERRORS_KEY, 0),
      openPositionsCount: positionsStore.listOpen().length,
    };
    const reason = checkEntryBlockers(blockerState, now, { maxConsecutiveErrors: config.MAX_CONSECUTIVE_ERRORS, maxConcurrent: config.MAX_CONCURRENT });
    if (reason === "slots_full") funnel.skippedSlotsFull++;
    return reason;
  }

  function unrealizedLossSum(): number {
    return unrealizedLossForMode(positionsStore.listOpen(), lastValueUsdByPosition, config.MODE);
  }

  function realizedNetPnlToday(now: number): number {
    const day = tradingDayKey(now, config.TRADING_DAY_TZ);
    // Section 9.1 (A12): realized trades of the current mode only, minus that mode's fee losses (section 16.3; none in paper mode).
    return realizedNetPnlForDay(tradesStore.listForTradingDay(day), feeLossesStore.listAll({ mode: config.MODE, from: day, to: day }), config.MODE, day);
  }

  async function paperExecutionQuote(mint: string, sizeUsd: number): Promise<{ tokensOut: number } | null> {
    try {
      await acquireEntryLane();
      const usdcAmount = Math.round(sizeUsd * 10 ** USDC_DECIMALS).toString();
      const quote = await jupiterClient.getQuote({ inputMint: USDC_MINT, outputMint: mint, amount: usdcAmount, slippageBps: config.BUY_SLIPPAGE_BPS });
      const decimals = mintDecimalsCache.get(mint) ?? 6;
      return { tokensOut: Number(quote.outAmount) / 10 ** decimals };
    } catch (err) {
      logger.warn("Execution quote failed", { mint, error: String(err) });
      return null;
    }
  }

  /** Paper mode (Phase 2 code, unchanged in behaviour) behind the TradeExecutor interface. */
  function makePaperExecutor(): TradeExecutor {
    return {
      mode: "paper",
      getExecutionQuote: paperExecutionQuote,
      canAfford: (usdc) => wallet.canAfford(usdc),
      open: (candidate, execution) => trackWork(openPosition(candidate, execution)),
      exitAttempt: (row) => trackWork(attemptExitFill(row)),
      exitQuoteAmountRaw: (row) => Math.round(row.tokenAmount * 10 ** (mintDecimalsCache.get(row.mint) ?? 6)).toString(),
      exitCostUsd: () => config.PAPER_FEE_USD_PER_TX,
      walletBalances: () => wallet.get(),
    };
  }

  /** Live mode (section 16) behind the same interface; the live module does the on-chain work. */
  function makeLiveExecutor(rt: LiveRuntimeT): TradeExecutor {
    return {
      mode: "live",
      getExecutionQuote: (mint, sizeUsd) => rt.executor.prepareBuy(mint, sizeUsd),
      canAfford: (usdc) => rt.executor.balances().usdc >= usdc,
      open: async (candidate, execution) => {
        if (shuttingDown) return;
        const readyRow = pendingStore.listReady().find((r) => r.mint === candidate.mint);
        await rt.executor.executeBuy({
          mint: candidate.mint,
          sizeUsd: execution.sizeUsd,
          score: candidate.score,
          liquidityUsd: candidate.liquidityUsd,
          snapshot: readyRow?.snapshot ? JSON.parse(readyRow.snapshot) : null,
          sellability: execution.sellability,
        });
      },
      exitAttempt: (row) => rt.executor.sellAttempt(row),
      exitQuoteAmountRaw: (row) => row.tokenAmountRaw ?? "0",
      exitCostUsd: (row) => rt.executor.exitCostUsd(row, solPriceTracker.get().priceUsd ?? row.entrySolPriceUsd ?? 0),
      walletBalances: () => rt.executor.balances(),
    };
  }

  /** The app side of the live executor: positions, trades, alerts, lanes (src/live/executor.ts LiveAppHooks). */
  function makeLiveHooks(): LiveHooksT {
    return {
      recordBuy: async (payload, fill, info) => {
        // Idempotent on the entry signature: a buy is never recorded twice (restart during apply).
        const existing = positionsStore.listAllActive().find((p) => p.entrySignature === info.signature);
        if (existing) return existing.id;
        const snap = payload.snapshot as { pair: DexPair; holders: HoldersResult; score: number; components: unknown } | null;
        const rentUsd = fill.rentUsd;
        const exitCost = (BASE_FEE_LAMPORTS + config.maxPriorityFeeLamports) / 1e9 * info.solPriceUsd - (config.CLOSE_EMPTY_ATA ? rentUsd : 0);
        return recordOpenedPosition(
          { mint: payload.mint, score: payload.score, liquidityUsd: payload.liquidityUsd },
          snap,
          {
            sizeUsd: payload.sizeUsd,
            tokens: Number(fill.tokensRaw) / 10 ** payload.decimals,
            costBasis: fill.costBasisUsd,
            tokenDecimals: payload.decimals,
            entryQuoteInAmount: info.quoteInAmount,
            entryQuoteOutAmount: info.quoteOutAmount,
            entryTime: info.entryTime,
            valuationAmountRaw: fill.tokensRaw.toString(),
            exitCostUsd: exitCost,
            sellability: payload.sellability ?? null,
            live: {
              tokenProgram: fill.tokenAccount?.program ?? payload.tokenProgram,
              tokenAccount: fill.tokenAccount?.address ?? null,
              tokenAmountRaw: fill.tokensRaw.toString(),
              entrySignature: info.signature,
              entryUsdcRaw: fill.usdcSpentRaw.toString(),
              entryFeeLamports: Number(fill.feeLamports),
              entryRentLamports: Number(fill.rentPaidLamports),
              entrySolPriceUsd: info.solPriceUsd,
            },
          },
        );
      },
      recordSell: async (row, fill, info) => {
        const entryFeeUsd = row.entryFeeLamports !== null && row.entrySolPriceUsd !== null ? (row.entryFeeLamports / 1e9) * row.entrySolPriceUsd : 0;
        const rentPaidUsd = row.entryRentLamports !== null && row.entrySolPriceUsd !== null ? (row.entryRentLamports / 1e9) * row.entrySolPriceUsd : 0;
        await finalizeTrade(
          row,
          fill.proceedsUsd,
          row.pendingExitReason ?? "time_exit",
          { exitQuoteInAmount: info.quoteInAmount, exitQuoteOutAmount: info.quoteOutAmount },
          {
            feesUsd: entryFeeUsd + fill.feeUsd,
            tradeLive: {
              ...entryTradeFields(row),
              exitSignature: info.signature,
              exitTokensRaw: fill.tokensSoldRaw.toString(),
              exitUsdcRaw: fill.usdcReceivedRaw.toString(),
              exitFeeLamports: Number(fill.feeLamports),
              exitFeeUsd: fill.feeUsd,
              rentPaidUsd,
              rentReclaimedLamports: Number(fill.rentReclaimedLamports),
              rentReclaimedUsd: fill.rentReclaimedUsd,
              exitSolPriceUsd: info.solPriceUsd,
              sellAttempts: info.sellAttempts,
              failedSellFeesLamports: row.failedSellFeesLamports,
              failedSellFeesUsd: (row.failedSellFeesLamports / 1e9) * info.solPriceUsd,
            },
          },
        );
      },
      closeReconciled: async (row) => {
        logger.warn("Position closed as reconciled: its tokens left the wallet without a recorded sell (proceeds recorded as 0, proceeds_unknown)", { positionId: row.id, mint: row.mint });
        await finalizeTrade(row, 0, "reconciled", { exitQuoteInAmount: null, exitQuoteOutAmount: null }, { proceedsUnknown: true, feesUsd: 0, tradeLive: entryTradeFields(row) });
      },
      alert: (text) => {
        logger.warn(`URGENT: ${text}`);
        logEvent(db, Date.now(), "urgent", text);
        if (config.URGENT_ALERTS) void telegram.sendMessage(text);
      },
      event: (type, message, meta) => logEvent(db, Date.now(), type, message, meta),
      solPriceUsd: () => solPriceTracker.get().priceUsd,
      acquireEntryLane: async () => {
        await acquireEntryLane();
        return true;
      },
      recordExitLane: () => jupiterLaneBudget.recordExit(),
    };
  }

  function entryTradeFields(row: PositionRow): Partial<TradeLiveFields> {
    return {
      entrySignature: row.entrySignature,
      entryUsdcRaw: row.entryUsdcRaw,
      entryTokensRaw: row.tokenAmountRaw,
      entryFeeLamports: row.entryFeeLamports,
      entryFeeUsd: row.entryFeeLamports !== null && row.entrySolPriceUsd !== null ? (row.entryFeeLamports / 1e9) * row.entrySolPriceUsd : null,
      rentPaidLamports: row.entryRentLamports,
      entrySolPriceUsd: row.entrySolPriceUsd,
    };
  }

  async function openPosition(candidate: ReadyCandidate, execution: EntryExecution): Promise<void> {
    const readyRow = pendingStore.listReady().find((r) => r.mint === candidate.mint);
    const snap = readyRow?.snapshot ? (JSON.parse(readyRow.snapshot) as { pair: DexPair; holders: HoldersResult; score: number; components: unknown }) : null;

    let entryQuoteInAmount: string | null = null;
    let entryQuoteOutAmount: string | null = null;
    const fill = await paperEntryFill(
      execution.sizeUsd,
      async () => {
        try {
          await acquireEntryLane();
          const usdcAmount = Math.round(execution.sizeUsd * 10 ** USDC_DECIMALS).toString();
          const quote = await jupiterClient.getQuote({ inputMint: USDC_MINT, outputMint: candidate.mint, amount: usdcAmount, slippageBps: config.BUY_SLIPPAGE_BPS });
          entryQuoteInAmount = quote.inAmount;
          entryQuoteOutAmount = quote.outAmount;
          const decimals = mintDecimalsCache.get(candidate.mint) ?? 6;
          return { tokensOut: Number(quote.outAmount) / 10 ** decimals };
        } catch {
          return null;
        }
      },
      paperFillCfg,
    );
    if (!fill) {
      logger.warn("Entry fill found no route; candidate skipped", { mint: candidate.mint });
      return;
    }
    if (!wallet.canAfford(fill.costBasis)) {
      logger.warn("Wallet balance changed during fill latency; entry aborted", { mint: candidate.mint });
      return;
    }
    wallet.debit(fill.costBasis);

    const tokenDecimals = mintDecimalsCache.get(candidate.mint) ?? null;
    await recordOpenedPosition(candidate, snap, {
      sizeUsd: execution.sizeUsd,
      tokens: fill.tokens,
      costBasis: fill.costBasis,
      tokenDecimals,
      entryQuoteInAmount,
      entryQuoteOutAmount,
      entryTime: Date.now(),
      valuationAmountRaw: Math.round(fill.tokens * 10 ** (tokenDecimals ?? 6)).toString(),
      exitCostUsd: config.PAPER_FEE_USD_PER_TX,
      sellability: execution.sellability,
    });
  }

  /**
   * Everything after an entry fill, shared by paper fills and confirmed live
   * buys (including buys recovered at startup, section 16.5): the entry-time
   * valuation (section 8.1), the position row, its first history point,
   * pending removal, shadow selection, and the funnel.
   */
  async function recordOpenedPosition(
    candidate: { mint: string; score: number; liquidityUsd: number },
    snap: { pair: DexPair; holders: HoldersResult; score: number; components: unknown } | null,
    fill: {
      sizeUsd: number;
      tokens: number;
      costBasis: number;
      tokenDecimals: number | null;
      entryQuoteInAmount: string | null;
      entryQuoteOutAmount: string | null;
      entryTime: number;
      /** Raw token amount quoted for the entry valuation. */
      valuationAmountRaw: string;
      exitCostUsd: number;
      /** The sellability check that admitted this entry; null for a recovered buy whose intent predates it. */
      sellability: { roundTripLossPct: number | null; checkedAt: number } | null;
      live?: Partial<import("./storage/positions.js").PositionLiveFields>;
    },
  ): Promise<number> {
    const execution = { sizeUsd: fill.sizeUsd };
    const { tokenDecimals, entryQuoteInAmount, entryQuoteOutAmount } = fill;
    const now = fill.entryTime;

    // The true entry-time mark (SPEC.md section 8.1): a just-opened position is typically
    // already below zero (round-trip fees, price impact, simulated slippage), never assumed
    // to be exactly 0%. Fetched via the exit lane, same as every later poll.
    let entryValuationPnlPct: number | null = null;
    try {
      const exitAmount = fill.valuationAmountRaw;
      jupiterLaneBudget.recordExit(Date.now()); // exit lane: never gated
      const exitQuote = await jupiterClient.getQuote({ inputMint: candidate.mint, outputMint: USDC_MINT, amount: exitAmount, slippageBps: 300 });
      const quoteOutUsd = Number(exitQuote.outAmount) / 10 ** USDC_DECIMALS;
      const valueUsd = quoteOutUsd - fill.exitCostUsd;
      entryValuationPnlPct = ((valueUsd - fill.costBasis) / fill.costBasis) * 100;
    } catch (err) {
      logger.warn("Entry valuation exit-lane quote failed; first history point deferred to the first regular poll", { mint: candidate.mint, error: String(err) });
    }

    const state = initialExitState({
      entryTime: now,
      entryLiquidity: candidate.liquidityUsd,
      targetProfitPct: config.TARGET_PROFIT_PCT,
      holdMinutes: config.HOLD_MINUTES,
      entryPnlPct: entryValuationPnlPct,
    });
    const entryValueUsd = entryValuationPnlPct !== null ? fill.costBasis * (1 + entryValuationPnlPct / 100) : fill.costBasis;
    const id = positionsStore.insert({
      mode: config.MODE,
      mint: candidate.mint,
      symbol: snap?.pair.baseToken.symbol ?? null,
      pairAddress: snap?.pair.pairAddress ?? null,
      status: "open",
      entryTime: now,
      sizeUsd: execution.sizeUsd,
      tokenAmount: fill.tokens,
      costBasis: fill.costBasis,
      entryLiquidityUsd: candidate.liquidityUsd,
      entryPairSnapshot: snap?.pair ?? null,
      score: candidate.score,
      scoreComponents: snap?.components ?? null,
      safetyResult: null,
      holdersResult: snap?.holders ?? null,
      peakPnl: state.peakPnl,
      currentTarget: state.currentTarget,
      targetExtensions: state.targetExtensions,
      timerRestarts: state.timerRestarts,
      lastRestartAt: state.lastRestartAt,
      deadline: state.deadline,
      trailArmed: state.trailArmed,
      fastStreak: state.fastStreak,
      lowLiqStreak: state.lowLiqStreak,
      noRouteSince: state.noRouteSince,
      closingSince: null,
      pendingExitReason: null,
      lastPnlPct: entryValuationPnlPct,
      lastValueUsd: entryValueUsd,
      lastPolledAt: now,
      tokenDecimals,
      entryValuationPnlPct,
      entryQuoteInAmount,
      entryQuoteOutAmount,
      sellabilityLossPct: fill.sellability?.roundTripLossPct ?? null,
      sellabilityCheckedAt: fill.sellability?.checkedAt ?? null,
      dexId: snap?.pair.dexId ?? null,
      ...(fill.live ?? {}),
    });
    if (state.history.length > 0) positionsStore.appendHistory(id, state.history[0]!);
    pendingStore.removePending(candidate.mint); // bought (section 4)

    const shadow = shadowsStore.getOpenByMint(candidate.mint);
    if (shadow) shadowsStore.update(shadow.id, { outcome: "selected" });

    funnel.entered++;
    funnel.scoreRangeOfEntries = funnel.scoreRangeOfEntries
      ? { min: Math.min(funnel.scoreRangeOfEntries.min, candidate.score), max: Math.max(funnel.scoreRangeOfEntries.max, candidate.score) }
      : { min: candidate.score, max: candidate.score };
    logEvent(db, Date.now(), "entry", `Opened ${candidate.mint}`, { mint: candidate.mint, sizeUsd: execution.sizeUsd, score: candidate.score });
    return id;
  }

  // ---- Monitoring loop (section 8.1) ----
  function persistExitState(
    id: number,
    state: ExitState,
    extra: Partial<{ status: "open" | "closing"; closingSince: number | null; pendingExitReason: string | null; stopPollPnlPct: number | null; stopConfirmPnlPct: number | null }> = {},
  ) {
    positionsStore.update(id, {
      peakPnl: state.peakPnl,
      currentTarget: state.currentTarget,
      targetExtensions: state.targetExtensions,
      timerRestarts: state.timerRestarts,
      lastRestartAt: state.lastRestartAt,
      deadline: state.deadline,
      trailArmed: state.trailArmed,
      fastStreak: state.fastStreak,
      lowLiqStreak: state.lowLiqStreak,
      noRouteSince: state.noRouteSince,
      lastPolledAt: Date.now(),
      ...extra,
    });
  }

  async function fetchExitQuote(row: PositionRow, now: number): Promise<number | null> {
    jupiterLaneBudget.recordExit(now); // exit lane: never gated
    try {
      // Paper: stored amount x decimals (Phase 2, unchanged). Live: the raw on-chain amount (section 8.1).
      const amount = executor.exitQuoteAmountRaw(row);
      const quote = await jupiterClient.getQuote({ inputMint: row.mint, outputMint: USDC_MINT, amount, slippageBps: 300 });
      const quoteOutUsd = Number(quote.outAmount) / 10 ** USDC_DECIMALS;
      lastValueUsdByPosition.set(row.id, quoteOutUsd - executor.exitCostUsd(row));
      return quoteOutUsd;
    } catch {
      return null;
    }
  }

  async function pollOpenPositionsTick(): Promise<void> {
    const now = Date.now();
    const rows = positionsStore.listOpen();
    const positions: PollPositionInput[] = rows.map((row) => {
      const history = positionsStore.loadHistory(row.id, now - 2 * config.FAST_WINDOW_MINUTES * 60_000);
      const state = positionRowToExitState(row, history.length > 0 ? history : [{ t: row.entryTime, pnl: 0 }]);
      const liquidityUsd = pendingLiquidityReadings.get(row.mint);
      return {
        id: row.id,
        state,
        ...(liquidityUsd !== undefined ? { liquidityUsd } : {}),
        fetchPnlPct: async (t: number) => {
          const quoteOutUsd = await fetchExitQuote(row, t);
          if (quoteOutUsd === null) return null;
          const valueUsd = quoteOutUsd - executor.exitCostUsd(row);
          return ((valueUsd - row.costBasis) / row.costBasis) * 100;
        },
      };
    });
    pendingLiquidityReadings.clear();

    await pollOpenPositions({
      positions,
      now,
      cfg: exitCfg,
      onHold: async (id, newState, logs) => {
        persistExitState(id, newState);
        const last = newState.history[newState.history.length - 1];
        if (last && last.t === now) positionsStore.appendHistory(id, last);
        const lastValue = lastValueUsdByPosition.get(id);
        if (lastValue !== undefined) {
          const row = rows.find((r) => r.id === id);
          if (row) positionsStore.update(id, { lastValueUsd: lastValue, lastPnlPct: ((lastValue - row.costBasis) / row.costBasis) * 100 });
        }
        for (const l of logs) logEvent(db, now, l, `${l} for position ${id}`);
      },
      onStopCheck: (id, check) => logStopConfirm(db, now, id, check),
      onSell: (id, reason, newState, stopCheck) => {
        // Marked "closing" (persisted) BEFORE the fill attempt is even kicked off below,
        // so the very next poll sees status='closing' and can never decide a second sell
        // for this position — pollOpenPositions only iterates positionsStore.listOpen().
        persistExitState(id, newState, { status: "closing", closingSince: now, pendingExitReason: reason, ...stopCloseFields(reason, stopCheck) });
        logEvent(db, now, "sell_decided", `Position ${id} decided SELL (${reason})`, { id, reason });
        const row = positionsStore.get(id);
        if (row) triggerExitFillAttempt(row);
      },
      logger,
    });
  }

  /**
   * One exit-fill attempt for a closing position: fetch a fresh sell quote
   * (after PAPER_LATENCY_SEC), finalize the trade on success, or write off
   * once STUCK_WRITE_OFF_MIN has elapsed with no route. Any exception here
   * (a real bug, not the handled "no route" case) propagates to the caller —
   * triggerExitFillAttempt is what turns that into a logged, counted, non-crashing outcome.
   */
  async function attemptExitFill(row: ReturnType<PositionsStore["listClosing"]>[number]): Promise<void> {
    let exitQuoteInAmount: string | null = null;
    let exitQuoteOutAmount: string | null = null;
    const fill = await paperExitFill(
      async () => {
        try {
          const decimals = row.tokenDecimals ?? mintDecimalsCache.get(row.mint) ?? 6;
          const amount = Math.round(row.tokenAmount * 10 ** decimals).toString();
          jupiterLaneBudget.recordExit(Date.now());
          const quote = await jupiterClient.getQuote({ inputMint: row.mint, outputMint: USDC_MINT, amount, slippageBps: 300 });
          exitQuoteInAmount = quote.inAmount;
          exitQuoteOutAmount = quote.outAmount;
          return { usdcOut: Number(quote.outAmount) / 10 ** USDC_DECIMALS };
        } catch {
          return null; // no route this attempt; not an error — retried by the next trigger
        }
      },
      paperFillCfg,
    );

    if (fill) {
      await finalizeTrade(row, fill.proceeds, row.pendingExitReason ?? "time_exit", { exitQuoteInAmount, exitQuoteOutAmount });
      return;
    }

    const now = Date.now();
    if (shouldWriteOff(row.closingSince ?? now, now, config.STUCK_WRITE_OFF_MIN)) {
      if (config.URGENT_ALERTS) {
        await telegram.sendMessage(buildStuckSellMessage({ mint: row.mint, ...(row.symbol ? { symbol: row.symbol } : {}), reason: "written_off" }));
      }
      await finalizeTrade(row, 0, "written_off", { exitQuoteInAmount: null, exitQuoteOutAmount: null });
    }
    // else: still closing, no route yet — retried by the next pollClosingPositionsTick sweep.
  }

  /**
   * Fires an exit-fill attempt WITHOUT awaiting it (mirrors the entry-side
   * fire-and-forget in runSlotFilling): a slow fill (its PAPER_LATENCY_SEC
   * wait) never blocks polling other positions or the next monitor tick.
   * Every such promise has a .catch that logs the failure and counts it
   * toward the error halt (section 9.1), so it can never become an unhandled
   * rejection, and a .finally that always releases the in-flight guard.
   */
  function triggerExitFillAttempt(row: ReturnType<PositionsStore["listClosing"]>[number]): void {
    triggerFireAndForget({
      id: row.id,
      inFlight: inFlightExitFills,
      attempt: () => (shuttingDown ? Promise.resolve() : executor.exitAttempt(row)),
      onError: (id, err) => incrementConsecutiveErrors(`Exit fill for position ${id} (${row.mint})`, err),
    });
  }

  /** Retries any closing position that doesn't already have an in-flight attempt (a restart, or a prior no-route attempt). Returns as soon as attempts are kicked off, not when they finish. */
  async function pollClosingPositionsTick(): Promise<void> {
    const rows = positionsStore.listClosing().filter((r) => !inFlightExitFills.has(r.id));
    for (const row of rows) triggerExitFillAttempt(row);
  }

  async function finalizeTrade(
    row: ReturnType<PositionsStore["listClosing"]>[number],
    proceeds: number,
    exitReason: string,
    exitQuote: { exitQuoteInAmount: string | null; exitQuoteOutAmount: string | null },
    extras: { feesUsd?: number; proceedsUnknown?: boolean; tradeLive?: Partial<TradeLiveFields> } = {},
  ): Promise<void> {
    const now = Date.now();
    if (row.mode === "paper") wallet.credit(proceeds); // live proceeds are on-chain already
    const netPnlUsd = proceeds - row.costBasis;
    const netPnlPct = (netPnlUsd / row.costBasis) * 100;
    const tradingDay = tradingDayKey(now, config.TRADING_DAY_TZ);

    const entrySnapshot = row.entryPairSnapshot as DexPair | null;
    const tradeId = tradesStore.insert(
      tradeFromPosition({ row, proceeds, exitReason, exitTime: now, tradingDay, exitQuote, defaultFeesUsd: config.PAPER_FEE_USD_PER_TX * 2, extras }),
    );

    // Preserve position_history past the close (SPEC.md sections 11.1/12) — copied, not
    // deleted, before positionsStore.remove() deletes the live position_history rows.
    const history = positionsStore.loadHistory(row.id, 0);
    if (history.length > 0) tradeHistoryStore.insertMany(tradeId, history);

    positionsStore.remove(row.id);
    lastValueUsdByPosition.delete(row.id);

    const streak = applyTradeToLossStreak(
      { consecutiveLosses: stateStore.get<number>(LOSS_STREAK_KEY, 0), pauseUntil: stateStore.get<number | null>(LOSS_PAUSE_UNTIL_KEY, null) },
      { netPnlUsd, proceedsUnknown: extras.proceedsUnknown ?? false },
      now,
      { consecutiveLossPause: config.CONSECUTIVE_LOSS_PAUSE, lossPauseMinutes: config.LOSS_PAUSE_MINUTES },
    );
    stateStore.set(LOSS_STREAK_KEY, streak.consecutiveLosses);
    stateStore.set(LOSS_PAUSE_UNTIL_KEY, streak.pauseUntil);

    if (config.POST_EXIT_TRACK) {
      postExitTracksStore.insert({ tradeId, mint: row.mint, exitTime: now, exitPriceUsd: entrySnapshot ? Number(entrySnapshot.priceUsd ?? "0") : null });
    }

    logEvent(db, now, "exit", `Closed ${row.mint} (${exitReason})`, { mint: row.mint, exitReason, netPnlUsd });
    await runSlotFillingNow(); // section 8.4: slot filling runs right after every exit
  }

  // ---- Kill switch (section 9.2): its own timer, independent of entry attempts ----
  void runLoop("kill-switch", config.jupiter.effectivePollSeconds * 1000, logger, signal, async () => {
    const now = Date.now();
    const fileExists = fs.existsSync(KILL_PATH);
    const flagSet = stateStore.get<boolean>(KILLED_VIA_COMMAND_KEY, false);
    const wasActive = stateStore.get<boolean>(KILL_SWITCH_WAS_ACTIVE_KEY, false);
    const result = checkKillSwitch(wasActive, fileExists, flagSet);
    stateStore.set(KILL_SWITCH_WAS_ACTIVE_KEY, result.active);
    if (!result.active) return;

    const open = positionsStore.listOpen();
    if (result.justActivated) {
      logger.warn("Kill switch active: closing all open positions", { count: open.length });
      if (config.URGENT_ALERTS) {
        await telegram.sendMessage(buildKillSwitchMessage({ source: fileExists ? "file" : "command", positionsClosing: open.length }));
      }
    }
    for (const row of open) {
      const state = positionRowToExitState(row, []);
      persistExitState(row.id, state, { status: "closing", closingSince: row.closingSince ?? now, pendingExitReason: "killed" });
      const updated = positionsStore.get(row.id);
      if (updated) triggerExitFillAttempt(updated);
    }
  });

  // ---- Monitor + closing sweep (section 8) ----
  void runLoop("monitor", config.jupiter.effectivePollSeconds * 1000, logger, signal, async () => {
    await pollOpenPositionsTick();
    await pollClosingPositionsTick();
  });

  // ---- Liquidity batch (section 8.1) ----
  void runLoop("liq-check", config.LIQ_CHECK_SECONDS * 1000, logger, signal, async () => {
    const mints = [...new Set(positionsStore.listOpen().map((r) => r.mint))];
    for (let i = 0; i < mints.length; i += 30) {
      const batch = mints.slice(i, i + 30);
      try {
        const pairs = await dexClient.getPairs(SOLANA_CHAIN_ID, batch);
        for (const mint of batch) {
          const pair = selectPair(pairs, mint, config.ALLOWED_QUOTE_MINTS);
          if (pair?.liquidity?.usd !== undefined) pendingLiquidityReadings.set(mint, pair.liquidity.usd);
        }
      } catch (err) {
        health.dexScreenerErrors++;
        logger.warn("Liquidity batch fetch failed", { error: String(err) });
      }
    }
  });

  // ---- Shadow polling (section 11.2): DexScreener only, never Jupiter ----
  void runLoop("shadow-poll", config.SHADOW_POLL_SECONDS * 1000, logger, signal, async () => {
    if (!config.SHADOW_ENABLED) return;
    const now = Date.now();
    const open = shadowsStore.listOpen();
    for (let i = 0; i < open.length; i += 30) {
      const batch = open.slice(i, i + 30);
      let pairs: DexPair[] = [];
      try {
        pairs = await dexClient.getPairs(SOLANA_CHAIN_ID, batch.map((s) => s.mint));
      } catch (err) {
        health.dexScreenerErrors++;
        logger.warn("Shadow batch fetch failed", { error: String(err) });
        continue;
      }
      for (const shadow of batch) {
        const pair = selectPair(pairs, shadow.mint, config.ALLOWED_QUOTE_MINTS);
        const shadowCfg = { poolFeePct: config.SHADOW_POOL_FEE_PCT, extraSlippagePct: config.PAPER_EXTRA_SLIPPAGE_PCT, feeUsdPerTx: config.PAPER_FEE_USD_PER_TX };
        let pnlPct: number | null = null;
        let proceeds = 0;
        if (pair?.priceUsd !== undefined && pair.liquidity?.usd !== undefined) {
          proceeds = shadowValue(shadow.tokenAmount, Number(pair.priceUsd), pair.liquidity.usd, shadowCfg);
          pnlPct = ((proceeds - shadow.costBasis) / shadow.costBasis) * 100;
        }
        const state = shadowRowToExitState(shadow, []);
        const result = shadowStep(state, { now, pnlPct, ...(pair?.liquidity?.usd !== undefined ? { liquidityUsd: pair.liquidity.usd } : {}) }, exitCfg);
        if (result.action === "SELL") {
          shadowsStore.update(shadow.id, {
            outcome: "closed",
            exitTime: now,
            exitReason: result.reason,
            proceeds,
            netPnlUsd: proceeds - shadow.costBasis,
            netPnlPct: pnlPct,
          });
        } else {
          shadowsStore.update(shadow.id, {
            peakPnl: result.newState.peakPnl,
            currentTarget: result.newState.currentTarget,
            targetExtensions: result.newState.targetExtensions,
            timerRestarts: result.newState.timerRestarts,
            lastRestartAt: result.newState.lastRestartAt,
            deadline: result.newState.deadline,
            trailArmed: result.newState.trailArmed,
            fastStreak: result.newState.fastStreak,
            lowLiqStreak: result.newState.lowLiqStreak,
            noRouteSince: result.newState.noRouteSince,
          });
        }
      }
    }
  });

  // ---- Skip tracking sweep (section 11.3) ----
  void runLoop("skip-track-sweep", 60_000, logger, signal, async () => {
    const now = Date.now();
    const due = skipTracksStore.listUnresolved().filter((r) => skipDueOffset(r, now) !== null);
    for (let i = 0; i < due.length; i += 30) {
      const batch = due.slice(i, i + 30);
      try {
        const pairs = await dexClient.getPairs(SOLANA_CHAIN_ID, batch.map((r) => r.mint));
        for (const row of batch) {
          const pair = selectPair(pairs, row.mint, config.ALLOWED_QUOTE_MINTS);
          const price = pair?.priceUsd !== undefined ? Number(pair.priceUsd) : null;
          const offset = skipDueOffset(row, now);
          if (price === null || offset === null) continue;
          if (offset === 15) skipTracksStore.setPrice15m(row.id, price);
          else skipTracksStore.setPrice60mAndResolve(row.id, price);
          if (isSkipTrackResolved({ ...row, price15mUsd: offset === 15 ? price : row.price15mUsd, price60mUsd: offset === 60 ? price : row.price60mUsd })) {
            // resolved flag already set by setPrice60mAndResolve when applicable
          }
        }
      } catch (err) {
        health.dexScreenerErrors++;
        logger.warn("Skip-track sweep fetch failed", { error: String(err) });
      }
    }
  });

  // ---- Post-exit tracking sweep (section 11.3) ----
  void runLoop("post-exit-sweep", 60_000, logger, signal, async () => {
    if (!config.POST_EXIT_TRACK) return;
    const now = Date.now();
    const due = postExitTracksStore.listUnresolved().filter((r) => postExitDueOffset(r, now) !== null);
    for (let i = 0; i < due.length; i += 30) {
      const batch = due.slice(i, i + 30);
      try {
        const pairs = await dexClient.getPairs(SOLANA_CHAIN_ID, batch.map((r) => r.mint));
        for (const row of batch) {
          const pair = selectPair(pairs, row.mint, config.ALLOWED_QUOTE_MINTS);
          const price = pair?.priceUsd !== undefined ? Number(pair.priceUsd) : null;
          const offset = postExitDueOffset(row, now);
          if (price === null || offset === null) continue;
          if (offset === 15) postExitTracksStore.setPrice15m(row.id, price);
          else if (offset === 30) postExitTracksStore.setPrice30m(row.id, price);
          else postExitTracksStore.setPrice60mAndResolve(row.id, price);
          void isPostExitTrackResolved; // referenced for clarity of intent; resolution is set by setPrice60mAndResolve
        }
      } catch (err) {
        health.dexScreenerErrors++;
        logger.warn("Post-exit sweep fetch failed", { error: String(err) });
      }
    }
  });

  // ---- Report (section 11.4), shared by npm run report and /report ----
  function tradeRowsToRecords(mode?: "paper" | "live", from?: string, to?: string): TradeRecord[] {
    return tradesStore.listAll({ ...(mode ? { mode } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).map((t) => {
      const snapshot = t.entryPairSnapshot as DexPair | null;
      const components = t.scoreComponents as TradeRecord["scoreComponents"];
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
        scoreComponents: components,
        proceedsUnknown: t.proceedsUnknown,
      };
    });
  }

  /** /report: the current mode only (section 11.4: paper and live are never mixed). */
  function buildReport(opts: { mode?: "paper" | "live"; from?: string; to?: string } = {}): string {
    const mode = opts.mode ?? (config.MODE as "paper" | "live");
    const hasStuck = positionsStore
      .listClosing()
      .some((r) => r.stuckState !== null || (r.mode === "paper" && shouldWriteOff(r.closingSince ?? Date.now(), Date.now(), config.STUCK_WRITE_OFF_MIN)));
    return formatReport({
      trades: tradeRowsToRecords(mode, opts.from, opts.to),
      ...(mode === "live" ? { feeLosses: feeLossesStore.listAll({ mode: "live", ...(opts.from ? { from: opts.from } : {}), ...(opts.to ? { to: opts.to } : {}) }) } : {}),
      paperTrades: tradeRowsToRecords("paper"),
      skipTracks: skipTracksStore.listAll().map((r) => ({ skipReason: r.skipReason, priceAtSkipUsd: r.priceAtSkipUsd, price15mUsd: r.price15mUsd, price60mUsd: r.price60mUsd })),
      hasStuckPositions: hasStuck,
      goLiveConfig: {
        minTrades: config.GOLIVE_MIN_TRADES,
        minDays: config.GOLIVE_MIN_DAYS,
        minMedianPnlPct: config.GOLIVE_MIN_MEDIAN_PNL_PCT,
        minTotalPnlUsd: config.GOLIVE_MIN_TOTAL_PNL_USD,
        minP10PnlPct: config.GOLIVE_MIN_P10_PNL_PCT,
      },
    });
  }

  // ---- Telegram commands (section 10) ----
  void runLoop("commands", 1000, logger, signal, async () => {
    const offset = stateStore.get<number>("telegramOffset", 0);
    const { nextOffset } = await pollAndHandleCommands({
      telegram,
      stateStore,
      offset,
      timeoutSec: 20,
      buildDigest: () => renderDigest(),
      buildReport: () => buildReport(),
      ...(live ? { sellRetry: (prefix: string) => live.executor.sellRetry(prefix) } : {}),
      logger,
      recordEvent: (type, message) => logEvent(db, Date.now(), type, message),
    });
    if (nextOffset !== offset) stateStore.set("telegramOffset", nextOffset);
  });

  function renderDigest(): string {
    const now = Date.now();
    const skipReasons: Partial<Record<GateCheckId, number>> = {};
    for (const [check, mints] of Object.entries(funnel.skipReasonMints)) {
      skipReasons[check as GateCheckId] = mints?.size ?? 0;
    }

    const openPositions = positionsStore.listOpen().map((row) => ({
      symbol: row.symbol ?? row.mint.slice(0, 6),
      timeHeldMs: now - row.entryTime,
      pnlPct: row.lastPnlPct ?? 0,
      currentTarget: row.currentTarget,
      deadline: row.deadline,
    }));

    const lastDigestAt = stateStore.get<number>("lastDigestAt", startedAt);
    // Section 10 / A12: only the current mode; proceeds_unknown trades are listed separately (section 16.5).
    const closedInWindow = tradesStore.listSince(lastDigestAt).filter((t) => t.mode === config.MODE);
    const summarize = (t: (typeof closedInWindow)[number]) => ({ symbol: t.symbol ?? t.mint.slice(0, 6), exitReason: t.exitReason, netPnlPct: t.netPnlPct, netPnlUsd: t.netPnlUsd });
    const tradesClosed = closedInWindow.filter((t) => !t.proceedsUnknown).map(summarize);
    const proceedsUnknownTrades = closedInWindow.filter((t) => t.proceedsUnknown).map(summarize);

    const today = tradingDayKey(now, config.TRADING_DAY_TZ);
    const todaysAll = tradesStore.listForTradingDay(today).filter((t) => t.mode === config.MODE);
    const todaysTrades = todaysAll.filter((t) => !t.proceedsUnknown);
    const todaysRecords = todaysAll.map((t) => ({ ...t, mode: t.mode as "paper" | "live", m5ChangePct: null, h1ChangePct: null, buyPressurePct: null, liquidityUsd: null, pairAgeMs: null, scoreComponents: null }));
    const todaysFeeLosses = feeLossesStore.listAll({ mode: config.MODE, from: today, to: today });
    const todaysTotals = computeTotals(todaysRecords, todaysFeeLosses);
    const exitReasonBreakdown: Record<string, number> = {};
    for (const t of todaysTrades) exitReasonBreakdown[t.exitReason] = (exitReasonBreakdown[t.exitReason] ?? 0) + 1;
    const wins = todaysTrades.filter((t) => t.netPnlUsd > 0);
    const losses = todaysTrades.filter((t) => t.netPnlUsd <= 0);

    const input: DigestInput = {
      mode: config.MODE.toUpperCase() as "PAPER" | "LIVE",
      now,
      startedAt,
      paused: stateStore.get<boolean>(PAUSED_KEY, false),
      ...(stateStore.get<string | null>(PAUSE_REASON_KEY, null) ? { pauseReason: stateStore.get<string | null>(PAUSE_REASON_KEY, null) as string } : {}),
      killed: fs.existsSync(KILL_PATH) || stateStore.get<boolean>(KILLED_VIA_COMMAND_KEY, false),
      dailyLossHalted: stateStore.get<string | null>(DAILY_LOSS_HALT_DAY_KEY, null) !== null,
      errorHalted: stateStore.get<number>(CONSECUTIVE_ERRORS_KEY, 0) >= config.MAX_CONSECUTIVE_ERRORS,
      lossStreak: stateStore.get<number>(LOSS_STREAK_KEY, 0),
      solPriceUsd: solPriceTracker.get().priceUsd,
      walletUsdc: executor.walletBalances().usdc,
      walletSol: executor.walletBalances().sol,
      tradesClosed,
      proceedsUnknownTrades,
      ...(live ? { live: liveDigestSection(todaysFeeLosses) } : {}),
      openPositions,
      tradingDay: {
        trades: todaysTrades.length,
        winRate: todaysTotals.winRate,
        medianNetPnlPct: todaysTotals.medianNetPnlPct,
        meanNetPnlPct: todaysTotals.meanNetPnlPct,
        totalNetPnlUsd: todaysTotals.totalNetPnlUsd,
        biggestWinUsd: wins.length > 0 ? Math.max(...wins.map((t) => t.netPnlUsd)) : null,
        biggestLossUsd: losses.length > 0 ? Math.min(...losses.map((t) => t.netPnlUsd)) : null,
        exitReasonBreakdown,
      },
      funnel: {
        discovered: funnel.discovered,
        eligible: funnel.eligible,
        ready: funnel.ready,
        entered: funnel.entered,
        pendingNow: pendingStore.countPending(),
        skipReasons,
        skippedSlotsFullCount: funnel.skippedSlotsFull,
        scoreRangeOfEntries: funnel.scoreRangeOfEntries,
      },
      risk: { dailyLossUsd: realizedNetPnlToday(now) + unrealizedLossSum(), dailyLossCapUsd: config.MAX_DAILY_LOSS_USD },
      health: {
        dexScreenerErrors: health.dexScreenerErrors,
        rpcErrors: health.rpcErrors,
        jupiterRequestsPerMinAvg: jupiterLaneBudget.usageSnapshot(now).exitUsed + jupiterLaneBudget.usageSnapshot(now).entryUsed,
        jupiterRequestsPerMinPeak: 0,
        jupiter429s: health.jupiter429s,
        deferredEntryChecks: jupiterLaneBudget.takeDeferredEntryCount(),
        downtimeGaps: health.downtimeGaps,
      },
    };
    stateStore.set("lastDigestAt", now);
    return buildDigest(input);
  }

  // Live counters are cumulative; the digest reports them per window.
  let lastLiveCounters = { rpc: 0, sent: 0, landed: 0, failed: 0, expired: 0, refused: 0 };
  function liveDigestSection(todaysFeeLosses: ReadonlyArray<{ usd: number }>): import("./notify/digest.js").LiveDigestSection {
    const rt = live!;
    const h = rt.executor.health;
    const now = { rpc: rt.rpcCalls(), sent: h.sent, landed: h.landed, failed: h.failed, expired: h.expired, refused: h.refused };
    const d = (k: keyof typeof now) => now[k] - lastLiveCounters[k];
    const section = {
      sellFeeReserveSol: config.sellFeeReserveSol,
      closingPositions: positionsStore
        .listClosing()
        .filter((r) => r.mode === "live")
        .map((r) => ({ symbol: r.symbol ?? r.mint.slice(0, 6), stuckState: r.stuckState, sellAttempts: r.sellAttempts, sellFeesLamports: r.sellFeesLamports })),
      feeLossesToday: { count: todaysFeeLosses.length, usd: todaysFeeLosses.reduce((s, f) => s + f.usd, 0) },
      rpcRequests: d("rpc"),
      tx: { sent: d("sent"), landed: d("landed"), failed: d("failed"), expired: d("expired"), refused: d("refused") },
      unknownTokens: (rt.executor.lastReconcile?.unknownTokens ?? []).map((t) => t.mint),
      emptyTokenAccounts: rt.executor.lastReconcile?.emptyAccounts ?? 0,
    };
    lastLiveCounters = now;
    return section;
  }

  // ---- Digest (section 10), sent even if nothing happened (doubles as a heartbeat) ----
  // immediate: false — see runLoop's comment: the first digest waits a full
  // window instead of firing at startup, so it doesn't zero funnel counters
  // before the first real discovery poll has had a chance to run.
  void runLoop(
    "digest",
    config.DIGEST_INTERVAL_MINUTES * 60 * 1000,
    logger,
    signal,
    async () => {
      await telegram.sendMessage(renderDigest());
      logEvent(db, Date.now(), "digest_sent", "Digest sent");
      funnel.discovered = 0;
      funnel.eligible = 0;
      funnel.ready = 0;
      funnel.entered = 0;
      funnel.skippedSlotsFull = 0;
      funnel.scoreRangeOfEntries = null;
      funnel.skipReasonMints = {};
      health.downtimeGaps = [];
    },
    { immediate: false },
  );

  // ---- Live: wallet balances and the SOL reserve (section 16.7), every 60 s ----
  if (live) {
    void runLoop("live-wallet", 60_000, logger, signal, async () => {
      await live.executor.readWalletBalances();
    }, { immediate: false });
  }

  logger.info(`Trader running (${config.MODE} mode)`, { mode: config.MODE, pollSeconds: config.jupiter.effectivePollSeconds });

  // The shutdown coordinator (section 16.11) waits for in-flight work, persists state, closes the database and exits.
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve());
  });
}

// SPEC.md section 16.9: nothing leaves the process unscrubbed, including fatal errors.
function printFatal(label: string, err: unknown): void {
  const text = err instanceof Error ? `${err.name}: ${err.message}
${err.stack ?? ""}` : String(err);
  console.error(`${label}: ${scrubFatal(text)}`);
}
process.on("uncaughtException", (err) => {
  printFatal("Uncaught exception", err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  // Same outcome as Node's default (crash; pm2 restarts it), but scrubbed.
  printFatal("Unhandled rejection", err);
  process.exit(1);
});

main().catch((err) => {
  printFatal("Fatal error during startup", err);
  process.exit(1);
});
