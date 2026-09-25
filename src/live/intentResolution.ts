import type { IntentRow } from "../storage/intents.js";
import { classifyStatus } from "./confirm.js";
import type { SignatureStatus } from "./txRpc.js";

export interface ResolutionRpc {
  getSignatureStatuses(signatures: readonly string[], searchTransactionHistory: boolean): Promise<SignatureStatus[]>;
  getBlockHeight(): Promise<number>;
  getTransaction(signature: string): Promise<Record<string, unknown> | null>;
}

export type Resolution =
  | { kind: "landed"; tx: Record<string, unknown> }
  | { kind: "failed"; tx: Record<string, unknown> }
  | { kind: "expired" }
  | { kind: "abandoned"; reason: string }
  /** Not landed and not yet expired (or the RPC doesn't have the transaction body yet): keep resending and confirming. */
  | { kind: "in_flight" };

/**
 * SPEC.md section 16.5: resolves one unresolved intent by its signature status
 * (searchTransactionHistory=true). Runs on startup for every unresolved
 * intent and before any retry or rebuild for that position and side.
 *
 * - pending (never signed): nothing can have been sent -> abandoned.
 * - signed/sent/landed: found and confirmed -> landed (with the transaction); found
 *   with an error -> failed (with the transaction, for its fee); not found and the
 *   block height is past lastValidBlockHeight -> expired (sent) or abandoned
 *   (signed but never handed to the RPC); otherwise still in flight.
 */
export async function resolveIntent(intent: IntentRow, rpc: ResolutionRpc): Promise<Resolution> {
  if (intent.status === "pending") return { kind: "abandoned", reason: "reserved but never signed" };
  if (!intent.signature || intent.lastValidBlockHeight === null) {
    // A signed/sent intent always has these (markSigned sets them together); anything else is corrupt: don't guess.
    return { kind: "in_flight" };
  }
  const [status] = await rpc.getSignatureStatuses([intent.signature], true);
  const c = classifyStatus(status ?? null);
  if (c === "landed" || c === "failed") {
    const tx = await rpc.getTransaction(intent.signature);
    if (!tx) return { kind: "in_flight" }; // confirmed but the body isn't queryable yet: try again later
    return c === "landed" ? { kind: "landed", tx } : { kind: "failed", tx };
  }
  if (c === "pending") return { kind: "in_flight" };
  const height = await rpc.getBlockHeight();
  if (height <= intent.lastValidBlockHeight) return { kind: "in_flight" };
  return intent.status === "signed" ? { kind: "abandoned", reason: "signed but never sent; blockhash expired" } : { kind: "expired" };
}
