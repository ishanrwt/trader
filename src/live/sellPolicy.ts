import { BASE_FEE_LAMPORTS, STUCK_AFTER_FAILURES } from "../config/validate.js";
import type { StuckState } from "../storage/positions.js";

/** SPEC.md section 16.6 (A10). Pure rules; the executor applies them. */

export interface SellPolicyConfig {
  sellSlippageBpsStart: number;
  sellSlippageBpsMax: number;
  sellRetrySeconds: number;
  /** STUCK_BACKOFF_SECONDS; the last value repeats. */
  stuckBackoffSeconds: readonly number[];
  maxPriorityFeeLamports: number;
  /** SELL_FEE_BUDGET_SOL in lamports; a position's own budget overrides it after /sellretry. */
  sellFeeBudgetLamports: number;
}

export interface SellAttemptState {
  sellAttempts: number;
  sellFailures: number;
  sellFeesLamports: number;
  failedSellFeesLamports: number;
  sellBudgetLamports: number | null;
  stuckState: StuckState | null;
  stuckSince: number | null;
  nextSellAt: number | null;
}

/** Attempt n (n = failed attempts so far): min(MAX, START x 2^n). */
export function sellSlippageBps(failures: number, cfg: Pick<SellPolicyConfig, "sellSlippageBpsStart" | "sellSlippageBpsMax">): number {
  const doubled = cfg.sellSlippageBpsStart * 2 ** Math.min(failures, 30);
  return Math.min(cfg.sellSlippageBpsMax, doubled);
}

/** Before the stuck point: SELL_RETRY_SECONDS. Once stuck: STUCK_BACKOFF_SECONDS[failures − 3], the last value repeating. */
export function retryDelayMs(failures: number, cfg: Pick<SellPolicyConfig, "sellRetrySeconds" | "stuckBackoffSeconds">): number {
  if (failures < STUCK_AFTER_FAILURES) return cfg.sellRetrySeconds * 1000;
  const list = cfg.stuckBackoffSeconds;
  const idx = Math.min(failures - STUCK_AFTER_FAILURES, list.length - 1);
  return list[idx]! * 1000;
}

/** The most one attempt can pay in network fees (one signature + the priority-fee cap). */
export function maxAttemptFeeLamports(cfg: Pick<SellPolicyConfig, "maxPriorityFeeLamports">): number {
  return BASE_FEE_LAMPORTS + cfg.maxPriorityFeeLamports;
}

export function budgetLamports(state: Pick<SellAttemptState, "sellBudgetLamports">, cfg: Pick<SellPolicyConfig, "sellFeeBudgetLamports">): number {
  return state.sellBudgetLamports ?? cfg.sellFeeBudgetLamports;
}

/** Before each send: would this attempt's worst case push the position over its fee budget? */
export function withinFeeBudget(state: Pick<SellAttemptState, "sellFeesLamports" | "sellBudgetLamports">, cfg: Pick<SellPolicyConfig, "maxPriorityFeeLamports" | "sellFeeBudgetLamports">): boolean {
  return state.sellFeesLamports + maxAttemptFeeLamports(cfg) <= budgetLamports(state, cfg);
}

/** Is an attempt due now? */
export function sellAttemptDue(state: Pick<SellAttemptState, "nextSellAt">, now: number): boolean {
  return state.nextSellAt === null || now >= state.nextSellAt;
}

export interface FailureOutcome {
  state: SellAttemptState;
  becameStuck: boolean;
}

/**
 * A failed attempt: no route, simulation error, verification refusal, on-chain
 * failure (feeLamports > 0), or expiry. After STUCK_AFTER_FAILURES (3) the
 * position becomes `stuck` (one alert) and retries move to the backoff schedule.
 */
export function afterFailedAttempt(state: SellAttemptState, now: number, feeLamports: number, cfg: SellPolicyConfig): FailureOutcome {
  const failures = state.sellFailures + 1;
  const becameStuck = failures >= STUCK_AFTER_FAILURES && state.stuckState === null;
  return {
    becameStuck,
    state: {
      ...state,
      sellAttempts: state.sellAttempts + 1,
      sellFailures: failures,
      sellFeesLamports: state.sellFeesLamports + feeLamports,
      failedSellFeesLamports: state.failedSellFeesLamports + feeLamports,
      stuckState: becameStuck ? "stuck" : state.stuckState,
      stuckSince: becameStuck ? now : state.stuckSince,
      nextSellAt: now + retryDelayMs(failures, cfg),
    },
  };
}

/** The fee budget is used up: no more sends; only on-chain balance reads on the last backoff interval. */
export function markBudgetExhausted(state: SellAttemptState, now: number, cfg: Pick<SellPolicyConfig, "stuckBackoffSeconds">): SellAttemptState {
  const last = cfg.stuckBackoffSeconds[cfg.stuckBackoffSeconds.length - 1]!;
  return { ...state, stuckState: "budget_exhausted", stuckSince: state.stuckSince ?? now, nextSellAt: now + last * 1000 };
}

/** /sellretry: one more SELL_FEE_BUDGET_SOL, attempts resume (on the backoff schedule, first one now). */
export function grantSellBudget(state: SellAttemptState, now: number, cfg: Pick<SellPolicyConfig, "sellFeeBudgetLamports">): SellAttemptState {
  return {
    ...state,
    sellBudgetLamports: budgetLamports(state, cfg) + cfg.sellFeeBudgetLamports,
    stuckState: "stuck",
    stuckSince: state.stuckSince ?? now,
    nextSellAt: now,
  };
}
