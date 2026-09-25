import type { Db } from "./db.js";

export type IntentKind = "buy" | "sell" | "smoke";
export type IntentSide = "buy" | "sell";
/**
 * pending  - reserved before anything is built (the one-transaction guard)
 * signed   - built, verified and signed; signature and bytes persisted; not yet sent
 * sent     - handed to the RPC for broadcast at least once
 * landed   - confirmed on-chain with no error, not yet applied to positions/trades
 * applied  - landed and applied (final)
 * failed   - landed with an on-chain error; fee recorded as a fee loss (final)
 * expired  - sent, never landed, blockhash expired (final)
 * abandoned- never reached the network (refused, errored, or signed-but-unsent past expiry) (final)
 */
export type IntentStatus = "pending" | "signed" | "sent" | "landed" | "applied" | "failed" | "expired" | "abandoned";

/** SPEC.md section 16.4 / addition A: every status that blocks a second transaction for the same position and side. */
export const UNRESOLVED_STATUSES: readonly IntentStatus[] = ["pending", "signed", "sent", "landed"];

export interface IntentRow {
  id: number;
  kind: IntentKind;
  mode: string;
  mint: string;
  positionId: number | null;
  refKey: string;
  side: IntentSide;
  status: IntentStatus;
  signature: string | null;
  signedTxB64: string | null;
  lastValidBlockHeight: number | null;
  inputMint: string;
  outputMint: string;
  expectedInRaw: string | null;
  expectedOutRaw: string | null;
  minOutRaw: string | null;
  payload: unknown;
  feeLamports: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  resolvedAt: number | null;
}

interface IntentRowDb {
  id: number;
  kind: string;
  mode: string;
  mint: string;
  position_id: number | null;
  ref_key: string;
  side: string;
  status: string;
  signature: string | null;
  signed_tx_b64: string | null;
  last_valid_block_height: number | null;
  input_mint: string;
  output_mint: string;
  expected_in_raw: string | null;
  expected_out_raw: string | null;
  min_out_raw: string | null;
  payload: string | null;
  fee_lamports: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  resolved_at: number | null;
}

function fromDb(r: IntentRowDb): IntentRow {
  return {
    id: r.id,
    kind: r.kind as IntentKind,
    mode: r.mode,
    mint: r.mint,
    positionId: r.position_id,
    refKey: r.ref_key,
    side: r.side as IntentSide,
    status: r.status as IntentStatus,
    signature: r.signature,
    signedTxB64: r.signed_tx_b64,
    lastValidBlockHeight: r.last_valid_block_height,
    inputMint: r.input_mint,
    outputMint: r.output_mint,
    expectedInRaw: r.expected_in_raw,
    expectedOutRaw: r.expected_out_raw,
    minOutRaw: r.min_out_raw,
    payload: r.payload ? JSON.parse(r.payload) : null,
    feeLamports: r.fee_lamports,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sentAt: r.sent_at,
    resolvedAt: r.resolved_at,
  };
}

/** Thrown when a second transaction is attempted for a position/side that already has an unresolved intent. */
export class DuplicateIntentError extends Error {
  constructor(readonly refKey: string, readonly side: IntentSide) {
    super(`An unresolved transaction intent already exists for ${refKey} (${side}); refusing a second one.`);
    this.name = "DuplicateIntentError";
  }
}

export function sellRefKey(positionId: number): string {
  return `pos:${positionId}`;
}
export function buyRefKey(mint: string): string {
  return `mint:${mint}`;
}

export interface ReserveIntentInput {
  kind: IntentKind;
  mode: string;
  mint: string;
  positionId: number | null;
  refKey: string;
  side: IntentSide;
  inputMint: string;
  outputMint: string;
  payload?: unknown;
  now: number;
}

/**
 * DB access for `tx_intents` (SPEC.md section 16.5). The one-transaction guard
 * (section 16.4, addition A) is the partial unique index in 0004_live.sql over
 * every unresolved status; reserve() turns a violation into DuplicateIntentError.
 */
export class IntentsStore {
  constructor(private readonly db: Db) {}

