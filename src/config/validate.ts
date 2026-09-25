export interface WeightValidationResult {
  ok: boolean;
  sum: number;
  error?: string;
}

const WEIGHT_TOLERANCE = 0.01;

/** SPEC.md section 6.1: the six selection weights must sum to 1.0 (+/- 0.01). */
export function validateWeights(weights: {
  wBuyPressure: number;
  wActivity: number;
  wMomentum: number;
  wDepth: number;
  wHolders: number;
  wFreshness: number;
}): WeightValidationResult {
  const sum =
    weights.wBuyPressure +
    weights.wActivity +
    weights.wMomentum +
    weights.wDepth +
    weights.wHolders +
    weights.wFreshness;

  const ok = Math.abs(sum - 1.0) <= WEIGHT_TOLERANCE;
  return ok
    ? { ok, sum }
    : {
        ok,
        sum,
        error: `Selection weights sum to ${sum.toFixed(4)}, expected 1.0 (+/- ${WEIGHT_TOLERANCE}).`,
      };
}

export interface JupiterBudgetInput {
  maxConcurrent: number;
  pollSeconds: number;
  exitReserveExtraPerMin: number;
  entryMinBudgetPerMin: number;
  jupiterMaxReqPerMin: number;
  autoStretchPoll: boolean;
  /** Live mode only (SPEC.md section 9.3): a closing position retries its sell every SELL_RETRY_SECONDS instead of being polled. */
  sellRetrySeconds?: number;
}

export type JupiterBudgetResult =
  | {
      ok: true;
      pollSeconds: number;
      exitReserve: number;
      stretched: boolean;
    }
  | {
      ok: false;
      error: string;
    };

const MAX_POLL_SECONDS_SEARCH = 3600;

function exitReserveFor(maxConcurrent: number, pollSeconds: number, exitReserveExtraPerMin: number, sellRetrySeconds?: number): number {
  const period = sellRetrySeconds !== undefined ? Math.min(pollSeconds, sellRetrySeconds) : pollSeconds;
  return maxConcurrent * Math.ceil(60 / period) + exitReserveExtraPerMin;
}

/**
 * SPEC.md section 9.3 startup validation: exitReserve + ENTRY_MIN_BUDGET_PER_MIN
 * must fit under JUPITER_MAX_REQ_PER_MIN. If it doesn't and AUTO_STRETCH_POLL is
 * set, raise POLL_SECONDS until it fits; otherwise refuse to start.
 */
export function computeJupiterBudget(input: JupiterBudgetInput): JupiterBudgetResult {
  const { maxConcurrent, exitReserveExtraPerMin, entryMinBudgetPerMin, jupiterMaxReqPerMin, autoStretchPoll, sellRetrySeconds } = input;

  const initialReserve = exitReserveFor(maxConcurrent, input.pollSeconds, exitReserveExtraPerMin, sellRetrySeconds);
  if (initialReserve + entryMinBudgetPerMin <= jupiterMaxReqPerMin) {
    return { ok: true, pollSeconds: input.pollSeconds, exitReserve: initialReserve, stretched: false };
  }

  // Live mode: sell retries are never stretched automatically (section 9.3). If
  // SELL_RETRY_SECONDS alone already doesn't fit, raising POLL_SECONDS can't help.
  if (sellRetrySeconds !== undefined) {
    const floorReserve = maxConcurrent * Math.ceil(60 / sellRetrySeconds) + exitReserveExtraPerMin;
    if (floorReserve + entryMinBudgetPerMin > jupiterMaxReqPerMin) {
      return {
        ok: false,
        error:
          `Jupiter budget exceeded by live sell retries: MAX_CONCURRENT x ceil(60 / SELL_RETRY_SECONDS=${sellRetrySeconds}) + ` +
          `EXIT_RESERVE_EXTRA_PER_MIN + ENTRY_MIN_BUDGET_PER_MIN = ${floorReserve + entryMinBudgetPerMin} > JUPITER_MAX_REQ_PER_MIN (${jupiterMaxReqPerMin}). ` +
          `Raise SELL_RETRY_SECONDS or JUPITER_MAX_REQ_PER_MIN, or reduce MAX_CONCURRENT (sell retries are never stretched automatically).`,
      };
    }
  }

  if (!autoStretchPoll) {
    return {
      ok: false,
      error:
        `Jupiter budget exceeded: exitReserve (${initialReserve}) + ENTRY_MIN_BUDGET_PER_MIN ` +
        `(${entryMinBudgetPerMin}) > JUPITER_MAX_REQ_PER_MIN (${jupiterMaxReqPerMin}) at POLL_SECONDS=${input.pollSeconds}. ` +
        `Increase JUPITER_MAX_REQ_PER_MIN, reduce MAX_CONCURRENT, raise POLL_SECONDS, or set AUTO_STRETCH_POLL=true.`,
    };
  }

  for (let poll = Math.floor(input.pollSeconds) + 1; poll <= MAX_POLL_SECONDS_SEARCH; poll++) {
    const reserve = exitReserveFor(maxConcurrent, poll, exitReserveExtraPerMin, sellRetrySeconds);
    if (reserve + entryMinBudgetPerMin <= jupiterMaxReqPerMin) {
      return { ok: true, pollSeconds: poll, exitReserve: reserve, stretched: true };
    }
  }

  return {
    ok: false,
    error:
      `Jupiter budget exceeded even after raising POLL_SECONDS up to ${MAX_POLL_SECONDS_SEARCH}s. ` +
      `Increase JUPITER_MAX_REQ_PER_MIN or reduce MAX_CONCURRENT.`,
  };
}

