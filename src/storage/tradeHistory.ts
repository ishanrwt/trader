import type { Db } from "./db.js";
import type { HistoryPoint } from "../monitor/stateMachine.js";

/**
 * DB access for `trade_history` (SPEC.md sections 11.1/12): a trade's
 * position_history, copied here (not deleted) when the position closes, so
 * it survives past PositionsStore.remove().
 */
export class TradeHistoryStore {
  constructor(private readonly db: Db) {}

  insertMany(tradeId: number, points: readonly HistoryPoint[]): void {
    if (points.length === 0) return;
    const insert = this.db.prepare("INSERT INTO trade_history (trade_id, t, pnl_pct) VALUES (?, ?, ?)");
    const insertAll = this.db.transaction((rows: readonly HistoryPoint[]) => {
      for (const p of rows) insert.run(tradeId, p.t, p.pnl);
    });
    insertAll(points);
  }

  listForTrade(tradeId: number): HistoryPoint[] {
    const rows = this.db.prepare("SELECT t, pnl_pct FROM trade_history WHERE trade_id = ? ORDER BY t ASC").all(tradeId) as Array<{
      t: number;
      pnl_pct: number;
    }>;
    return rows.map((r) => ({ t: r.t, pnl: r.pnl_pct }));
  }
}
