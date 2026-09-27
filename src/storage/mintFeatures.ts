import type { RugFeatures } from "../tracking/rugFeatures.js";
import type { Db } from "./db.js";

/** A stored `mint_features` row (SPEC.md section 11.6). */
export interface MintFeaturesRow extends RugFeatures {
  mint: string;
  mode: string;
  recordedAt: number;
}

interface Row {
  mint: string;
  mode: string;
  recorded_at: number;
  pool_program: string | null;
  pool_canonical: number | null;
  pump_migrated: number | null;
  lp_supply_pool: string | null;
  lp_mint_supply: string | null;
  lp_status: string | null;
  lp_burned_pct: number | null;
  lp_locked_pct: number | null;
  lp_withdrawable_pct: number | null;
  holder_count: number | null;
  sniper_share_pct: number | null;
  sniper_slots: number | null;
  sniper_txs: number | null;
  sniper_capped: number | null;
  creator: string | null;
  creator_holding_pct: number | null;
  rugcheck_score: number | null;
  rugcheck_score_normalised: number | null;
  rugcheck_lp_locked_pct: number | null;
  rugcheck_risks: string | null;
  reasons: string;
  credits_used: number;
}

const bool = (v: number | null) => (v === null ? null : v === 1);
const int = (v: boolean | null) => (v === null ? null : v ? 1 : 0);

/** DB access for `mint_features` (SPEC.md section 11.6). */
export class MintFeaturesStore {
  constructor(private readonly db: Db) {}

  has(mint: string, mode: string): boolean {
    return this.db.prepare("SELECT 1 FROM mint_features WHERE mint = ? AND mode = ?").get(mint, mode) !== undefined;
  }

  /** One row per mint and mode; a second insert for the same mint is ignored. */
  insertIfAbsent(mint: string, mode: string, recordedAt: number, f: RugFeatures): boolean {
    const info = this.db
      .prepare(
        `INSERT INTO mint_features (mint, mode, recorded_at, pool_program, pool_canonical, pump_migrated, lp_supply_pool, lp_mint_supply, lp_status,
           lp_burned_pct, lp_locked_pct, lp_withdrawable_pct, holder_count, sniper_share_pct, sniper_slots, sniper_txs, sniper_capped, creator,
           creator_holding_pct, rugcheck_score, rugcheck_score_normalised, rugcheck_lp_locked_pct, rugcheck_risks, reasons, credits_used)
         VALUES (@mint, @mode, @recorded_at, @pool_program, @pool_canonical, @pump_migrated, @lp_supply_pool, @lp_mint_supply, @lp_status,
           @lp_burned_pct, @lp_locked_pct, @lp_withdrawable_pct, @holder_count, @sniper_share_pct, @sniper_slots, @sniper_txs, @sniper_capped, @creator,
           @creator_holding_pct, @rugcheck_score, @rugcheck_score_normalised, @rugcheck_lp_locked_pct, @rugcheck_risks, @reasons, @credits_used)
         ON CONFLICT (mint, mode) DO NOTHING`,
      )
      .run({
        mint,
        mode,
        recorded_at: recordedAt,
        pool_program: f.poolProgram,
        pool_canonical: int(f.poolCanonical),
        pump_migrated: int(f.pumpMigrated),
        lp_supply_pool: f.lpSupplyPool,
        lp_mint_supply: f.lpMintSupply,
        lp_status: f.lpStatus,
        lp_burned_pct: f.lpBurnedPct,
        lp_locked_pct: f.lpLockedPct,
        lp_withdrawable_pct: f.lpWithdrawablePct,
        holder_count: f.holderCount,
        sniper_share_pct: f.sniperSharePct,
        sniper_slots: f.sniperSlots,
        sniper_txs: f.sniperTxs,
        sniper_capped: int(f.sniperCapped),
        creator: f.creator,
        creator_holding_pct: f.creatorHoldingPct,
        rugcheck_score: f.rugcheckScore,
        rugcheck_score_normalised: f.rugcheckScoreNormalised,
        rugcheck_lp_locked_pct: f.rugcheckLpLockedPct,
        rugcheck_risks: f.rugcheckRisks === null || f.rugcheckRisks === undefined ? null : JSON.stringify(f.rugcheckRisks),
        reasons: JSON.stringify(f.reasons),
        credits_used: f.creditsUsed,
      });
    return info.changes === 1;
  }

  listAll(mode?: string): MintFeaturesRow[] {
    const rows = (mode
      ? this.db.prepare("SELECT * FROM mint_features WHERE mode = ? ORDER BY recorded_at ASC").all(mode)
      : this.db.prepare("SELECT * FROM mint_features ORDER BY recorded_at ASC").all()) as Row[];
    return rows.map((r) => ({
      mint: r.mint,
      mode: r.mode,
      recordedAt: r.recorded_at,
      poolProgram: r.pool_program,
      poolCanonical: bool(r.pool_canonical),
      pumpMigrated: bool(r.pump_migrated),
      lpSupplyPool: r.lp_supply_pool,
      lpMintSupply: r.lp_mint_supply,
      lpStatus: r.lp_status as MintFeaturesRow["lpStatus"],
      lpBurnedPct: r.lp_burned_pct,
      lpLockedPct: r.lp_locked_pct,
      lpWithdrawablePct: r.lp_withdrawable_pct,
      holderCount: r.holder_count,
      sniperSharePct: r.sniper_share_pct,
      sniperSlots: r.sniper_slots,
      sniperTxs: r.sniper_txs,
      sniperCapped: bool(r.sniper_capped),
      creator: r.creator,
      creatorHoldingPct: r.creator_holding_pct,
      rugcheckScore: r.rugcheck_score,
      rugcheckScoreNormalised: r.rugcheck_score_normalised,
      rugcheckLpLockedPct: r.rugcheck_lp_locked_pct,
      rugcheckRisks: r.rugcheck_risks ? JSON.parse(r.rugcheck_risks) : null,
      reasons: JSON.parse(r.reasons),
      creditsUsed: r.credits_used,
    }));
  }
}