/** Solana's base fee per signature; every bot transaction has exactly one signature (SPEC.md section 16). */
export const BASE_FEE_LAMPORTS = 5_000;
export const LAMPORTS_PER_SOL = 1_000_000_000;
/** Failed attempts before a live sell is marked stuck (SPEC.md section 16.6). */
export const STUCK_AFTER_FAILURES = 3;

/**
 * SPEC.md section 13: SELL_FEE_RESERVE_SOL is derived, not configured:
 * MAX_CONCURRENT x 3 x (base fee + MAX_PRIORITY_FEE_SOL).
 */
export function sellFeeReserveSol(maxConcurrent: number, maxPriorityFeeSol: number): number {
  return maxConcurrent * STUCK_AFTER_FAILURES * (BASE_FEE_LAMPORTS / LAMPORTS_PER_SOL + maxPriorityFeeSol);
}

export type PriorityFeePercentile = "medium" | "high" | "veryHigh" | number;

/** PRIORITY_FEE_PERCENTILE: Jupiter's named levels or an integer 0-10000 (bps). Null if invalid. */
export function parsePriorityFeePercentile(raw: string): PriorityFeePercentile | null {
  if (raw === "medium" || raw === "high" || raw === "veryHigh") return raw;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 0 && n <= 10_000 ? n : null;
}

/**
 * SPEC.md section 16.10: live startup validation of the RPC budget.
 * RPC_MAX_RPS >= 2 / TX_CONFIRM_POLL_SECONDS + min(RPC_SEND_MAX_RPS, MAX_CONCURRENT / 4) + 2.
 */
export function validateRpcBudget(input: { rpcMaxRps: number; rpcSendMaxRps: number; txConfirmPollSeconds: number; maxConcurrent: number }): string | null {
  if (input.rpcSendMaxRps < 1) return `RPC_SEND_MAX_RPS (${input.rpcSendMaxRps}) must be at least 1 in live mode.`;
  const required = 2 / input.txConfirmPollSeconds + Math.min(input.rpcSendMaxRps, input.maxConcurrent / 4) + 2;
  if (input.rpcMaxRps < required) {
    return (
      `RPC budget too small for live mode: RPC_MAX_RPS (${input.rpcMaxRps}) must be >= 2 / TX_CONFIRM_POLL_SECONDS + ` +
      `min(RPC_SEND_MAX_RPS, MAX_CONCURRENT / 4) + 2 = ${required.toFixed(2)} (section 16.10).`
    );
  }
  return null;
}

/** Keys present in the parsed `.env` file that this app doesn't recognize. */
export function unknownKeys(envFileKeys: Iterable<string>, knownKeys: readonly string[]): string[] {
  const known = new Set(knownKeys);
  return [...envFileKeys].filter((k) => !known.has(k));
}
