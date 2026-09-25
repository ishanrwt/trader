import { decodeSecretKey, SecretKeyFormatError } from "../encoding/secretKey.js";
import { envSchema, KNOWN_ENV_KEYS, type RawConfig } from "./schema.js";
import {
  BASE_FEE_LAMPORTS,
  computeJupiterBudget,
  LAMPORTS_PER_SOL,
  parsePriorityFeePercentile,
  sellFeeReserveSol,
  STUCK_AFTER_FAILURES,
  unknownKeys,
  validateRpcBudget,
  validateWeights,
  type PriorityFeePercentile,
} from "./validate.js";

export { KNOWN_ENV_KEYS, unknownKeys };

/** Live execution is a code constant, not an env var, per SPEC.md section 16. */
export const HARD_MAX_POSITION_USD = 100;
/** SPEC.md section 16.8: MODE=live requires exactly this acknowledgement. */
export const LIVE_ACK_PHRASE = "I_ACCEPT_REAL_LOSSES";

export interface JupiterBudgetConfig {
  readonly exitReserve: number;
  readonly effectivePollSeconds: number;
  readonly stretched: boolean;
}

/**
 * The parsed configuration. WALLET_PRIVATE_KEY is deliberately NOT part of it
 * (SPEC.md section 16.9): no config dump or log of this object can contain the
 * key. Live mode reads the key straight from the environment, once, in
 * src/live/keys.ts.
 */
export type Config = Omit<RawConfig, "WALLET_PRIVATE_KEY"> &
  Readonly<{
    hardMaxPositionUsd: number;
    jupiter: JupiterBudgetConfig;
    /** Raw secret values to scrub from every log line. Empty ones are omitted. Never includes the wallet key (its encodings are registered separately). */
    secrets: readonly string[];
    /** True if WALLET_PRIVATE_KEY was non-empty (only allowed in live mode). */
    walletKeyProvided: boolean;
    /** Derived, not configured (section 13). */
    sellFeeReserveSol: number;
    priorityFeePercentile: PriorityFeePercentile;
    maxPriorityFeeLamports: number;
    sellFeeBudgetLamports: number;
  }>;

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * Parses and validates `.env` values. Throws ConfigError (never starts) on any
 * invalid value, per SPEC.md section 2's "config" module and section 13's
 * startup validation list. No error message ever contains the wallet key.
 */
export function loadConfig(envSource: Record<string, string | undefined>): Config {
  const parsed = envSchema.safeParse(envSource);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(issues);
  }
  const { WALLET_PRIVATE_KEY: walletKey, ...raw } = parsed.data;
  const live = raw.MODE === "live";
  const issues: string[] = [];

  const weights = validateWeights({
    wBuyPressure: raw.W_BUY_PRESSURE,
    wActivity: raw.W_ACTIVITY,
    wMomentum: raw.W_MOMENTUM,
    wDepth: raw.W_DEPTH,
    wHolders: raw.W_HOLDERS,
    wFreshness: raw.W_FRESHNESS,
  });
  if (!weights.ok && weights.error) issues.push(weights.error);

  const budget = computeJupiterBudget({
    maxConcurrent: raw.MAX_CONCURRENT,
    pollSeconds: raw.POLL_SECONDS,
    exitReserveExtraPerMin: raw.EXIT_RESERVE_EXTRA_PER_MIN,
    entryMinBudgetPerMin: raw.ENTRY_MIN_BUDGET_PER_MIN,
    jupiterMaxReqPerMin: raw.JUPITER_MAX_REQ_PER_MIN,
    autoStretchPoll: raw.AUTO_STRETCH_POLL,
    ...(live ? { sellRetrySeconds: raw.SELL_RETRY_SECONDS } : {}),
  });

  let jupiter: JupiterBudgetConfig = {
    exitReserve: 0,
    effectivePollSeconds: raw.POLL_SECONDS,
    stretched: false,
  };
  if (budget.ok) {
    jupiter = {
      exitReserve: budget.exitReserve,
      effectivePollSeconds: budget.pollSeconds,
      stretched: budget.stretched,
    };
  } else {
    issues.push(budget.error);
  }

  if (raw.POSITION_USD > HARD_MAX_POSITION_USD) {
    issues.push(
      `POSITION_USD (${raw.POSITION_USD}) exceeds the hard cap of ${HARD_MAX_POSITION_USD} ` +
        `(HARD_MAX_POSITION_USD, a code constant per section 16).`,
    );
  }

  const priorityFeePercentile = parsePriorityFeePercentile(raw.PRIORITY_FEE_PERCENTILE);
  if (priorityFeePercentile === null) {
    issues.push(`PRIORITY_FEE_PERCENTILE must be medium, high, veryHigh, or an integer 0-10000 (got "${raw.PRIORITY_FEE_PERCENTILE}").`);
  }

  if (!live && walletKey !== "") {
    issues.push("WALLET_PRIVATE_KEY must be left empty in paper mode (section 13).");
  }

  if (live) {
    issues.push(...liveIssues(raw, walletKey));
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  const secrets = [raw.SOLANA_RPC_URL, raw.JUPITER_API_KEY, raw.TRADER_TELEGRAM_BOT_TOKEN].filter((s) => s.length > 0);

  return Object.freeze({
    ...raw,
    hardMaxPositionUsd: HARD_MAX_POSITION_USD,
    jupiter,
    secrets,
    walletKeyProvided: walletKey !== "",
    sellFeeReserveSol: sellFeeReserveSol(raw.MAX_CONCURRENT, raw.MAX_PRIORITY_FEE_SOL),
    priorityFeePercentile: priorityFeePercentile ?? "high",
    maxPriorityFeeLamports: Math.floor(raw.MAX_PRIORITY_FEE_SOL * LAMPORTS_PER_SOL),
    sellFeeBudgetLamports: Math.floor(raw.SELL_FEE_BUDGET_SOL * LAMPORTS_PER_SOL),
  });
}

