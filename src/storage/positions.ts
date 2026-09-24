import type { Db } from "./db.js";
import type { ExitState, HistoryPoint } from "../monitor/stateMachine.js";

export interface PositionRow {
  id: number;
  mode: string;
  mint: string;
  symbol: string | null;
  pairAddress: string | null;
  status: "open" | "closing";
  entryTime: number;
  sizeUsd: number;
  tokenAmount: number;
  costBasis: number;
  entryLiquidityUsd: number;
  entryPairSnapshot: unknown;
  score: number | null;
  scoreComponents: unknown;
  safetyResult: unknown;
  holdersResult: unknown;
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
  closingSince: number | null;
  /** The exit reason decided by the state machine (or "killed"), stored so the trade record is correct once the exit fill eventually succeeds. */
  pendingExitReason: string | null;
  lastPnlPct: number | null;
  lastValueUsd: number | null;
  lastPolledAt: number | null;
}

interface PositionRowDb {
  id: number;
  mode: string;
  mint: string;
  symbol: string | null;
  pair_address: string | null;
  status: string;
  entry_time: number;
  size_usd: number;
  token_amount: number;
  cost_basis: number;
  entry_liquidity_usd: number;
  entry_pair_snapshot: string | null;
  score: number | null;
  score_components: string | null;
  safety_result: string | null;
  holders_result: string | null;
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
  closing_since: number | null;
  pending_exit_reason: string | null;
  last_pnl_pct: number | null;
  last_value_usd: number | null;
  last_polled_at: number | null;
}

function fromDb(row: PositionRowDb): PositionRow {
  return {
    id: row.id,
    mode: row.mode,
    mint: row.mint,
    symbol: row.symbol,
    pairAddress: row.pair_address,
    status: row.status as "open" | "closing",
    entryTime: row.entry_time,
    sizeUsd: row.size_usd,
    tokenAmount: row.token_amount,
    costBasis: row.cost_basis,
    entryLiquidityUsd: row.entry_liquidity_usd,
    entryPairSnapshot: row.entry_pair_snapshot ? JSON.parse(row.entry_pair_snapshot) : null,
    score: row.score,
    scoreComponents: row.score_components ? JSON.parse(row.score_components) : null,
    safetyResult: row.safety_result ? JSON.parse(row.safety_result) : null,
    holdersResult: row.holders_result ? JSON.parse(row.holders_result) : null,
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
    closingSince: row.closing_since,
    pendingExitReason: row.pending_exit_reason,
    lastPnlPct: row.last_pnl_pct,
    lastValueUsd: row.last_value_usd,
    lastPolledAt: row.last_polled_at,
  };
}

export type NewPositionRow = Omit<PositionRow, "id">;
export type PositionPatch = Partial<Omit<PositionRow, "id" | "mode" | "mint" | "entryTime">>;

/** DB access for `positions` and `position_history` (SPEC.md section 12). */
export class PositionsStore {
  constructor(private readonly db: Db) {}

  insert(row: NewPositionRow): number {
    const info = this.db
      .prepare(
        `INSERT INTO positions (
          mode, mint, symbol, pair_address, status, entry_time, size_usd, token_amount, cost_basis,
          entry_liquidity_usd, entry_pair_snapshot, score, score_components, safety_result, holders_result,
          peak_pnl, current_target, target_extensions, timer_restarts, last_restart_at, deadline,
          trail_armed, fast_streak, low_liq_streak, no_route_since, closing_since, pending_exit_reason, last_pnl_pct, last_value_usd, last_polled_at
        ) VALUES (@mode, @mint, @symbol, @pair_address, @status, @entry_time, @size_usd, @token_amount, @cost_basis,
          @entry_liquidity_usd, @entry_pair_snapshot, @score, @score_components, @safety_result, @holders_result,
          @peak_pnl, @current_target, @target_extensions, @timer_restarts, @last_restart_at, @deadline,
          @trail_armed, @fast_streak, @low_liq_streak, @no_route_since, @closing_since, @pending_exit_reason, @last_pnl_pct, @last_value_usd, @last_polled_at)`,
      )
      .run({
        mode: row.mode,
        mint: row.mint,
        symbol: row.symbol,
        pair_address: row.pairAddress,
        status: row.status,
        entry_time: row.entryTime,
        size_usd: row.sizeUsd,
        token_amount: row.tokenAmount,
        cost_basis: row.costBasis,
        entry_liquidity_usd: row.entryLiquidityUsd,
        entry_pair_snapshot: row.entryPairSnapshot ? JSON.stringify(row.entryPairSnapshot) : null,
        score: row.score,
        score_components: row.scoreComponents ? JSON.stringify(row.scoreComponents) : null,
        safety_result: row.safetyResult ? JSON.stringify(row.safetyResult) : null,
        holders_result: row.holdersResult ? JSON.stringify(row.holdersResult) : null,
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
        closing_since: row.closingSince,
        pending_exit_reason: row.pendingExitReason,
        last_pnl_pct: row.lastPnlPct,
        last_value_usd: row.lastValueUsd,
        last_polled_at: row.lastPolledAt,
      });
    return Number(info.lastInsertRowid);
  }