  /** Step 1, before building: reserve the position/side. Throws DuplicateIntentError if one is already unresolved. */
  reserve(input: ReserveIntentInput): number {
    try {
      const info = this.db
        .prepare(
          `INSERT INTO tx_intents (kind, mode, mint, position_id, ref_key, side, status, input_mint, output_mint, payload, created_at, updated_at)
           VALUES (@kind, @mode, @mint, @position_id, @ref_key, @side, 'pending', @input_mint, @output_mint, @payload, @now, @now)`,
        )
        .run({
          kind: input.kind,
          mode: input.mode,
          mint: input.mint,
          position_id: input.positionId,
          ref_key: input.refKey,
          side: input.side,
          input_mint: input.inputMint,
          output_mint: input.outputMint,
          payload: input.payload === undefined ? null : JSON.stringify(input.payload),
          now: input.now,
        });
      return Number(info.lastInsertRowid);
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
        throw new DuplicateIntentError(input.refKey, input.side);
      }
      throw err;
    }
  }

  /** The guard's read side: true if any intent in an unresolved status exists for this position/side. */
  hasUnresolved(refKey: string, side: IntentSide): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM tx_intents WHERE ref_key = ? AND side = ? AND status IN ('pending','signed','sent','landed') LIMIT 1`)
      .get(refKey, side);
    return row !== undefined;
  }

  /**
   * The guard, checked again right before signing (addition A): the intent must
   * still be `pending` and be the only unresolved one for its position/side.
   */
  assertSoleUnresolved(id: number): void {
    const intent = this.get(id);
    if (!intent || intent.status !== "pending") {
      throw new DuplicateIntentError(intent?.refKey ?? `intent:${id}`, intent?.side ?? "sell");
    }
    const others = this.db
      .prepare(`SELECT COUNT(*) AS n FROM tx_intents WHERE ref_key = ? AND side = ? AND id != ? AND status IN ('pending','signed','sent','landed')`)
      .get(intent.refKey, intent.side, id) as { n: number };
    if (others.n > 0) throw new DuplicateIntentError(intent.refKey, intent.side);
  }

  /** Step 2, before sending: persist the signature, signed bytes, expiry height and expected amounts. */
  markSigned(
    id: number,
    s: { signature: string; signedTxB64: string; lastValidBlockHeight: number; expectedInRaw: string; expectedOutRaw: string; minOutRaw: string; payload?: unknown },
    now: number,
  ): void {
    this.db
      .prepare(
        `UPDATE tx_intents SET status='signed', signature=@signature, signed_tx_b64=@signed_tx_b64,
          last_valid_block_height=@lvbh, expected_in_raw=@in, expected_out_raw=@out, min_out_raw=@min,
          payload=COALESCE(@payload, payload), updated_at=@now
         WHERE id=@id AND status='pending'`,
      )
      .run({
        id,
        signature: s.signature,
        signed_tx_b64: s.signedTxB64,
        lvbh: s.lastValidBlockHeight,
        in: s.expectedInRaw,
        out: s.expectedOutRaw,
        min: s.minOutRaw,
        payload: s.payload === undefined ? null : JSON.stringify(s.payload),
        now,
      });
  }

  markSent(id: number, now: number): void {
    this.db.prepare(`UPDATE tx_intents SET status='sent', sent_at=COALESCE(sent_at, @now), updated_at=@now WHERE id=@id AND status IN ('signed','sent')`).run({ id, now });
  }

  markLanded(id: number, now: number): void {
    this.db.prepare(`UPDATE tx_intents SET status='landed', updated_at=@now WHERE id=@id AND status IN ('signed','sent')`).run({ id, now });
  }

  /** Final states. */
  resolve(id: number, status: "applied" | "failed" | "expired" | "abandoned", now: number, extra: { feeLamports?: number; error?: string } = {}): void {
    this.db
      .prepare(`UPDATE tx_intents SET status=@status, fee_lamports=COALESCE(@fee, fee_lamports), error=COALESCE(@error, error), updated_at=@now, resolved_at=@now WHERE id=@id`)
      .run({ id, status, fee: extra.feeLamports ?? null, error: extra.error ?? null, now });
  }

  get(id: number): IntentRow | undefined {
    const r = this.db.prepare("SELECT * FROM tx_intents WHERE id = ?").get(id) as IntentRowDb | undefined;
    return r ? fromDb(r) : undefined;
  }

  listUnresolved(mode?: string): IntentRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM tx_intents WHERE status IN ('pending','signed','sent','landed') ${mode ? "AND mode = @mode" : ""} ORDER BY id ASC`)
      .all(mode ? { mode } : {}) as IntentRowDb[];
    return rows.map(fromDb);
  }

  listByStatusSince(sinceTs: number): IntentRow[] {
    return (this.db.prepare("SELECT * FROM tx_intents WHERE updated_at >= ? ORDER BY id ASC").all(sinceTs) as IntentRowDb[]).map(fromDb);
  }
}
