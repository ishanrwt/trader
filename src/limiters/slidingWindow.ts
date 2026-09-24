import { sleep, systemClock, type Clock } from "./clock.js";

/**
 * At most `maxPerWindow` calls in any `windowMs` sliding window, and at least
 * `minIntervalMs` between consecutive calls. Used directly for DexScreener
 * profiles/pairs and RPC; also the physical layer under the Jupiter budget.
 */
export class SlidingWindowLimiter {
  private readonly timestamps: number[] = [];
  private readonly clock: Clock;

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs = 60_000,
    private readonly minIntervalMs = 0,
    clock: Clock = systemClock,
  ) {
    this.clock = clock;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
  }

  /** Milliseconds to wait before the next call is allowed; 0 if it can go now. */
  waitMs(now: number = this.clock.now()): number {
    this.prune(now);
    let wait = 0;
    if (this.timestamps.length >= this.maxPerWindow) {
      const oldest = this.timestamps[0]!;
      wait = Math.max(wait, oldest + this.windowMs - now);
    }
    if (this.minIntervalMs > 0 && this.timestamps.length > 0) {
      const last = this.timestamps[this.timestamps.length - 1]!;
      wait = Math.max(wait, last + this.minIntervalMs - now);
    }
    return Math.max(0, wait);
  }

  /** Records a call at `now`. Call this once the call is actually made. */
  record(now: number = this.clock.now()): void {
    this.prune(now);
    this.timestamps.push(now);
  }

  count(now: number = this.clock.now()): number {
    this.prune(now);
    return this.timestamps.length;
  }

  /** Waits until allowed, records the call, then resolves. For production call sites. */
  async acquire(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      const wait = this.waitMs(now);
      if (wait <= 0) {
        this.record(now);
        return;
      }
      await sleep(wait);
    }
  }
}