  get(id: number): PositionRow | undefined {
    const row = this.db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as PositionRowDb | undefined;
    return row ? fromDb(row) : undefined;
  }

  listOpen(): PositionRow[] {
    return (this.db.prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY entry_time ASC").all() as PositionRowDb[]).map(fromDb);
  }

  listClosing(): PositionRow[] {
    return (this.db.prepare("SELECT * FROM positions WHERE status = 'closing' ORDER BY entry_time ASC").all() as PositionRowDb[]).map(fromDb);
  }

  listByMint(mint: string): PositionRow[] {
    return (this.db.prepare("SELECT * FROM positions WHERE mint = ? ORDER BY entry_time ASC").all(mint) as PositionRowDb[]).map(fromDb);
  }

  update(id: number, patch: PositionPatch): void {
    const current = this.get(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE positions SET symbol=@symbol, pair_address=@pair_address, status=@status, score=@score,
          score_components=@score_components, safety_result=@safety_result, holders_result=@holders_result,
          peak_pnl=@peak_pnl, current_target=@current_target, target_extensions=@target_extensions,
          timer_restarts=@timer_restarts, last_restart_at=@last_restart_at, deadline=@deadline,
          trail_armed=@trail_armed, fast_streak=@fast_streak, low_liq_streak=@low_liq_streak,
          no_route_since=@no_route_since, closing_since=@closing_since, pending_exit_reason=@pending_exit_reason, last_pnl_pct=@last_pnl_pct,
          last_value_usd=@last_value_usd, last_polled_at=@last_polled_at
        WHERE id=@id`,
      )
      .run({
        id,
        symbol: next.symbol,
        pair_address: next.pairAddress,
        status: next.status,
        score: next.score,
        score_components: next.scoreComponents ? JSON.stringify(next.scoreComponents) : null,
        safety_result: next.safetyResult ? JSON.stringify(next.safetyResult) : null,
        holders_result: next.holdersResult ? JSON.stringify(next.holdersResult) : null,
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
        closing_since: next.closingSince,
        pending_exit_reason: next.pendingExitReason,
        last_pnl_pct: next.lastPnlPct,
        last_value_usd: next.lastValueUsd,
        last_polled_at: next.lastPolledAt,
      });
  }

  remove(id: number): void {
    this.db.prepare("DELETE FROM position_history WHERE position_id = ?").run(id);
    this.db.prepare("DELETE FROM positions WHERE id = ?").run(id);
  }

  appendHistory(positionId: number, point: HistoryPoint): void {
    this.db.prepare("INSERT INTO position_history (position_id, t, pnl_pct) VALUES (?, ?, ?)").run(positionId, point.t, point.pnl);
  }

  /** SPEC.md section 8.5: on restart, history older than the fast window is ignored. */
  loadHistory(positionId: number, sinceT: number): HistoryPoint[] {
    const rows = this.db
      .prepare("SELECT t, pnl_pct FROM position_history WHERE position_id = ? AND t >= ? ORDER BY t ASC")
      .all(positionId, sinceT) as Array<{ t: number; pnl_pct: number }>;
    return rows.map((r) => ({ t: r.t, pnl: r.pnl_pct }));
  }
}

/** Reconstructs the pure ExitState from a persisted PositionRow + its loaded history (for restarts). */
export function positionRowToExitState(row: PositionRow, history: HistoryPoint[]): ExitState {
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
