import { systemClock, type Clock } from "./clock.js";
import { SlidingWindowLimiter } from "./slidingWindow.js";

export type RpcLane = "tx" | "read";

/**
 * SPEC.md section 16.10: the RPC limiter with two lanes. Every call still
 * counts against one RPC_MAX_RPS window, but whenever calls from both lanes
 * are waiting, transaction-lane calls (live balance reads, simulate, send,
 * status, block height, getTransaction) are served before read-lane calls
 * (gate checks, reconciliation). Within a lane, calls are served in order.
 */
export class LaneLimiter {
  private readonly inner: SlidingWindowLimiter;
  private readonly queues: Record<RpcLane, Array<() => void>> = { tx: [], read: [] };
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    maxPerWindow: number,
    windowMs = 1_000,
    private readonly clock: Clock = systemClock,
  ) {
    this.inner = new SlidingWindowLimiter(maxPerWindow, windowMs, 0, clock);
  }

  acquire(lane: RpcLane): Promise<void> {
    return new Promise((resolve) => {
      this.queues[lane].push(resolve);
      this.pump();
    });
  }

  /** A `{ acquire() }` view for one lane, so existing clients that take a limiter work unchanged. */
  lane(lane: RpcLane): { acquire(): Promise<void> } {
    return { acquire: () => this.acquire(lane) };
  }

  pending(): { tx: number; read: number } {
    return { tx: this.queues.tx.length, read: this.queues.read.length };
  }

  private pump(): void {
    if (this.timer !== null) return;
    for (;;) {
      const queue = this.queues.tx.length > 0 ? this.queues.tx : this.queues.read;
      if (queue.length === 0) return;
      const now = this.clock.now();
      const wait = this.inner.waitMs(now);
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.pump();
        }, wait);
        return;
      }
      this.inner.record(now);
      queue.shift()!();
    }
  }
}
