import type { Logger } from "./logger/index.js";

/** process, or a stand-in for tests. */
export interface ShutdownSource {
  on(event: "SIGINT" | "SIGTERM" | "message", listener: (...args: unknown[]) => void): unknown;
}

export interface ShutdownOptions {
  source: ShutdownSource;
  logger: Logger;
  /** SPEC.md section 16.11: 120 s, below pm2's kill_timeout (150 s). */
  boundMs: number;
  /** Stop new entries and new sell attempts, stop the loops. */
  stopNew: () => void;
  /** Wait for in-flight transactions (confirm, fail or expire) and paper fills; resolves true if everything finished within the bound. */
  waitForInFlight: (boundMs: number) => Promise<boolean>;
  /** Persist state and the heartbeat, close the database. */
  finalize: () => Promise<void> | void;
  exit: (code: number) => void;
}

/**
 * SPEC.md section 16.11 (A14): graceful shutdown on Ctrl+C (SIGINT), SIGTERM
 * (Linux), or pm2's `shutdown` message (Windows, where `pm2 stop` delivers no
 * signal; the ecosystem file sets shutdown_with_message). A second trigger
 * only logs; pm2's kill_timeout is the hard bound.
 */
export class ShutdownCoordinator {
  private started: Promise<void> | null = null;

  constructor(private readonly opts: ShutdownOptions) {}

  install(): void {
    this.opts.source.on("SIGINT", () => void this.trigger("SIGINT"));
    this.opts.source.on("SIGTERM", () => void this.trigger("SIGTERM"));
    this.opts.source.on("message", (msg: unknown) => {
      if (msg === "shutdown") void this.trigger("pm2 shutdown message");
    });
  }

  get inProgress(): boolean {
    return this.started !== null;
  }

  trigger(reason: string): Promise<void> {
    if (this.started) {
      this.opts.logger.warn(`Received ${reason} while already shutting down; still waiting for in-flight work`);
      return this.started;
    }
    this.started = this.run(reason);
    return this.started;
  }

  private async run(reason: string): Promise<void> {
    this.opts.logger.info(`Received ${reason}: stopping new entries and sell attempts, waiting for in-flight transactions`);
    this.opts.stopNew();
    let finished = false;
    try {
      finished = await this.opts.waitForInFlight(this.opts.boundMs);
    } catch (err) {
      this.opts.logger.error("Error while waiting for in-flight work during shutdown", { error: String(err) });
    }
    if (!finished) {
      this.opts.logger.warn(`Shutdown wait bound (${this.opts.boundMs} ms) reached; unresolved intents will be resolved on the next start`);
    }
    try {
      await this.opts.finalize();
    } catch (err) {
      this.opts.logger.error("Error while persisting state during shutdown", { error: String(err) });
    }
    this.opts.logger.info("Shutdown complete");
    this.opts.exit(0);
  }
}
