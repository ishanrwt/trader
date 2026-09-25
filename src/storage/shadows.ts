import type { Db } from "./db.js";
import type { ExitState, HistoryPoint } from "../monitor/stateMachine.js";

/** Lifecycle only (SPEC.md section 11.2): open shadows are polled until the exit state machine closes them. */
export type ShadowOutcome = "open" | "closed";
/** Classification, independent of lifecycle: selected shadows keep being priced until they close. */
export type ShadowClassification = "unselected" | "selected" | "unsellable";

export interface ShadowRow {
  id: number;
  mint: string;
  symbol: string | null;
  pairAddress: string | null;
  outcome: ShadowOutcome;
  classification: ShadowClassification;
  entryTime: number;
  costBasis: number;
  tokenAmount: number;
  entryLiquidityUsd: number;
  entryPriceUsd: number;
  score: number | null;
  scoreComponents: unknown;
  peakPnl: number;
  currentTarget: number;
  targetExtensions: number;
  timerRestarts: number;
  lastRestartAt: number | null;
  deadline: number;
  trailArmed: boolean;
  fastStreak: number;
  lowLiqStreak: number;
  noRouteSince: number | null;
  exitTime: number | null;
  exitReason: string | null;
  proceeds: number | null;
  netPnlUsd: number | null;
  netPnlPct: number | null;
  /** The mode of the run that created this shadow (SPEC.md section 11.2); rows from before Phase 3 are paper. */
  mode?: string;
  /** Set only on rows from before migration 0007 that duplicated an earlier shadow of the same mint and mode: the id of the one kept. */
  duplicateOf?: number | null;
}

/** New shadows start unselected unless given a classification. */
export type NewShadowRow = Omit<ShadowRow, "id" | "duplicateOf" | "classification"> & { classification?: ShadowClassification };
export type ShadowPatch = Partial<Omit<ShadowRow, "id" | "mint" | "entryTime">>;

interface ShadowRowDb {
  id: number;
  mint: string;
  symbol: string | null;
  pair_address: string | null;
  outcome: string;
  classification: string;
  entry_time: number;
  cost_basis: number;
  token_amount: number;
  entry_liquidity_usd: number;
  entry_price_usd: number;
  score: number | null;
  score_components: string | null;
  peak_pnl: number;
  current_target: number;
  target_extensions: number;
  timer_restarts: number;
  last_restart_at: number | null;
  deadline: number;
  trail_armed: number;
  fast_streak: number;
  low_liq_streak: number;
  no_route_since: number | null;
  exit_time: number | null;
  exit_reason: string | null;
  proceeds: number | null;
  net_pnl_usd: number | null;
  net_pnl_pct: number | null;
  mode: string;
  duplicate_of: number | null;
}

function fromDb(row: ShadowRowDb): ShadowRow {
  return {
    id: row.id,
    mint: row.mint,
    symbol: row.symbol,
    pairAddress: row.pair_address,
    outcome: row.outcome as ShadowOutcome,
    classification: row.classification as ShadowClassification,
    entryTime: row.entry_time,
    costBasis: row.cost_basis,
    tokenAmount: row.token_amount,
    entryLiquidityUsd: row.entry_liquidity_usd,
    entryPriceUsd: row.entry_price_usd,
    score: row.score,
    scoreComponents: row.score_components ? JSON.parse(row.score_components) : null,
    peakPnl: row.peak_pnl,
    currentTarget: row.current_target,
    targetExtensions: row.target_extensions,
    timerRestarts: row.timer_restarts,
    lastRestartAt: row.last_restart_at,
    deadline: row.deadline,
    trailArmed: row.trail_armed === 1,
    fastStreak: row.fast_streak,
    lowLiqStreak: row.low_liq_streak,
    noRouteSince: row.no_route_since,
    exitTime: row.exit_time,
    exitReason: row.exit_reason,
    proceeds: row.proceeds,
    netPnlUsd: row.net_pnl_usd,
    netPnlPct: row.net_pnl_pct,
    mode: row.mode,
    duplicateOf: row.duplicate_of,
  };
}

/**
 * Every read below except get(id) excludes rows marked duplicate_of (SPEC.md
 * section 11.2), so no caller — the shadow poll, the cap, selection marking,
 * or the report — can see a duplicate.
 */
const NOT_DUPLICATE = "duplicate_of IS NULL";

/** DB access for `shadows` (SPEC.md section 11.2). */
export class ShadowsStore {
  constructor(private readonly db: Db) {}

  /** Inserts a shadow. Throws (SQLITE_CONSTRAINT) if this mint and mode already has one; production code uses insertIfAbsent. */
  insert(row: NewShadowRow): number {
    return Number(this.run(row, "").lastInsertRowid);
  }

  /**
   * Inserts the mint's shadow for its mode unless it already has one, and
   * returns the new id, or null if one existed. The unique index makes this
   * safe even when two processes race (SPEC.md section 11.2).
   */
  insertIfAbsent(row: NewShadowRow): number | null {
    const info = this.run(row, " ON CONFLICT (mint, mode) WHERE duplicate_of IS NULL DO NOTHING");
    return info.changes === 1 ? Number(info.lastInsertRowid) : null;
  }

