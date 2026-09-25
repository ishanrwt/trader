import type { Db } from "./db.js";
import type { ExitState, HistoryPoint } from "../monitor/stateMachine.js";

export type ShadowOutcome = "open" | "selected" | "unsellable" | "closed";

export interface ShadowRow {
  id: number;
  mint: string;
  symbol: string | null;
  pairAddress: string | null;
  outcome: ShadowOutcome;
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
}

export type NewShadowRow = Omit<ShadowRow, "id">;
export type ShadowPatch = Partial<Omit<ShadowRow, "id" | "mint" | "entryTime">>;

interface ShadowRowDb {
  id: number;
  mint: string;
  symbol: string | null;
  pair_address: string | null;
  outcome: string;
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
}

function fromDb(row: ShadowRowDb): ShadowRow {
  return {
    id: row.id,
    mint: row.mint,
    symbol: row.symbol,
    pairAddress: row.pair_address,
    outcome: row.outcome as ShadowOutcome,
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
  };
}

/** DB access for `shadows` (SPEC.md section 11.2). */
export class ShadowsStore {
  constructor(private readonly db: Db) {}

  insert(row: NewShadowRow): number {
    const info = this.db
      .prepare(
        `INSERT INTO shadows (
          mint, symbol, pair_address, outcome, entry_time, cost_basis, token_amount, entry_liquidity_usd, entry_price_usd,
          score, score_components, peak_pnl, current_target, target_extensions, timer_restarts, last_restart_at,
          deadline, trail_armed, fast_streak, low_liq_streak, no_route_since, exit_time, exit_reason, proceeds, net_pnl_usd, net_pnl_pct, mode
        ) VALUES (@mint, @symbol, @pair_address, @outcome, @entry_time, @cost_basis, @token_amount, @entry_liquidity_usd, @entry_price_usd,
          @score, @score_components, @peak_pnl, @current_target, @target_extensions, @timer_restarts, @last_restart_at,
          @deadline, @trail_armed, @fast_streak, @low_liq_streak, @no_route_since, @exit_time, @exit_reason, @proceeds, @net_pnl_usd, @net_pnl_pct, @mode)`,
      )
      .run({
        mint: row.mint,
        symbol: row.symbol,
        pair_address: row.pairAddress,
        outcome: row.outcome,
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
    return Number(info.lastInsertRowid);
  }

  get(id: number): ShadowRow | undefined {
    const row = this.db.prepare("SELECT * FROM shadows WHERE id = ?").get(id) as ShadowRowDb | undefined;
    return row ? fromDb(row) : undefined;
  }

  getOpenByMint(mint: string): ShadowRow | undefined {
    const row = this.db.prepare("SELECT * FROM shadows WHERE mint = ? AND outcome = 'open' ORDER BY entry_time DESC LIMIT 1").get(mint) as
      | ShadowRowDb
      | undefined;
    return row ? fromDb(row) : undefined;
  }

  listOpen(): ShadowRow[] {
    return (this.db.prepare("SELECT * FROM shadows WHERE outcome = 'open' ORDER BY entry_time ASC").all() as ShadowRowDb[]).map(fromDb);
  }

  countOpen(): number {
    const { c } = this.db.prepare("SELECT COUNT(*) as c FROM shadows WHERE outcome = 'open'").get() as { c: number };
    return c;
  }

  listAll(): ShadowRow[] {
    return (this.db.prepare("SELECT * FROM shadows ORDER BY entry_time ASC").all() as ShadowRowDb[]).map(fromDb);
  }

  update(id: number, patch: ShadowPatch): void {
    const current = this.get(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE shadows SET symbol=@symbol, pair_address=@pair_address, outcome=@outcome, score=@score, score_components=@score_components,
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
