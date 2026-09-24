import { selectPair, type DexScreenerClient } from "../clients/dexscreener.js";
import { SOLANA_CHAIN_ID } from "../constants.js";
import { evaluatePhase1Gate, type GateCheckId } from "../gate/index.js";
import type { Logger } from "../logger/index.js";
import type { DexPair } from "../types.js";
import type { PendingStore } from "./pendingStore.js";

const PAIRS_BATCH_SIZE = 30;

export interface PollProfilesResult {
  discovered: number;
  skippedSeen: number;
  skippedOtherChain: number;
  /** False if the profiles fetch itself failed (for outage/health tracking). */
  ok: boolean;
}

/** SPEC.md section 4, bullet 1: fetch latest profiles, queue new Solana mints. */
export async function pollProfiles(opts: {
  dexClient: DexScreenerClient;
  store: PendingStore;
  now: number;
  seenMintsCap: number;
  logger: Logger;
}): Promise<PollProfilesResult> {
  const result: PollProfilesResult = { discovered: 0, skippedSeen: 0, skippedOtherChain: 0, ok: true };

  let profiles;
  try {
    profiles = await opts.dexClient.getLatestProfiles();
  } catch (err) {
    opts.logger.warn("Profile poll failed; will retry next cycle", { error: String(err) });
    result.ok = false;
    return result;
  }

  for (const profile of profiles) {
    if (profile.chainId !== SOLANA_CHAIN_ID) {
      result.skippedOtherChain++;
      continue;
    }
    if (opts.store.hasSeen(profile.tokenAddress)) {
      result.skippedSeen++;
      continue;
    }
    opts.store.markSeen(profile.tokenAddress, opts.now, opts.seenMintsCap);
    opts.store.addPending(profile.tokenAddress, opts.now);
    result.discovered++;
  }

  return result;
}

export interface RecheckPendingResult {
  checked: number;
  passed: number;
  removedPermanent: number;
  removedAged: number;
  skipReasons: Partial<Record<GateCheckId, number>>;
  /** Number of pair-fetch batches that failed (for outage/health tracking). */
  failedBatches: number;
}

/**
 * SPEC.md section 4, bullet 2-3: recheck every pending mint (batched, up to 30
 * addresses per DexScreener call) and apply checks 1-4. A mint leaves pending
 * on a permanent failure, MAX_PENDING_AGE_MIN, or MAX_NO_PAIR_CHECKS
 * consecutive no-pair checks. Phase 1 has no checks 5-8, so a mint that
 * "passed" checks 1-4 simply stays pending, re-evaluated every cycle.
 */
export async function recheckPending(opts: {
  dexClient: DexScreenerClient;
  store: PendingStore;
  now: number;
  allowedQuoteMints: readonly string[];
  minLiquidityUsd: number;
  entryWindowMin: number;
  maxPendingAgeMin: number;
  maxNoPairChecks: number;
  reentryEnabled: boolean;
  logger: Logger;
}): Promise<RecheckPendingResult> {
  const result: RecheckPendingResult = {
    checked: 0,
    passed: 0,
    removedPermanent: 0,
    removedAged: 0,
    skipReasons: {},
    failedBatches: 0,
  };

  const rows = opts.store.listPending();

  for (let i = 0; i < rows.length; i += PAIRS_BATCH_SIZE) {
    const batch = rows.slice(i, i + PAIRS_BATCH_SIZE);
    const addresses = batch.map((r) => r.mint);

    let pairs: DexPair[];
    try {
      pairs = await opts.dexClient.getPairs(SOLANA_CHAIN_ID, addresses);
    } catch (err) {
      opts.logger.warn("Pending recheck pairs fetch failed; batch retried next cycle", {
        error: String(err),
        batchSize: addresses.length,
      });
      result.failedBatches++;
      continue;
    }

    for (const row of batch) {
      result.checked++;

      if (opts.now - row.discoveredAt > opts.maxPendingAgeMin * 60_000) {
        opts.store.removePending(row.mint);
        result.removedAged++;
        continue;
      }

      const pair = selectPair(pairs, row.mint, opts.allowedQuoteMints);
      const gateResult = evaluatePhase1Gate({
        now: opts.now,
        isHeld: false,
        wasTradedBefore: false,
        reentryEnabled: opts.reentryEnabled,
        pair,
        minLiquidityUsd: opts.minLiquidityUsd,
        firstEligibleAt: row.firstEligibleAt,
        entryWindowMin: opts.entryWindowMin,
      });

      if (gateResult.outcome === "passed") {
        result.passed++;
        opts.store.updatePending(row.mint, {
          firstEligibleAt: gateResult.firstEligibleAt,
          lastCheckedAt: opts.now,
          noPairChecks: 0,
          lastGateResult: "passed",
        });
        continue;
      }

      result.skipReasons[gateResult.check] = (result.skipReasons[gateResult.check] ?? 0) + 1;

      if (gateResult.check === "pair") {
        const noPairChecks = row.noPairChecks + 1;
        if (noPairChecks >= opts.maxNoPairChecks) {
          opts.store.removePending(row.mint);
          result.removedPermanent++;
        } else {
          opts.store.updatePending(row.mint, {
            noPairChecks,
            lastCheckedAt: opts.now,
            lastGateResult: gateResult.reason,
          });
        }
        continue;
      }

      if (gateResult.outcome === "permanent_fail") {
        opts.store.removePending(row.mint);
        result.removedPermanent++;
        continue;
      }

      // Temporary failure other than "pair" (i.e. liquidity): stays pending.
      opts.store.updatePending(row.mint, {
        firstEligibleAt: gateResult.firstEligibleAt,
        lastCheckedAt: opts.now,
        noPairChecks: 0,
        lastGateResult: gateResult.reason,
      });
    }
  }

  return result;
}
