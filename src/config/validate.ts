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

function exitReserveFor(maxConcurrent: number, pollSeconds: number, exitReserveExtraPerMin: number): number {
  return maxConcurrent * Math.ceil(60 / pollSeconds) + exitReserveExtraPerMin;
}

/**
 * SPEC.md section 9.3 startup validation: exitReserve + ENTRY_MIN_BUDGET_PER_MIN
 * must fit under JUPITER_MAX_REQ_PER_MIN. If it doesn't and AUTO_STRETCH_POLL is
 * set, raise POLL_SECONDS until it fits; otherwise refuse to start.
 */
export function computeJupiterBudget(input: JupiterBudgetInput): JupiterBudgetResult {
  const { maxConcurrent, exitReserveExtraPerMin, entryMinBudgetPerMin, jupiterMaxReqPerMin, autoStretchPoll } = input;

  const initialReserve = exitReserveFor(maxConcurrent, input.pollSeconds, exitReserveExtraPerMin);
  if (initialReserve + entryMinBudgetPerMin <= jupiterMaxReqPerMin) {
    return { ok: true, pollSeconds: input.pollSeconds, exitReserve: initialReserve, stretched: false };
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
    const reserve = exitReserveFor(maxConcurrent, poll, exitReserveExtraPerMin);
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

/** Keys present in the parsed `.env` file that this app doesn't recognize. */
export function unknownKeys(envFileKeys: Iterable<string>, knownKeys: readonly string[]): string[] {
  const known = new Set(knownKeys);
  return [...envFileKeys].filter((k) => !known.has(k));
}
