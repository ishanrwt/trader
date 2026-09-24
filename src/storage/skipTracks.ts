import type { Db } from "./db.js";

export interface SkipTrackRow {
  id: number;
  mint: string;
  skipReason: string;
  discoveredAt: number;
  skippedAt: number;
  priceAtSkipUsd: number | null;
  price15mUsd: number | null;
  price60mUsd: number | null;
  resolved: boolean;
}

export type NewSkipTrackRow = Omit<SkipTrackRow, "id" | "resolved" | "price15mUsd" | "price60mUsd">;

interface SkipTrackRowDb {
  id: number;
  mint: string;
  skip_reason: string;
  discovered_at: number;
  skipped_at: number;
  price_at_skip_usd: number | null;
  price_15m_usd: number | null;
  price_60m_usd: number | null;
  resolved: number;
}

function fromDb(row: SkipTrackRowDb): SkipTrackRow {
  return {
    id: row.id,
    mint: row.mint,
    skipReason: row.skip_reason,
    discoveredAt: row.discovered_at,
    skippedAt: row.skipped_at,
    priceAtSkipUsd: row.price_at_skip_usd,
    price15mUsd: row.price_15m_usd,
    price60mUsd: row.price_60m_usd,
    resolved: row.resolved === 1,
  };
}

/** DB access for `skip_tracks` (SPEC.md section 11.3). */
export class SkipTracksStore {
  constructor(private readonly db: Db) {}

  insert(row: NewSkipTrackRow): number {
    const info = this.db
      .prepare(
        "INSERT INTO skip_tracks (mint, skip_reason, discovered_at, skipped_at, price_at_skip_usd, price_15m_usd, price_60m_usd, resolved) VALUES (@mint, @skip_reason, @discovered_at, @skipped_at, @price_at_skip_usd, NULL, NULL, 0)",
      )
      .run({
        mint: row.mint,
        skip_reason: row.skipReason,
        discovered_at: row.discoveredAt,
        skipped_at: row.skippedAt,
        price_at_skip_usd: row.priceAtSkipUsd,
      });
    return Number(info.lastInsertRowid);
  }

  listUnresolved(): SkipTrackRow[] {
    return (this.db.prepare("SELECT * FROM skip_tracks WHERE resolved = 0 ORDER BY skipped_at ASC").all() as SkipTrackRowDb[]).map(fromDb);
  }

  listAll(): SkipTrackRow[] {
    return (this.db.prepare("SELECT * FROM skip_tracks ORDER BY skipped_at ASC").all() as SkipTrackRowDb[]).map(fromDb);
  }

  countInWindow(sinceMs: number): number {
    const { c } = this.db.prepare("SELECT COUNT(*) as c FROM skip_tracks WHERE skipped_at >= ?").get(sinceMs) as { c: number };
    return c;
  }

  setPrice15m(id: number, price: number): void {
    this.db.prepare("UPDATE skip_tracks SET price_15m_usd = ? WHERE id = ?").run(price, id);
  }

  setPrice60mAndResolve(id: number, price: number): void {
    this.db.prepare("UPDATE skip_tracks SET price_60m_usd = ?, resolved = 1 WHERE id = ?").run(price, id);
  }
}
