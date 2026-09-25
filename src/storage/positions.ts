import type { Db } from "./db.js";
import type { ExitState, HistoryPoint } from "../monitor/stateMachine.js";

export type StuckState = "stuck" | "budget_exhausted";

/**
 * Live-mode fields (SPEC.md sections 11.1, 16.3, 16.6). Paper positions leave
 * them at their defaults. Raw amounts are large-integer strings.
 */
export interface PositionLiveFields {
  tokenProgram: string | null;
  tokenAccount: string | null;
  /** The token account's raw balance as last known from the chain (confirmed entry, then reconciliation). */
  tokenAmountRaw: string | null;
  entrySignature: string | null;
  entryUsdcRaw: string | null;
  entryFeeLamports: number | null;
  entryRentLamports: number | null;
  entrySolPriceUsd: number | null;
  sellAttempts: number;
  /** Failed sell attempts (simulation/verification refusal, no route, on-chain failure, expiry). */
  sellFailures: number;
  /** Network fees paid by this position's sell attempts (failed and landed), for the fee budget. */
  sellFeesLamports: number;
  failedSellFeesLamports: number;
  /** Current sell fee budget; null = SELL_FEE_BUDGET_SOL. /sellretry raises it. */
  sellBudgetLamports: number | null;
  stuckState: StuckState | null;
  stuckSince: number | null;
  nextSellAt: number | null;
  /** Whether full sells still append closeAccount (cleared after a close-only simulation failure). */
  closeAta: boolean;
}

export const DEFAULT_LIVE_FIELDS: PositionLiveFields = {
  tokenProgram: null,
  tokenAccount: null,
  tokenAmountRaw: null,
  entrySignature: null,
  entryUsdcRaw: null,
  entryFeeLamports: null,
  entryRentLamports: null,
  entrySolPriceUsd: null,
  sellAttempts: 0,
  sellFailures: 0,
  sellFeesLamports: 0,
  failedSellFeesLamports: 0,
  sellBudgetLamports: null,
  stuckState: null,
  stuckSince: null,
  nextSellAt: null,
  closeAta: true,
};

export interface PositionRow extends PositionLiveFields {
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
  /** The mint's decimals, as read from getTokenSupply at whatever point it was learned (holders check or the entry fill's quote). Null if never learned. */
  tokenDecimals: number | null;
  /** pnlPct from the first exit-lane quote fetched immediately after the entry fill (SPEC.md section 8.1's true entry-time mark) — null if that quote failed. */
  entryValuationPnlPct: number | null;
  /** Raw (pre-decimal-adjustment) Jupiter quote amounts for the entry fill, as returned by the API (large-integer strings). */
  entryQuoteInAmount: string | null;
  entryQuoteOutAmount: string | null;
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
  token_decimals: number | null;
  entry_valuation_pnl_pct: number | null;
  entry_quote_in_amount: string | null;
  entry_quote_out_amount: string | null;
  token_program: string | null;
  token_account: string | null;
  token_amount_raw: string | null;
  entry_signature: string | null;
  entry_usdc_raw: string | null;
  entry_fee_lamports: number | null;
  entry_rent_lamports: number | null;
  entry_sol_price_usd: number | null;
  sell_attempts: number;
  sell_failures: number;
  sell_fees_lamports: number;
  failed_sell_fees_lamports: number;
  sell_budget_lamports: number | null;
  stuck_state: string | null;
  stuck_since: number | null;
  next_sell_at: number | null;
  close_ata: number;
}

function fromDb(row: PositionRowDb): PositionRow {
  return {
    tokenProgram: row.token_program,
    tokenAccount: row.token_account,
    tokenAmountRaw: row.token_amount_raw,
    entrySignature: row.entry_signature,
    entryUsdcRaw: row.entry_usdc_raw,
    entryFeeLamports: row.entry_fee_lamports,
    entryRentLamports: row.entry_rent_lamports,
    entrySolPriceUsd: row.entry_sol_price_usd,
    sellAttempts: row.sell_attempts,
    sellFailures: row.sell_failures,
    sellFeesLamports: row.sell_fees_lamports,
    failedSellFeesLamports: row.failed_sell_fees_lamports,
    sellBudgetLamports: row.sell_budget_lamports,
    stuckState: row.stuck_state as StuckState | null,
    stuckSince: row.stuck_since,
    nextSellAt: row.next_sell_at,
    closeAta: row.close_ata === 1,
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
    tokenDecimals: row.token_decimals,
    entryValuationPnlPct: row.entry_valuation_pnl_pct,
    entryQuoteInAmount: row.entry_quote_in_amount,
    entryQuoteOutAmount: row.entry_quote_out_amount,
  };
}

/** Live fields are optional on insert (paper positions omit them; they default per DEFAULT_LIVE_FIELDS). */
export type NewPositionRow = Omit<PositionRow, "id" | keyof PositionLiveFields> & Partial<PositionLiveFields>;
/** tokenDecimals/entryValuationPnlPct/entryQuote* are write-once at insert time, like mode/mint/entryTime — update() never touches them. */
export type PositionPatch = Partial<
  Omit<
    PositionRow,
    "id" | "mode" | "mint" | "entryTime" | "tokenDecimals" | "entryValuationPnlPct" | "entryQuoteInAmount" | "entryQuoteOutAmount" | keyof PositionLiveFields
  >
>;