  private run(row: NewShadowRow, onConflict: string) {
    return this.db
      .prepare(
        `INSERT INTO shadows (
          mint, symbol, pair_address, outcome, classification, entry_time, cost_basis, token_amount, entry_liquidity_usd, entry_price_usd,
          score, score_components, peak_pnl, current_target, target_extensions, timer_restarts, last_restart_at,
          deadline, trail_armed, fast_streak, low_liq_streak, no_route_since, exit_time, exit_reason, proceeds, net_pnl_usd, net_pnl_pct, mode
        ) VALUES (@mint, @symbol, @pair_address, @outcome, @classification, @entry_time, @cost_basis, @token_amount, @entry_liquidity_usd, @entry_price_usd,
          @score, @score_components, @peak_pnl, @current_target, @target_extensions, @timer_restarts, @last_restart_at,
          @deadline, @trail_armed, @fast_streak, @low_liq_streak, @no_route_since, @exit_time, @exit_reason, @proceeds, @net_pnl_usd, @net_pnl_pct, @mode)${onConflict}`,
      )
      .run({
        mint: row.mint,
        symbol: row.symbol,
        pair_address: row.pairAddress,
        outcome: row.outcome,
        classification: row.classification ?? "unselected",
        entry_time: row.entryTime,
        cost_basis: row.costBasis,
        token_amount: row.tokenAmount,
        entry_liquidity_usd: row.entryLiquidityUsd,
        entry_price_usd: row.entryPriceUsd,
        score: row.score,
        score_components: row.scoreComponents ? JSON.stringify(row.scoreComponents) : null,
        peak_pnl: row.peakPnl,
        current_target: row.currentTarget,
        target_extensions: row.targetExtensions,
        timer_restarts: row.timerRestarts,
        last_restart_at: row.lastRestartAt,
        deadline: row.deadline,
        trail_armed: row.trailArmed ? 1 : 0,
        fast_streak: row.fastStreak,
        low_liq_streak: row.lowLiqStreak,
        no_route_since: row.noRouteSince,
        exit_time: row.exitTime,
        exit_reason: row.exitReason,
        proceeds: row.proceeds,
        mode: row.mode ?? "paper",
        net_pnl_usd: row.netPnlUsd,
        net_pnl_pct: row.netPnlPct,
      });
  }

  get(id: number): ShadowRow | undefined {
    const row = this.db.prepare("SELECT * FROM shadows WHERE id = ?").get(id) as ShadowRowDb | undefined;
    return row ? fromDb(row) : undefined;
  }

  /** The mint's one shadow for this mode, in any outcome (SPEC.md section 11.2). */
  getForMint(mint: string, mode: string): ShadowRow | undefined {
    const row = this.db.prepare(`SELECT * FROM shadows WHERE mint = ? AND mode = ? AND ${NOT_DUPLICATE}`).get(mint, mode) as ShadowRowDb | undefined;
    return row ? fromDb(row) : undefined;
  }

  listOpen(): ShadowRow[] {
    return (this.db.prepare(`SELECT * FROM shadows WHERE outcome = 'open' AND ${NOT_DUPLICATE} ORDER BY entry_time ASC`).all() as ShadowRowDb[]).map(fromDb);
  }

  countOpen(): number {
    const { c } = this.db.prepare(`SELECT COUNT(*) as c FROM shadows WHERE outcome = 'open' AND ${NOT_DUPLICATE}`).get() as { c: number };
    return c;
  }

  listAll(): ShadowRow[] {
    return (this.db.prepare(`SELECT * FROM shadows WHERE ${NOT_DUPLICATE} ORDER BY entry_time ASC`).all() as ShadowRowDb[]).map(fromDb);
  }

  update(id: number, patch: ShadowPatch): void {
    const current = this.get(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE shadows SET symbol=@symbol, pair_address=@pair_address, outcome=@outcome, classification=@classification, score=@score, score_components=@score_components,
          peak_pnl=@peak_pnl, current_target=@current_target, target_extensions=@target_extensions, timer_restarts=@timer_restarts,
          last_restart_at=@last_restart_at, deadline=@deadline, trail_armed=@trail_armed, fast_streak=@fast_streak,
          low_liq_streak=@low_liq_streak, no_route_since=@no_route_since, exit_time=@exit_time, exit_reason=@exit_reason,
          proceeds=@proceeds, net_pnl_usd=@net_pnl_usd, net_pnl_pct=@net_pnl_pct
        WHERE id=@id`,
      )
      .run({
        id,
        symbol: next.symbol,
        pair_address: next.pairAddress,
        outcome: next.outcome,
        classification: next.classification,
        score: next.score,
        score_components: next.scoreComponents ? JSON.stringify(next.scoreComponents) : null,
        peak_pnl: next.peakPnl,
        current_target: next.currentTarget,
        target_extensions: next.targetExtensions,
        timer_restarts: next.timerRestarts,
        last_restart_at: next.lastRestartAt,
        deadline: next.deadline,
        trail_armed: next.trailArmed ? 1 : 0,
        fast_streak: next.fastStreak,
        low_liq_streak: next.lowLiqStreak,
        no_route_since: next.noRouteSince,
        exit_time: next.exitTime,
        exit_reason: next.exitReason,
        proceeds: next.proceeds,
        net_pnl_usd: next.netPnlUsd,
        net_pnl_pct: next.netPnlPct,
      });
  }
}

export function shadowRowToExitState(row: ShadowRow, history: HistoryPoint[]): ExitState {
  return {
    entryTime: row.entryTime,
    entryLiquidity: row.entryLiquidityUsd,
    peakPnl: row.peakPnl,
    currentTarget: row.currentTarget,
    targetExtensions: row.targetExtensions,
    timerRestarts: row.timerRestarts,
    lastRestartAt: row.lastRestartAt,
    deadline: row.deadline,
    trailArmed: row.trailArmed,
    fastStreak: row.fastStreak,
    lowLiqStreak: row.lowLiqStreak,
    noRouteSince: row.noRouteSince,
    history,
  };
}