/** SPEC.md sections 13 and 16.8: every check that only applies when MODE=live. */
function liveIssues(raw: Omit<RawConfig, "WALLET_PRIVATE_KEY">, walletKey: string): string[] {
  const issues: string[] = [];
  if (raw.PAPER_HALTS_OBSERVE_ONLY) {
    issues.push("PAPER_HALTS_OBSERVE_ONLY=true is paper-only: MODE=live refuses to start with it on, because live halts must always block entries (section 9.1).");
  }
  if (raw.LIVE_ACK !== LIVE_ACK_PHRASE) {
    issues.push(`MODE=live (Phase 3 live execution) requires LIVE_ACK=${LIVE_ACK_PHRASE} exactly (section 16.8).`);
  }
  if (walletKey === "") {
    issues.push("MODE=live (Phase 3 live execution) requires WALLET_PRIVATE_KEY (section 16.8).");
  } else {
    try {
      decodeSecretKey(walletKey).fill(0);
    } catch (err) {
      // SecretKeyFormatError never carries the value; anything else is replaced by a fixed message.
      issues.push(err instanceof SecretKeyFormatError ? err.message : "WALLET_PRIVATE_KEY could not be decoded.");
    }
  }
  if (raw.SELL_SLIPPAGE_BPS_START > raw.SELL_SLIPPAGE_BPS_MAX) {
    issues.push(`SELL_SLIPPAGE_BPS_START (${raw.SELL_SLIPPAGE_BPS_START}) must be <= SELL_SLIPPAGE_BPS_MAX (${raw.SELL_SLIPPAGE_BPS_MAX}).`);
  }
  if (!(raw.SELL_RETRY_SECONDS > 0)) issues.push("SELL_RETRY_SECONDS must be > 0.");
  if (raw.STUCK_BACKOFF_SECONDS.some((s) => !(s >= raw.SELL_RETRY_SECONDS))) {
    issues.push(`Every STUCK_BACKOFF_SECONDS value must be >= SELL_RETRY_SECONDS (${raw.SELL_RETRY_SECONDS}).`);
  }
  if (!(raw.MAX_PRIORITY_FEE_SOL > 0)) issues.push("MAX_PRIORITY_FEE_SOL must be > 0.");
  const minBudget = STUCK_AFTER_FAILURES * (BASE_FEE_LAMPORTS / LAMPORTS_PER_SOL + raw.MAX_PRIORITY_FEE_SOL);
  if (raw.SELL_FEE_BUDGET_SOL < minBudget) {
    issues.push(
      `SELL_FEE_BUDGET_SOL (${raw.SELL_FEE_BUDGET_SOL}) must be >= 3 x (base fee + MAX_PRIORITY_FEE_SOL) = ${minBudget.toFixed(6)} ` +
        `so a position can reach the stuck point before its budget runs out.`,
    );
  }
  if (!(raw.TX_CONFIRM_POLL_SECONDS > 0)) issues.push("TX_CONFIRM_POLL_SECONDS must be > 0.");
  const rpc = validateRpcBudget({
    rpcMaxRps: raw.RPC_MAX_RPS,
    rpcSendMaxRps: raw.RPC_SEND_MAX_RPS,
    txConfirmPollSeconds: raw.TX_CONFIRM_POLL_SECONDS,
    maxConcurrent: raw.MAX_CONCURRENT,
  });
  if (rpc) issues.push(rpc);
  return issues;
}
