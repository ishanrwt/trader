import type { SignatureStatus } from "./txRpc.js";

export type TxOutcome = "landed" | "failed" | "expired";

export type StatusClass = "landed" | "failed" | "pending" | "unknown";

/** SPEC.md section 16.4: confirmed or finalized with no error = landed; with an error = failed on-chain (fee paid). */
export function classifyStatus(s: SignatureStatus): StatusClass {
  if (s === null) return "unknown";
  if (s.err !== null && s.err !== undefined) return "failed";
  if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return "landed";
  return "pending";
}

export interface ConfirmRpc {
  getSignatureStatuses(signatures: readonly string[], searchTransactionHistory: boolean): Promise<SignatureStatus[]>;
  getBlockHeight(): Promise<number>;
  /** Resends the same signed bytes (same signature: never a second transaction). */
  resend(base64Tx: string): Promise<void>;
}

export interface ConfirmationPoolOptions {
  rpc: ConfirmRpc;
  pollMs: number;
  /** Resend interval: 2 x TX_CONFIRM_POLL_SECONDS (section 16.4). */
  resendEveryMs: number;
  /** Start checking the block height once a status has stayed empty this long (section 16.4: 30 s). */
  blockHeightAfterMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onError?: (err: unknown) => void;
}

interface Entry {
  signature: string;
  signedTxB64: string;
  lastValidBlockHeight: number;
  startedAt: number;
  lastSendAt: number;
  resolve: (o: TxOutcome) => void;
}

/**
 * SPEC.md section 16.4 (A8). Every TX_CONFIRM_POLL_SECONDS, ONE
 * getSignatureStatuses call covers every in-flight signature. Signed bytes
 * are resent every 2 polls. A transaction is expired only when: its status
 * has stayed empty, the block height is past its lastValidBlockHeight, and
 * one final getSignatureStatuses with searchTransactionHistory=true still
 * doesn't find it. If that final lookup finds it, it's landed (or failed),
 * never expired, so the caller never rebuilds a transaction that landed.
 */
export class ConfirmationPool {
  private readonly entries = new Map<string, Entry>();
  private running = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: ConfirmationPoolOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Tracks a signature that has already been sent once (the caller sent it right after persisting the intent). */
  track(t: { signature: string; signedTxB64: string; lastValidBlockHeight: number }): Promise<TxOutcome> {
    const existing = this.entries.get(t.signature);
    if (existing) return new Promise((resolve) => {
      const prev = existing.resolve;
      existing.resolve = (o) => { prev(o); resolve(o); };
    });
    return new Promise((resolve) => {
      const now = this.now();
      this.entries.set(t.signature, { ...t, startedAt: now, lastSendAt: now, resolve });
      if (!this.running) void this.loop();
    });
  }

  inFlight(): number {
    return this.entries.size;
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (this.entries.size > 0) {
        await this.sleep(this.opts.pollMs);
        try {
          await this.tick();
        } catch (err) {
          this.opts.onError?.(err); // transient RPC failure: try again next poll
        }
      }
    } finally {
      this.running = false;
    }
  }

  private finish(e: Entry, outcome: TxOutcome): void {
    this.entries.delete(e.signature);
    e.resolve(outcome);
  }

  async tick(): Promise<void> {
    const list = [...this.entries.values()];
    if (list.length === 0) return;
    const statuses = await this.opts.rpc.getSignatureStatuses(list.map((e) => e.signature), false);
    const now = this.now();
    const unknownOld: Entry[] = [];
    list.forEach((e, i) => {
      const c = classifyStatus(statuses[i] ?? null);
      if (c === "landed" || c === "failed") return this.finish(e, c);
      if (c === "unknown" && now - e.startedAt >= this.opts.blockHeightAfterMs) unknownOld.push(e);
    });

    if (unknownOld.length > 0) {
      const height = await this.opts.rpc.getBlockHeight();
      const past = unknownOld.filter((e) => height > e.lastValidBlockHeight);
      if (past.length > 0) {
        const final = await this.opts.rpc.getSignatureStatuses(past.map((e) => e.signature), true);
        past.forEach((e, i) => {
          const c = classifyStatus(final[i] ?? null);
          if (c === "landed" || c === "failed") this.finish(e, c);
          else if (c === "unknown") this.finish(e, "expired");
          // "pending" (processed but not confirmed) past expiry: keep polling until it confirms or drops.
        });
      }
    }

    for (const e of this.entries.values()) {
      if (now - e.lastSendAt >= this.opts.resendEveryMs) {
        e.lastSendAt = now;
        await this.opts.rpc.resend(e.signedTxB64).catch((err) => this.opts.onError?.(err));
      }
    }
  }
}
