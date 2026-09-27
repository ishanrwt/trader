import type { Db } from "./db.js";

/** SPEC.md section 11.5: one price path per mint and mode, from first READY. */
export interface PricePathRow {
  id: number;
  mint: string;
  mode: string;
  startedAt: number;
  endsAt: number;
  status: "recording" | "done";
  pairSnapshot: unknown;
  dexId: string | null;
  pairAgeMs: number | null;
  top1Pct: number | null;
  top10Pct: number | null;
  score: number | null;
  scoreComponents: unknown;
  selected: boolean;
  sellabilityLossPct: number | null;
  sellabilityCheckedAt: number | null;
  /** Time of the latest point, or null before the first one. */
  lastPointAt: number | null;
}

export type NewPricePath = Omit<PricePathRow, "id" | "status" | "selected" | "sellabilityLossPct" | "sellabilityCheckedAt" | "lastPointAt">;

export type PricePathGap = "no_pair" | "fetch_failed";

export interface PricePathPoint {
  t: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  buysM5: number | null;
  sellsM5: number | null;
  volumeM5: number | null;
  /** null for a normal point. */
  gap: PricePathGap | null;
}

interface PathDb {
  id: number;
  mint: string;
  mode: string;
  started_at: number;
  ends_at: number;
  status: string;
  pair_snapshot: string | null;
  dex_id: string | null;
  pair_age_ms: number | null;
  top1_pct: number | null;
  top10_pct: number | null;
  score: number | null;
  score_components: string | null;
  selected: number;
  sellability_loss_pct: number | null;
  sellability_checked_at: number | null;
  last_point_at: number | null;
}

function fromDb(r: PathDb): PricePathRow {
  return {
    id: r.id,
    mint: r.mint,
    mode: r.mode,
    startedAt: r.started_at,
    endsAt: r.ends_at,
    status: r.status as PricePathRow["status"],
    pairSnapshot: r.pair_snapshot ? JSON.parse(r.pair_snapshot) : null,
    dexId: r.dex_id,
    pairAgeMs: r.pair_age_ms,
    top1Pct: r.top1_pct,
    top10Pct: r.top10_pct,
    score: r.score,
    scoreComponents: r.score_components ? JSON.parse(r.score_components) : null,
    selected: r.selected === 1,
    sellabilityLossPct: r.sellability_loss_pct,
    sellabilityCheckedAt: r.sellability_checked_at,
    lastPointAt: r.last_point_at,
  };
}

const SELECT = "SELECT p.*, (SELECT MAX(t) FROM price_path_points q WHERE q.path_id = p.id) AS last_point_at FROM price_paths p";

/** DB access for `price_paths` and `price_path_points` (SPEC.md section 11.5). */
export class PricePathsStore {
  constructor(private readonly db: Db) {}

  /** Starts the mint's path for this mode unless it already has one; returns the new id, or null if one existed. */
  insertIfAbsent(p: NewPricePath): number | null {
    const info = this.db
      .prepare(
        `INSERT INTO price_paths (mint, mode, started_at, ends_at, pair_snapshot, dex_id, pair_age_ms, top1_pct, top10_pct, score, score_components)
         VALUES (@mint, @mode, @started_at, @ends_at, @pair_snapshot, @dex_id, @pair_age_ms, @top1_pct, @top10_pct, @score, @score_components)
         ON CONFLICT (mint, mode) DO NOTHING`,
      )
      .run({
        mint: p.mint,
        mode: p.mode,
        started_at: p.startedAt,
        ends_at: p.endsAt,
        pair_snapshot: p.pairSnapshot ? JSON.stringify(p.pairSnapshot) : null,
        dex_id: p.dexId,
        pair_age_ms: p.pairAgeMs,
        top1_pct: p.top1Pct,
        top10_pct: p.top10Pct,
        score: p.score,
        score_components: p.scoreComponents ? JSON.stringify(p.scoreComponents) : null,
      });
    return info.changes === 1 ? Number(info.lastInsertRowid) : null;
  }

  get(id: number): PricePathRow | undefined {
    const r = this.db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as PathDb | undefined;
    return r ? fromDb(r) : undefined;
  }

  getForMint(mint: string, mode: string): PricePathRow | undefined {
    const r = this.db.prepare(`${SELECT} WHERE p.mint = ? AND p.mode = ?`).get(mint, mode) as PathDb | undefined;
    return r ? fromDb(r) : undefined;
  }

  listRecording(): PricePathRow[] {
    return (this.db.prepare(`${SELECT} WHERE p.status = 'recording' ORDER BY p.started_at ASC`).all() as PathDb[]).map(fromDb);
  }

  countRecording(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM price_paths WHERE status = 'recording'").get() as { c: number }).c;
  }

  markDone(id: number): void {
    this.db.prepare("UPDATE price_paths SET status = 'done' WHERE id = ?").run(id);
  }

  addPoint(pathId: number, p: PricePathPoint): void {
    this.db
      .prepare(
        `INSERT INTO price_path_points (path_id, t, price_usd, liquidity_usd, buys_m5, sells_m5, volume_m5, gap)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(pathId, p.t, p.priceUsd, p.liquidityUsd, p.buysM5, p.sellsM5, p.volumeM5, p.gap);
  }

  listPoints(pathId: number): PricePathPoint[] {
    const rows = this.db.prepare("SELECT * FROM price_path_points WHERE path_id = ? ORDER BY t ASC, id ASC").all(pathId) as Array<{
      t: number;
      price_usd: number | null;
      liquidity_usd: number | null;
      buys_m5: number | null;
      sells_m5: number | null;
      volume_m5: number | null;
      gap: PricePathGap | null;
    }>;
    return rows.map((r) => ({ t: r.t, priceUsd: r.price_usd, liquidityUsd: r.liquidity_usd, buysM5: r.buys_m5, sellsM5: r.sells_m5, volumeM5: r.volume_m5, gap: r.gap }));
  }

  /** A position opened for the mint (any time, even after recording ended). */
  markSelected(mint: string, mode: string): void {
    this.db.prepare("UPDATE price_paths SET selected = 1 WHERE mint = ? AND mode = ?").run(mint, mode);
  }

  /** The latest sellability measurement for the mint, pass or fail. */
  setSellability(mint: string, mode: string, lossPct: number | null, checkedAt: number): void {
    this.db.prepare("UPDATE price_paths SET sellability_loss_pct = ?, sellability_checked_at = ? WHERE mint = ? AND mode = ?").run(lossPct, checkedAt, mint, mode);
  }
}
