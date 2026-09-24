import { envSchema, KNOWN_ENV_KEYS, type RawConfig } from "./schema.js";
import { computeJupiterBudget, unknownKeys, validateWeights } from "./validate.js";

export { KNOWN_ENV_KEYS, unknownKeys };

/** Live execution is a code constant, not an env var, per SPEC.md section 16. */
export const HARD_MAX_POSITION_USD = 100;

export interface JupiterBudgetConfig {
  readonly exitReserve: number;
  readonly effectivePollSeconds: number;
  readonly stretched: boolean;
}

export type Config = RawConfig &
  Readonly<{
    hardMaxPositionUsd: number;
    jupiter: JupiterBudgetConfig;
    /** Raw secret values to scrub from every log line. Empty ones are omitted. */
    secrets: readonly string[];
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
 * startup validation list.
 */
export function loadConfig(envSource: Record<string, string | undefined>): Config {
  const parsed = envSchema.safeParse(envSource);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(issues);
  }
  const raw = parsed.data;
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

  if (raw.MODE === "live") {
    issues.push(
      "MODE=live is not supported yet: live execution is Phase 3 and hasn't been built. Set MODE=paper.",
    );
  }

  if (raw.MODE === "paper" && raw.WALLET_PRIVATE_KEY !== "") {
    issues.push("WALLET_PRIVATE_KEY must be left empty in paper mode (section 13).");
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  const secrets = [raw.SOLANA_RPC_URL, raw.JUPITER_API_KEY, raw.WALLET_PRIVATE_KEY, raw.TRADER_TELEGRAM_BOT_TOKEN].filter(
    (s) => s.length > 0,
  );

  return Object.freeze({
    ...raw,
    hardMaxPositionUsd: HARD_MAX_POSITION_USD,
    jupiter,
    secrets,
  });
}
