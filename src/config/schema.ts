import { z } from "zod";
import {
  boolField,
  enumField,
  intField,
  listField,
  numberField,
  numberListField,
  optionalStringField,
  requiredStringField,
} from "./fields.js";

const DEFAULT_QUOTE_MINTS = [
  "So11111111111111111111111111111111111111112", // wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
];

export const envSchema = z.object({
  // ---- Mode ----
  MODE: enumField(["paper", "live"], "paper"),
  LIVE_ACK: optionalStringField(""),
  TRADING_DAY_TZ: optionalStringField("Asia/Kolkata"),
  LOG_LEVEL: enumField(["trace", "debug", "info", "warn", "error", "fatal"], "info"),

  // ---- Secrets ----
  SOLANA_RPC_URL: requiredStringField(),
  JUPITER_API_KEY: requiredStringField(),
  WALLET_PRIVATE_KEY: optionalStringField(""),
  TRADER_TELEGRAM_BOT_TOKEN: requiredStringField(),
  TRADER_TELEGRAM_CHAT_ID: requiredStringField(),

  // ---- Discovery ----
  DISCOVERY_SECONDS: numberField(20),
  PENDING_RECHECK_SECONDS: numberField(30),
  MAX_PENDING_AGE_MIN: numberField(180),
  MAX_NO_PAIR_CHECKS: intField(3),
  SEEN_MINTS_CAP: intField(5000),
  DEX_PROFILES_MAX_PER_MIN: intField(40),
  DEX_PAIRS_MAX_PER_MIN: intField(200),
  ALLOWED_QUOTE_MINTS: listField(DEFAULT_QUOTE_MINTS),
  REQUIRE_ANIMAL_THEME: boolField(false),

  // ---- Entry gate ----
  MIN_LIQUIDITY_USD: numberField(10000),
  ENTRY_WINDOW_MIN: numberField(15),
  MIN_M5_CHANGE_PCT: numberField(0),
  MIN_H1_CHANGE_PCT: numberField(0),
  MIN_H24_CHANGE_PCT: numberField(0),
  MAX_H1_CHANGE_PCT: numberField(0),
  MIN_M5_TXNS: intField(10),
  MIN_M5_BUY_SELL_RATIO: numberField(1.0),
  MIN_M5_VOLUME_USD: numberField(1000),
  REQUIRE_MINT_REVOKED: boolField(true),
  REQUIRE_FREEZE_REVOKED: boolField(true),
  MAX_TOP1_PCT: numberField(15),
  MAX_TOP10_PCT: numberField(40),
  HOLDERS_CACHE_MIN: numberField(5),
  MAX_ROUNDTRIP_LOSS_PCT: numberField(8),
  MAX_ENTRY_DRIFT_PCT: numberField(10),
  REENTRY_ENABLED: boolField(false),

  // ---- Selection ----
  W_BUY_PRESSURE: numberField(0.25),
  W_ACTIVITY: numberField(0.2),
  W_MOMENTUM: numberField(0.2),
  W_DEPTH: numberField(0.15),
  W_HOLDERS: numberField(0.1),
  W_FRESHNESS: numberField(0.1),
  ACTIVITY_CAP: numberField(0.5),
  MOMENTUM_CAP_PCT: numberField(100),
  DEPTH_CAP_USD: numberField(200000),
  MIN_SCORE: numberField(0),

  // ---- Sizing and risk ----
  POSITION_USD: numberField(25),
  MAX_POSITION_PCT_OF_LIQ: numberField(1),
  MAX_CONCURRENT: intField(3),
  MAX_DAILY_LOSS_USD: numberField(30),
  CONSECUTIVE_LOSS_PAUSE: intField(5),
  LOSS_PAUSE_MINUTES: numberField(60),
  MAX_CONSECUTIVE_ERRORS: intField(5),

  // ---- Exits ----
  POLL_SECONDS: numberField(10),
  STOP_LOSS_PCT: numberField(15),
  TARGET_PROFIT_PCT: numberField(30),
  EXTRA_TARGET_PCT: numberField(10),
  MAX_TARGET_EXTENSIONS: intField(1),
  HOLD_MINUTES: numberField(15),
  FAST_GAIN_PCT: numberField(15),
  FAST_WINDOW_MINUTES: numberField(5),
  FAST_MIN_HISTORY_SEC: numberField(60),
  FAST_CONFIRM_POLLS: intField(2),
  MAX_TIMER_RESTARTS: intField(3),
  MAX_TOTAL_HOLD_MINUTES: numberField(60),
  TRAIL_PCT: numberField(4),
  BREAKEVEN_TRIGGER_PCT: numberField(20),
  BREAKEVEN_FLOOR_PCT: numberField(2),
  FLAT_BAND_PCT: numberField(3),
  LIQ_DROP_EXIT_PCT: numberField(30),
  LIQ_DROP_CONFIRM_READS: intField(2),
  LIQ_CHECK_SECONDS: numberField(30),
  NO_ROUTE_EXIT_SEC: numberField(30),
  STUCK_WRITE_OFF_MIN: numberField(30),

  // ---- API budgets ----
  JUPITER_MAX_REQ_PER_MIN: intField(45),
  JUPITER_MIN_INTERVAL_MS: intField(1100),
  EXIT_RESERVE_EXTRA_PER_MIN: intField(5),
  ENTRY_MIN_BUDGET_PER_MIN: intField(10),
  AUTO_STRETCH_POLL: boolField(false),
  RPC_MAX_RPS: intField(8),
  RPC_SEND_MAX_RPS: intField(1),

  // ---- Paper mode ----
  PAPER_STARTING_USDC: numberField(500),
  PAPER_STARTING_SOL: numberField(0.5),
  PAPER_EXTRA_SLIPPAGE_PCT: numberField(2),
  PAPER_LATENCY_SEC: numberField(3),
  PAPER_FEE_USD_PER_TX: numberField(0.05),

  // ---- Tracking ----
  SHADOW_ENABLED: boolField(true),
  SHADOW_MAX_OPEN: intField(30),
  SHADOW_POLL_SECONDS: numberField(15),
  SHADOW_POOL_FEE_PCT: numberField(1),
  SKIP_TRACK_MAX_PER_HOUR: intField(60),
  POST_EXIT_TRACK: boolField(true),

  // ---- Notifications ----
  DIGEST_INTERVAL_MINUTES: numberField(120),
  URGENT_ALERTS: boolField(true),
  OUTAGE_ALERT_MINUTES: numberField(10),

  // ---- Go-live checklist ----
  GOLIVE_MIN_TRADES: intField(100),
  GOLIVE_MIN_DAYS: numberField(7),
  GOLIVE_MIN_MEDIAN_PNL_PCT: numberField(0),
  GOLIVE_MIN_TOTAL_PNL_USD: numberField(0),
  GOLIVE_MIN_P10_PNL_PCT: numberField(-20),

  // ---- Live execution (Phase 3) ----
  BUY_SLIPPAGE_BPS: intField(300),
  SELL_SLIPPAGE_BPS_START: intField(300),
  SELL_SLIPPAGE_BPS_MAX: intField(2000),
  MAX_PRIORITY_FEE_SOL: numberField(0.0005),
  PRIORITY_FEE_PERCENTILE: optionalStringField("high"),
  MIN_SOL_BALANCE: numberField(0.05),
  CLOSE_EMPTY_ATA: boolField(true),
  SELL_RETRY_SECONDS: numberField(10),
  STUCK_BACKOFF_SECONDS: numberListField([30, 60, 120, 300, 600]),
  SELL_FEE_BUDGET_SOL: numberField(0.005),
  TX_CONFIRM_POLL_SECONDS: numberField(2),
});

export type RawConfig = z.infer<typeof envSchema>;

/** Every key this app recognizes in `.env`, used to warn on unknown keys. */
export const KNOWN_ENV_KEYS: readonly string[] = Object.keys(envSchema.shape);
