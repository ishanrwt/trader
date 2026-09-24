import type { Logger } from "../logger/index.js";
import { step, type ExitState, type ExitStateMachineConfig, type ExitStepResult } from "./stateMachine.js";

export interface PollPositionInput {
  id: number;
  state: ExitState;
  /** One exit-lane quote -> pnlPct, or null if there's no quote/route. */
  fetchPnlPct: (now: number) => Promise<number | null>;
  /** A fresh LIQ_CHECK_SECONDS reading, if this tick has one. */
  liquidityUsd?: number;
}

export interface PollPositionOutcome {
  id: number;
  result: Exclude<ExitStepResult, { action: "NEED_CONFIRM" }>;
}

/**
 * Runs the pure state machine for one position, handling the NEED_CONFIRM
 * round trip per its documented contract: the confirmation call is made
 * against the ORIGINAL state and inputs (not the NEED_CONFIRM result's
 * newState), so steps 1-2's mutations (noRouteSince, lowLiqStreak) are
 * applied exactly once.
 */
export async function pollPosition(input: PollPositionInput, now: number, cfg: ExitStateMachineConfig): Promise<PollPositionOutcome> {
  const pnlPct = await input.fetchPnlPct(now);
  const baseInputs = { now, pnlPct, ...(input.liquidityUsd !== undefined ? { liquidityUsd: input.liquidityUsd } : {}) };

  const first = step(input.state, baseInputs, cfg);
  if (first.action !== "NEED_CONFIRM") {
    return { id: input.id, result: first };
  }

  const confirmPnlPct = await input.fetchPnlPct(now);
  // No route on the confirmation quote either: we can't verify the position recovered, so treat it as confirmed.
  const resolved = step(input.state, { ...baseInputs, confirmPnlPct: confirmPnlPct ?? -Infinity }, cfg);
  return { id: input.id, result: resolved as Exclude<ExitStepResult, { action: "NEED_CONFIRM" }> };
}

export interface PollOpenPositionsOptions {
  positions: PollPositionInput[];
  now: number;
  cfg: ExitStateMachineConfig;
  /** Persist a HOLD's newState. May be awaited; only affects this position. */
  onHold: (id: number, newState: ExitState, logs: string[]) => Promise<void>;
  /**
   * Fired for a SELL decision. MUST be fire-and-forget from this function's
   * perspective (its own promise, e.g. the paper exit fill's PAPER_LATENCY_SEC
   * wait, is deliberately not awaited here) so one position's fill never
   * delays polling the others, and never delays the next POLL_SECONDS tick.
   */
  onSell: (id: number, reason: string, newState: ExitState) => void;
  logger: Logger;
}

export interface TriggerFireAndForgetOptions<T> {
  id: T;
  /** Mutated: `id` is added synchronously before `attempt()` starts and always removed afterward. */
  inFlight: Set<T>;
  attempt: () => Promise<void>;
  /** Called if `attempt()` rejects. `attempt()`'s rejection is always caught here — it can never surface as an unhandled promise rejection. */
  onError: (id: T, err: unknown) => void;
}

/**
 * Fires `attempt()` without awaiting it — the shared fire-and-forget pattern
 * behind every paper fill (entry and exit): a slow fill's latency wait never
 * blocks the caller. Guarantees, independent of what `attempt()` does:
 *   1. `id` is added to `inFlight` synchronously, before `attempt()` is even
 *      invoked, and a second call for the same `id` while still in flight is
 *      a no-op (never double-attempts the same fill).
 *   2. Every rejection from `attempt()` is routed to `onError`, never left
 *      as an unhandled rejection.
 *   3. `id` is always removed from `inFlight` once `attempt()` settles,
 *      success or failure.
 */
export function triggerFireAndForget<T>(opts: TriggerFireAndForgetOptions<T>): void {
  if (opts.inFlight.has(opts.id)) return;
  opts.inFlight.add(opts.id);
  void opts
    .attempt()
    .catch((err) => opts.onError(opts.id, err))
    .finally(() => opts.inFlight.delete(opts.id));
}

/** Polls every open position concurrently (SPEC.md section 8.1). */
export async function pollOpenPositions(opts: PollOpenPositionsOptions): Promise<void> {
  await Promise.all(
    opts.positions.map(async (position) => {
      try {
        const { result } = await pollPosition(position, opts.now, opts.cfg);
        if (result.action === "SELL") {
          opts.onSell(position.id, result.reason, result.newState);
        } else {
          await opts.onHold(position.id, result.newState, result.logs);
        }
      } catch (err) {
        opts.logger.error("Position poll failed", { positionId: position.id, error: String(err) });
      }
    }),
  );
}
