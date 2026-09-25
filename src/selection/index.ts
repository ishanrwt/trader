import type { Logger } from "../logger/index.js";

export interface ReadyCandidate {
  mint: string;
  score: number;
  firstEligibleAt: number;
  liquidityUsd: number;
  priceUsd: number;
  /** When this candidate's snapshot (pair data + score) was last refreshed by a recheck cycle. */
  lastCheckedAt: number;
}

export interface PickNextCandidateOptions {
  minScore: number;
  now: number;
  pendingRecheckSeconds: number;
  /** Mints with an entry attempt already under way. */
  inFlight: ReadonlySet<string>;
}

/**
 * SPEC.md section 6.2 step 1: the READY mint with the highest score >=
 * MIN_SCORE (tie-break: earlier firstEligibleAt), skipping mints already
 * entering and mints whose cached snapshot is too stale to trust (more than
 * 2x PENDING_RECHECK_SECONDS old) until the next recheck refreshes it.
 */
export function pickNextCandidate(candidates: readonly ReadyCandidate[], opts: PickNextCandidateOptions): ReadyCandidate | null {
  const staleCutoffMs = 2 * opts.pendingRecheckSeconds * 1000;
  const eligible = candidates.filter(
    (c) => c.score >= opts.minScore && !opts.inFlight.has(c.mint) && opts.now - c.lastCheckedAt <= staleCutoffMs,
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => b.score - a.score || a.firstEligibleAt - b.firstEligibleAt);
  return eligible[0]!;
}

export function computePositionSizeUsd(positionUsd: number, liquidityUsd: number, maxPositionPctOfLiq: number): number {
  return Math.min(positionUsd, liquidityUsd * (maxPositionPctOfLiq / 100));
}

/** One sellability check (section 6.2): pass/fail plus the measured round-trip loss (null if the check errored). */
export interface SellabilityResult {
  passed: boolean;
  roundTripLossPct: number | null;
}

/** A sellability result as cached and carried into the entry: what was measured, and when (SPEC.md section 11.1). */
export interface SellabilityMeasurement extends SellabilityResult {
  checkedAt: number;
}

/** What slot filling hands the executor for one entry. */
export interface EntryExecution {
  tokens: number;
  sizeUsd: number;
  sellability: { roundTripLossPct: number | null; checkedAt: number };
}

export interface SlotFillingDeps {
  now: number;
  maxConcurrent: number;
  minScore: number;
  pendingRecheckSeconds: number;
  maxEntryDriftPct: number;
  candidates: readonly ReadyCandidate[];
  openPositionsCount: number;
  /** Mints with an entry attempt already under way; mutated as attempts start/finish. */
  inFlight: Set<string>;
  /**
   * Keyed by mint AND size: the round-trip loss depends on the size quoted, so a
   * measurement taken at one size is never reused for an entry at another.
   */
  getSellabilityCache: (mint: string, sizeUsd: number, now: number) => SellabilityMeasurement | undefined;
  setSellabilityCache: (mint: string, sizeUsd: number, result: SellabilityMeasurement, now: number) => void;
  /** Jupiter entry lane: USDC->token then token->USDC round trip. */
  checkSellability: (mint: string, sizeUsd: number) => Promise<SellabilityResult>;
  /** Jupiter entry lane: the execution quote used for the drift check and the fill. */
  getExecutionQuote: (mint: string, sizeUsd: number) => Promise<{ tokensOut: number } | null>;
  positionSizeUsd: (candidate: ReadyCandidate) => number;
  paperFeeUsdPerTx: number;
  canAfford: (usdcAmount: number) => boolean;
  /** Kicks off the paper entry fill; not awaited inline (mirrors the exit-fill non-blocking rule — see monitor/index.ts). */
  openPosition: (candidate: ReadyCandidate, execution: EntryExecution) => Promise<void>;
  /** Removes the mint from pending (section 4) and marks its shadow unsellable (section 11.2). */
  markUnsellable: (mint: string) => void;
  entryBlocked: () => boolean;
  logger: Logger;
}

/**
 * SPEC.md section 6.2: slot filling. No dependency here can close a position
 * — "never close an open position to make room for a candidate" is enforced
 * structurally, not just by convention.
 */
export async function runSlotFilling(deps: SlotFillingDeps): Promise<void> {
  let openCount = deps.openPositionsCount;
  const candidates = [...deps.candidates];

  while (openCount < deps.maxConcurrent) {
    if (deps.entryBlocked()) break;

    const pick = pickNextCandidate(candidates, {
      minScore: deps.minScore,
      now: deps.now,
      pendingRecheckSeconds: deps.pendingRecheckSeconds,
      inFlight: deps.inFlight,
    });
    if (!pick) break;

    // Remove from this pass's pool so a rejected candidate isn't retried within the same call.
    candidates.splice(candidates.indexOf(pick), 1);

    const sizeUsd = deps.positionSizeUsd(pick);

    let sellability = deps.getSellabilityCache(pick.mint, sizeUsd, deps.now);
    if (sellability === undefined) {
      sellability = { ...(await deps.checkSellability(pick.mint, sizeUsd)), checkedAt: deps.now };
      deps.setSellabilityCache(pick.mint, sizeUsd, sellability, deps.now);
    }
    if (!sellability.passed) {
      deps.markUnsellable(pick.mint); // permanent failure; falls through to the next candidate
      continue;
    }

    const execQuote = await deps.getExecutionQuote(pick.mint, sizeUsd);
    if (!execQuote) {
      deps.logger.warn("Slot filling: no execution quote this pass", { mint: pick.mint });
      continue;
    }

    const impliedPrice = sizeUsd / execQuote.tokensOut;
    if (impliedPrice > pick.priceUsd * (1 + deps.maxEntryDriftPct / 100)) {
      deps.logger.info("Slot filling: entry drift skip (temporary, stays READY)", { mint: pick.mint });
      continue;
    }

    if (!deps.canAfford(sizeUsd + deps.paperFeeUsdPerTx)) {
      deps.logger.warn("Slot filling: insufficient virtual wallet balance", { mint: pick.mint });
      continue;
    }

    deps.inFlight.add(pick.mint);
    openCount += 1; // reserve the slot so the next loop iteration doesn't double-fill it
    void deps
      .openPosition(pick, {
        tokens: execQuote.tokensOut,
        sizeUsd,
        sellability: { roundTripLossPct: sellability.roundTripLossPct, checkedAt: sellability.checkedAt },
      })
      .catch((err) => deps.logger.error("Slot filling: open position failed", { mint: pick.mint, error: String(err) }))
      .finally(() => deps.inFlight.delete(pick.mint));
  }
}
