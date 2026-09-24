import { systemClock, type Clock } from "./clock.js";

export interface JupiterLaneBudgetOptions {
  /** JUPITER_MAX_REQ_PER_MIN. */
  jupiterMaxReqPerMin: number;
  /** Precomputed MAX_CONCURRENT * ceil(60/POLL_SECONDS) + EXIT_RESERVE_EXTRA_PER_MIN. */
  exitReserve: number;
  windowMs?: number;
  clock?: Clock;
}

/**
 * Tracks Jupiter's exit and entry lanes separately over a 60s sliding window
 * (SPEC.md section 9.3, as corrected):
 *
 *   - The exit lane always goes first and is never blocked by entry usage.
 *   - An entry-lane call may proceed only if:
 *       exitUsed + entryUsed + max(0, exitReserve - exitUsed) < JUPITER_MAX_REQ_PER_MIN
 *
 * Both lanes still go through the physical SlidingWindowLimiter for the actual
 * fetch (JUPITER_MAX_REQ_PER_MIN + JUPITER_MIN_INTERVAL_MS) — this class only
 * decides lane admission, i.e. whether an entry-lane call is even attempted.
 */
export class JupiterLaneBudget {
  private readonly exitTimestamps: number[] = [];
  private readonly entryTimestamps: number[] = [];
  private readonly windowMs: number;
  private readonly clock: Clock;
  private deferredEntryCount = 0;

  constructor(private readonly opts: JupiterLaneBudgetOptions) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.clock = opts.clock ?? systemClock;
  }

  private prune(arr: number[], now: number): void {
    const cutoff = now - this.windowMs;
    while (arr.length > 0 && arr[0]! < cutoff) {
      arr.shift();
    }
  }

  private usage(now: number): { exitUsed: number; entryUsed: number } {
    this.prune(this.exitTimestamps, now);
    this.prune(this.entryTimestamps, now);
    return { exitUsed: this.exitTimestamps.length, entryUsed: this.entryTimestamps.length };
  }

  usageSnapshot(now: number = this.clock.now()): { exitUsed: number; entryUsed: number } {
    return this.usage(now);
  }

  /** Exit-lane calls are never gated — record them unconditionally. */
  recordExit(now: number = this.clock.now()): void {
    this.prune(this.exitTimestamps, now);
    this.exitTimestamps.push(now);
  }

  canEnterNow(now: number = this.clock.now()): boolean {
    const { exitUsed, entryUsed } = this.usage(now);
    const reserved = Math.max(0, this.opts.exitReserve - exitUsed);
    return exitUsed + entryUsed + reserved < this.opts.jupiterMaxReqPerMin;
  }

  recordEntry(now: number = this.clock.now()): void {
    this.prune(this.entryTimestamps, now);
    this.entryTimestamps.push(now);
  }

  /** Call when an entry-lane request was skipped for lack of budget. */
  recordDeferredEntry(): void {
    this.deferredEntryCount += 1;
  }

  /** Returns the deferred-entry count and resets it (for the digest's health section). */
  takeDeferredEntryCount(): number {
    const count = this.deferredEntryCount;
    this.deferredEntryCount = 0;
    return count;
  }
}
