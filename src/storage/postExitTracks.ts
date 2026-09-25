import type { Db } from "./db.js";

export interface PostExitTrackRow {
  id: number;
  tradeId: number;
  mint: string;
  exitTime: number;
  exitPriceUsd: number | null;
  /** Section 11.3: 'dexscreener_at_exit' (fetched at exit), or 'entry_snapshot' for rows recorded before that fix (not a valid exit price). */
  exitPriceSource: string | null;
  price15mUsd: number | null;
  price30mUsd: number | null;
  price60mUsd: number | null;
  resolved: boolean;
}

export type NewPostExitTrackRow = Omit<PostExitTrackRow, "id" | "resolved" | "price15mUsd" | "price30mUsd" | "price60mUsd">;

interface PostExitTrackRowDb {
  id: number;
  trade_id: number;
  mint: string;
  exit_time: number;
  exit_price_usd: number | null;
  exit_price_source: string | null;
  price_15m_usd: number | null;
  price_30m_usd: number | null;
  price_60m_usd: number | null;
  resolved: number;
}

function fromDb(row: PostExitTrackRowDb): PostExitTrackRow {
  return {
    id: row.id,
    tradeId: row.trade_id,
    mint: row.mint,
    exitTime: row.exit_time,
    exitPriceUsd: row.exit_price_usd,
    exitPriceSource: row.exit_price_source,
    price15mUsd: row.price_15m_usd,
    price30mUsd: row.price_30m_usd,
    price60mUsd: row.price_60m_usd,
    resolved: row.resolved === 1,
  };
}

/** DB access for `post_exit_tracks` (SPEC.md section 11.3). */
export class PostExitTracksStore {
  constructor(private readonly db: Db) {}

  insert(row: NewPostExitTrackRow): number {
    const info = this.db
      .prepare(
        "INSERT INTO post_exit_tracks (trade_id, mint, exit_time, exit_price_usd, exit_price_source, price_15m_usd, price_30m_usd, price_60m_usd, resolved) VALUES (@trade_id, @mint, @exit_time, @exit_price_usd, @exit_price_source, NULL, NULL, NULL, 0)",
      )
      .run({ trade_id: row.tradeId, mint: row.mint, exit_time: row.exitTime, exit_price_usd: row.exitPriceUsd, exit_price_source: row.exitPriceSource });
    return Number(info.lastInsertRowid);
  }

  listUnresolved(): PostExitTrackRow[] {
    return (this.db.prepare("SELECT * FROM post_exit_tracks WHERE resolved = 0 ORDER BY exit_time ASC").all() as PostExitTrackRowDb[]).map(fromDb);
  }

  listAll(): PostExitTrackRow[] {
    return (this.db.prepare("SELECT * FROM post_exit_tracks ORDER BY exit_time ASC").all() as PostExitTrackRowDb[]).map(fromDb);
  }

  setPrice15m(id: number, price: number): void {
    this.db.prepare("UPDATE post_exit_tracks SET price_15m_usd = ? WHERE id = ?").run(price, id);
  }

  setPrice30m(id: number, price: number): void {
    this.db.prepare("UPDATE post_exit_tracks SET price_30m_usd = ? WHERE id = ?").run(price, id);
  }

  setPrice60mAndResolve(id: number, price: number): void {
    this.db.prepare("UPDATE post_exit_tracks SET price_60m_usd = ?, resolved = 1 WHERE id = ?").run(price, id);
  }
}
