import { selectAllValidPairs, selectPair, type DexScreenerClient } from "../clients/dexscreener.js";
import { SOLANA_CHAIN_ID } from "../constants.js";
import {
  evaluateMomentumAndBuyPressure,
  evaluatePhase1Gate,
  type GateCheckId,
  type HoldersResult,
  type MintSafetyResult,
  type MomentumBuyPressureConfig,
} from "../gate/index.js";
import type { Logger } from "../logger/index.js";
import type { DexPair } from "../types.js";
import type { PendingRow, PendingStore } from "./pendingStore.js";

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
  /** Mints whose firstEligibleAt was newly set this call (crossed MIN_LIQUIDITY_USD for the first time). */
  eligible: number;
  /** Mints that passed all 8 checks this call (Phase 2 only; 0 without `phase2` deps). */
  ready: number;
  removedPermanent: number;
  removedAged: number;
  /**
   * Mint addresses that failed each check this call. The caller (digest funnel)
   * de-dupes these into a per-window Set so a mint re-evaluated every recheck
   * cycle is only counted once per reason, not once per evaluation.
   */
  skippedMints: Partial<Record<GateCheckId, string[]>>;
  /** Number of pair-fetch batches that failed (for outage/health tracking). */
  failedBatches: number;
  /** Mints removed this call that never reached READY (section 11.3: skip tracking). */
  removedNeverReady: Array<{ mint: string; reason: string }>;
}

export interface Phase2GateDeps {
  momentumBuyPressureCfg: MomentumBuyPressureConfig;
  /** Resolves from safety_cache (permanent) or fetches + caches via RPC on a miss (SPEC.md section 5, check 7). */
  getMintSafety: (mint: string) => Promise<MintSafetyResult>;
  /** Resolves from a HOLDERS_CACHE_MIN cache or fetches + caches via RPC on a miss (section 5, check 8). */
  getHolders: (mint: string, validPairs: readonly DexPair[]) => Promise<HoldersResult>;
  /** Score + JSON snapshot to store on the pending row once a mint reaches READY (section 6.1, section 6.2's cached snapshot). */
  computeSnapshot: (row: PendingRow, pair: DexPair, holders: HoldersResult) => { score: number; snapshotJson: string };
  /** Fired the first time a mint transitions to READY (section 11.2: every mint gets a shadow the first time it becomes READY). */
  onNewlyReady: (mint: string, pair: DexPair) => void;
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
  /** Checks 5-8 (Phase 2). Omit to keep Phase 1 behavior: checks 1-4 only, never READY. */
  phase2?: Phase2GateDeps;
}): Promise<RecheckPendingResult> {
  const result: RecheckPendingResult = {
    checked: 0,
    passed: 0,
    eligible: 0,
    ready: 0,
    removedPermanent: 0,
    removedAged: 0,
    skippedMints: {},
    failedBatches: 0,
    removedNeverReady: [],
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
        if (row.status !== "READY") result.removedNeverReady.push({ mint: row.mint, reason: "aged_out" });
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
        if (row.firstEligibleAt === null) result.eligible++;

        if (!opts.phase2) {
          opts.store.updatePending(row.mint, {
            firstEligibleAt: gateResult.firstEligibleAt,
            lastCheckedAt: opts.now,
            noPairChecks: 0,
            lastGateResult: "passed",
          });
          continue;
        }

        // Checks 5-6 (pair-data only, no RPC).
        const check56 = evaluateMomentumAndBuyPressure(pair!, opts.phase2.momentumBuyPressureCfg);
        if (!check56.passed) {
          (result.skippedMints[check56.check] ??= []).push(row.mint);
          opts.store.updatePending(row.mint, {
            firstEligibleAt: gateResult.firstEligibleAt,
            lastCheckedAt: opts.now,
            noPairChecks: 0,
            status: "pending",
            lastGateResult: check56.reason,
          });
          continue;
        }

        // Check 7 (permanent, cached forever): only reached once checks 1-6 clear, to avoid spending RPC budget on mints that would fail anyway.
        const safety = await opts.phase2.getMintSafety(row.mint);
        if (!safety.passed) {
          (result.skippedMints.mintSafety ??= []).push(row.mint);
          opts.store.removePending(row.mint);
          result.removedPermanent++;
          result.removedNeverReady.push({ mint: row.mint, reason: "mintSafety" });
          continue;
        }

        // Check 8 (temporary, cached HOLDERS_CACHE_MIN).
        const validPairs = selectAllValidPairs(pairs, row.mint, opts.allowedQuoteMints);
        const holders = await opts.phase2.getHolders(row.mint, validPairs);
        if (!holders.passed) {
          (result.skippedMints.holders ??= []).push(row.mint);
          opts.store.updatePending(row.mint, {
            firstEligibleAt: gateResult.firstEligibleAt,
            lastCheckedAt: opts.now,
            noPairChecks: 0,
            status: "pending",
            lastGateResult: holders.reason,
          });
          continue;
        }

        // All 8 checks passed: READY.
        result.ready++;
        const wasReady = row.status === "READY";
        const { snapshotJson } = opts.phase2.computeSnapshot(row, pair!, holders);
        opts.store.updatePending(row.mint, {
          firstEligibleAt: gateResult.firstEligibleAt,
          lastCheckedAt: opts.now,
          noPairChecks: 0,
          status: "READY",
          lastGateResult: "READY",
          snapshot: snapshotJson,
        });
        if (!wasReady) opts.phase2.onNewlyReady(row.mint, pair!);
        continue;
      }

      (result.skippedMints[gateResult.check] ??= []).push(row.mint);

      if (gateResult.check === "pair") {
        const noPairChecks = row.noPairChecks + 1;
        if (noPairChecks >= opts.maxNoPairChecks) {
          opts.store.removePending(row.mint);
          result.removedPermanent++;
          if (row.status !== "READY") result.removedNeverReady.push({ mint: row.mint, reason: "pair" });
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
        if (row.status !== "READY") result.removedNeverReady.push({ mint: row.mint, reason: gateResult.check });
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
