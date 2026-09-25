import type { Db } from "./db.js";

export interface FeeLossRow {
  id: number;
  mode: string;
  ts: number;
  tradingDay: string;
  mint: string;
  positionId: number | null;
  intentId: number | null;
  signature: string | null;
  kind: string;
  lamports: number;
  usd: number;
  solPriceUsd: number | null;
}

export type NewFeeLossRow = Omit<FeeLossRow, "id">;

/**
 * DB access for `fee_losses` (SPEC.md section 16.3): network fees paid by
 * transactions that landed but failed on-chain. Realized losses that count in
 * daily loss and the report, never in a trade's PnL.
 */
export class FeeLossesStore {
  constructor(private readonly db: Db) {}

  insert(row: NewFeeLossRow): number {
    const info = this.db
      .prepare(
        `INSERT INTO fee_losses (mode, ts, trading_day, mint, position_id, intent_id, signature, kind, lamports, usd, sol_price_usd)
         VALUES (@mode, @ts, @trading_day, @mint, @position_id, @intent_id, @signature, @kind, @lamports, @usd, @sol_price_usd)`,
      )
      .run({
        mode: row.mode,
        ts: row.ts,
        trading_day: row.tradingDay,
        mint: row.mint,
        position_id: row.positionId,
        intent_id: row.intentId,
        signature: row.signature,
        kind: row.kind,
        lamports: row.lamports,
        usd: row.usd,
        sol_price_usd: row.solPriceUsd,
      });
    return Number(info.lastInsertRowid);
  }

  sumUsdForDay(mode: string, tradingDay: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(usd), 0) AS s FROM fee_losses WHERE mode = ? AND trading_day = ?").get(mode, tradingDay) as { s: number };
    return r.s;
  }

  listAll(opts: { mode?: string; from?: string; to?: string } = {}): FeeLossRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.mode) {
      clauses.push("mode = @mode");
      params.mode = opts.mode;
    }
    if (opts.from) {
      clauses.push("trading_day >= @from");
      params.from = opts.from;
    }
    if (opts.to) {
      clauses.push("trading_day <= @to");
      params.to = opts.to;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM fee_losses ${where} ORDER BY ts ASC`).all(params) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      mode: r.mode as string,
      ts: r.ts as number,
      tradingDay: r.trading_day as string,
      mint: r.mint as string,
      positionId: r.position_id as number | null,
      intentId: r.intent_id as number | null,
      signature: r.signature as string | null,
      kind: r.kind as string,
      lamports: r.lamports as number,
      usd: r.usd as number,
      solPriceUsd: r.sol_price_usd as number | null,
    }));
  }
}