/** Live sell/reconciliation bookkeeping (SPEC.md sections 16.5, 16.6). `tokenAmount` is included because reconciliation adopts the on-chain amount. */
export type PositionLivePatch = Partial<Omit<PositionLiveFields, "entrySignature" | "entryUsdcRaw" | "entryFeeLamports" | "entryRentLamports" | "entrySolPriceUsd">> & {
  tokenAmount?: number;
};

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
          trail_armed, fast_streak, low_liq_streak, no_route_since, closing_since, pending_exit_reason, last_pnl_pct, last_value_usd, last_polled_at,
          token_decimals, entry_valuation_pnl_pct, entry_quote_in_amount, entry_quote_out_amount,
          token_program, token_account, token_amount_raw, entry_signature, entry_usdc_raw, entry_fee_lamports,
          entry_rent_lamports, entry_sol_price_usd, sell_attempts, sell_failures, sell_fees_lamports,
          failed_sell_fees_lamports, sell_budget_lamports, stuck_state, stuck_since, next_sell_at, close_ata
        ) VALUES (@mode, @mint, @symbol, @pair_address, @status, @entry_time, @size_usd, @token_amount, @cost_basis,
          @entry_liquidity_usd, @entry_pair_snapshot, @score, @score_components, @safety_result, @holders_result,
          @peak_pnl, @current_target, @target_extensions, @timer_restarts, @last_restart_at, @deadline,
          @trail_armed, @fast_streak, @low_liq_streak, @no_route_since, @closing_since, @pending_exit_reason, @last_pnl_pct, @last_value_usd, @last_polled_at,
          @token_decimals, @entry_valuation_pnl_pct, @entry_quote_in_amount, @entry_quote_out_amount,
          @token_program, @token_account, @token_amount_raw, @entry_signature, @entry_usdc_raw, @entry_fee_lamports,
          @entry_rent_lamports, @entry_sol_price_usd, @sell_attempts, @sell_failures, @sell_fees_lamports,
          @failed_sell_fees_lamports, @sell_budget_lamports, @stuck_state, @stuck_since, @next_sell_at, @close_ata)`,
      )
      .run({
        ...liveToDb({ ...DEFAULT_LIVE_FIELDS, ...pickLive(row) }),
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
        token_decimals: row.tokenDecimals,
        entry_valuation_pnl_pct: row.entryValuationPnlPct,
        entry_quote_in_amount: row.entryQuoteInAmount,
        entry_quote_out_amount: row.entryQuoteOutAmount,
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

  updateLive(id: number, patch: PositionLivePatch): void {
    const current = this.get(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE positions SET token_amount=@token_amount, token_program=@token_program, token_account=@token_account,
          token_amount_raw=@token_amount_raw, sell_attempts=@sell_attempts, sell_failures=@sell_failures,
          sell_fees_lamports=@sell_fees_lamports, failed_sell_fees_lamports=@failed_sell_fees_lamports,
          sell_budget_lamports=@sell_budget_lamports, stuck_state=@stuck_state, stuck_since=@stuck_since,
          next_sell_at=@next_sell_at, close_ata=@close_ata
        WHERE id=@id`,
      )
      .run({
        id,
        token_amount: next.tokenAmount,
        token_program: next.tokenProgram,
        token_account: next.tokenAccount,
        token_amount_raw: next.tokenAmountRaw,
        sell_attempts: next.sellAttempts,
        sell_failures: next.sellFailures,
        sell_fees_lamports: next.sellFeesLamports,
        failed_sell_fees_lamports: next.failedSellFeesLamports,
        sell_budget_lamports: next.sellBudgetLamports,
        stuck_state: next.stuckState,
        stuck_since: next.stuckSince,
        next_sell_at: next.nextSellAt,
        close_ata: next.closeAta ? 1 : 0,
      });
  }

  /** Every open or closing position, of any mode (startup mode-switch check, SPEC.md section 16.8). */
  listAllActive(): PositionRow[] {
    return (this.db.prepare("SELECT * FROM positions ORDER BY entry_time ASC").all() as PositionRowDb[]).map(fromDb);
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

const LIVE_KEYS = Object.keys(DEFAULT_LIVE_FIELDS) as Array<keyof PositionLiveFields>;

function pickLive(row: Partial<PositionLiveFields>): Partial<PositionLiveFields> {
  const out: Partial<PositionLiveFields> = {};
  for (const k of LIVE_KEYS) if (row[k] !== undefined) (out as Record<string, unknown>)[k] = row[k];
  return out;
}

function liveToDb(f: PositionLiveFields): Record<string, unknown> {
  return {
    token_program: f.tokenProgram,
    token_account: f.tokenAccount,
    token_amount_raw: f.tokenAmountRaw,
    entry_signature: f.entrySignature,
    entry_usdc_raw: f.entryUsdcRaw,
    entry_fee_lamports: f.entryFeeLamports,
    entry_rent_lamports: f.entryRentLamports,
    entry_sol_price_usd: f.entrySolPriceUsd,
    sell_attempts: f.sellAttempts,
    sell_failures: f.sellFailures,
    sell_fees_lamports: f.sellFeesLamports,
    failed_sell_fees_lamports: f.failedSellFeesLamports,
    sell_budget_lamports: f.sellBudgetLamports,
    stuck_state: f.stuckState,
    stuck_since: f.stuckSince,
    next_sell_at: f.nextSellAt,
    close_ata: f.closeAta ? 1 : 0,
  };
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
