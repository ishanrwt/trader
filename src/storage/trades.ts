import type { Db } from "./db.js";
import { DEFAULT_DETAIL_FIELDS, type PositionDetailFields } from "./positions.js";

/** Sellability loss, dexId and stop poll/confirmation values (SPEC.md section 11.1), copied from the position. */
export type TradeDetailFields = PositionDetailFields;

/**
 * Live-trade fields (SPEC.md section 11.1). Raw amounts are large-integer
 * strings from the confirmed transactions. Paper trades leave them null (and
 * proceedsUnknown false).
 */
export interface TradeLiveFields {
  entrySignature: string | null;
  exitSignature: string | null;
  entryUsdcRaw: string | null;
  entryTokensRaw: string | null;
  exitTokensRaw: string | null;
  exitUsdcRaw: string | null;
  entryFeeLamports: number | null;
  exitFeeLamports: number | null;
  entryFeeUsd: number | null;
  exitFeeUsd: number | null;
  rentPaidLamports: number | null;
  rentReclaimedLamports: number | null;
  rentPaidUsd: number | null;
  rentReclaimedUsd: number | null;
  entrySolPriceUsd: number | null;
  exitSolPriceUsd: number | null;
  sellAttempts: number | null;
  failedSellFeesLamports: number | null;
  failedSellFeesUsd: number | null;
  /** True only for `reconciled` closes: proceeds recorded as 0, but the loss may not be real (section 16.5). */
  proceedsUnknown: boolean;
}

const TRADE_LIVE_DEFAULTS: TradeLiveFields = {
  entrySignature: null,
  exitSignature: null,
  entryUsdcRaw: null,
  entryTokensRaw: null,
  exitTokensRaw: null,
  exitUsdcRaw: null,
  entryFeeLamports: null,
  exitFeeLamports: null,
  entryFeeUsd: null,
  exitFeeUsd: null,
  rentPaidLamports: null,
  rentReclaimedLamports: null,
  rentPaidUsd: null,
  rentReclaimedUsd: null,
  entrySolPriceUsd: null,
  exitSolPriceUsd: null,
  sellAttempts: null,
  failedSellFeesLamports: null,
  failedSellFeesUsd: null,
  proceedsUnknown: false,
};

export interface TradeRow extends TradeLiveFields, TradeDetailFields {
  id: number;
  mode: string;
  mint: string;
  symbol: string | null;
  pairAddress: string | null;
  entryTime: number;
  exitTime: number;
  sizeUsd: number;
  costBasis: number;
  proceeds: number;
  netPnlUsd: number;
  netPnlPct: number;
  exitReason: string;
  peakPnl: number;
  timerRestarts: number;
  targetExtensions: number;
  feesUsd: number;
  entryPairSnapshot: unknown;
  top1Pct: number | null;
  top10Pct: number | null;
  score: number | null;
  scoreComponents: unknown;
  animalFlag: boolean | null;
  tradingDay: string;
  /** Tokens received at entry (from the entry fill), and the mint's decimals if ever learned. */
  tokenAmount: number | null;
  tokenDecimals: number | null;
  /** pnlPct from the first exit-lane quote fetched immediately after the entry fill — null if that quote failed (section 8.1's true entry-time mark, not an assumed 0%). */
  entryValuationPnlPct: number | null;
  /** Raw (pre-decimal-adjustment) Jupiter quote amounts, as large-integer strings straight from the API. */
  entryQuoteInAmount: string | null;
  entryQuoteOutAmount: string | null;
  exitQuoteInAmount: string | null;
  exitQuoteOutAmount: string | null;
}

/** Live and detail fields are optional on insert (paper trades omit the live ones; detail fields default to null). */
export type NewTradeRow = Omit<TradeRow, "id" | keyof TradeLiveFields | keyof TradeDetailFields> & Partial<TradeLiveFields> & Partial<TradeDetailFields>;

interface TradeRowDb {
  id: number;
  mode: string;
  mint: string;
  symbol: string | null;
  pair_address: string | null;
  entry_time: number;
  exit_time: number;
  size_usd: number;
  cost_basis: number;
  proceeds: number;
  net_pnl_usd: number;
  net_pnl_pct: number;
  exit_reason: string;
  peak_pnl: number;
  timer_restarts: number;
  target_extensions: number;
  fees_usd: number;
  entry_pair_snapshot: string | null;
  top1_pct: number | null;
  top10_pct: number | null;
  score: number | null;
  score_components: string | null;
  animal_flag: number | null;
  trading_day: string;
  token_amount: number | null;
  token_decimals: number | null;
  entry_valuation_pnl_pct: number | null;
  entry_quote_in_amount: string | null;
  entry_quote_out_amount: string | null;
  exit_quote_in_amount: string | null;
  exit_quote_out_amount: string | null;
  entry_signature: string | null;
  exit_signature: string | null;
  entry_usdc_raw: string | null;
  entry_tokens_raw: string | null;
  exit_tokens_raw: string | null;
  exit_usdc_raw: string | null;
  entry_fee_lamports: number | null;
  exit_fee_lamports: number | null;
  entry_fee_usd: number | null;
  exit_fee_usd: number | null;
  rent_paid_lamports: number | null;
  rent_reclaimed_lamports: number | null;
  rent_paid_usd: number | null;
  rent_reclaimed_usd: number | null;
  entry_sol_price_usd: number | null;
  exit_sol_price_usd: number | null;
  sell_attempts: number | null;
  failed_sell_fees_lamports: number | null;
  failed_sell_fees_usd: number | null;
  proceeds_unknown: number;
  sellability_loss_pct: number | null;
  sellability_checked_at: number | null;
  dex_id: string | null;
  stop_poll_pnl_pct: number | null;
  stop_confirm_pnl_pct: number | null;
}

function fromDb(row: TradeRowDb): TradeRow {
  return {
    entrySignature: row.entry_signature,
    exitSignature: row.exit_signature,
    entryUsdcRaw: row.entry_usdc_raw,
    entryTokensRaw: row.entry_tokens_raw,
    exitTokensRaw: row.exit_tokens_raw,
    exitUsdcRaw: row.exit_usdc_raw,
    entryFeeLamports: row.entry_fee_lamports,
    exitFeeLamports: row.exit_fee_lamports,
    entryFeeUsd: row.entry_fee_usd,
    exitFeeUsd: row.exit_fee_usd,
    rentPaidLamports: row.rent_paid_lamports,
    rentReclaimedLamports: row.rent_reclaimed_lamports,
    rentPaidUsd: row.rent_paid_usd,
    rentReclaimedUsd: row.rent_reclaimed_usd,
    entrySolPriceUsd: row.entry_sol_price_usd,
    exitSolPriceUsd: row.exit_sol_price_usd,
    sellAttempts: row.sell_attempts,
    failedSellFeesLamports: row.failed_sell_fees_lamports,
    failedSellFeesUsd: row.failed_sell_fees_usd,
    proceedsUnknown: row.proceeds_unknown === 1,
    sellabilityLossPct: row.sellability_loss_pct,
    sellabilityCheckedAt: row.sellability_checked_at,
    dexId: row.dex_id,
    stopPollPnlPct: row.stop_poll_pnl_pct,
    stopConfirmPnlPct: row.stop_confirm_pnl_pct,
    id: row.id,
    mode: row.mode,
    mint: row.mint,
    symbol: row.symbol,
    pairAddress: row.pair_address,
    entryTime: row.entry_time,
    exitTime: row.exit_time,
    sizeUsd: row.size_usd,
    costBasis: row.cost_basis,
    proceeds: row.proceeds,
    netPnlUsd: row.net_pnl_usd,
    netPnlPct: row.net_pnl_pct,
    exitReason: row.exit_reason,
    peakPnl: row.peak_pnl,
    timerRestarts: row.timer_restarts,
    targetExtensions: row.target_extensions,
    feesUsd: row.fees_usd,
    entryPairSnapshot: row.entry_pair_snapshot ? JSON.parse(row.entry_pair_snapshot) : null,
    top1Pct: row.top1_pct,
    top10Pct: row.top10_pct,
    score: row.score,
    scoreComponents: row.score_components ? JSON.parse(row.score_components) : null,
    animalFlag: row.animal_flag === null ? null : row.animal_flag === 1,
    tradingDay: row.trading_day,
    tokenAmount: row.token_amount,
    tokenDecimals: row.token_decimals,
    entryValuationPnlPct: row.entry_valuation_pnl_pct,
    entryQuoteInAmount: row.entry_quote_in_amount,
    entryQuoteOutAmount: row.entry_quote_out_amount,
    exitQuoteInAmount: row.exit_quote_in_amount,
    exitQuoteOutAmount: row.exit_quote_out_amount,
  };
}

function definedOnly(row: Partial<TradeLiveFields>): Partial<TradeLiveFields> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(TRADE_LIVE_DEFAULTS) as Array<keyof TradeLiveFields>) if (row[k] !== undefined) out[k] = row[k];
  return out as Partial<TradeLiveFields>;
}

function tradeLiveToDb(f: TradeLiveFields): Record<string, unknown> {
  return {
    entry_signature: f.entrySignature,
    exit_signature: f.exitSignature,
    entry_usdc_raw: f.entryUsdcRaw,
    entry_tokens_raw: f.entryTokensRaw,
    exit_tokens_raw: f.exitTokensRaw,
    exit_usdc_raw: f.exitUsdcRaw,
    entry_fee_lamports: f.entryFeeLamports,
    exit_fee_lamports: f.exitFeeLamports,
    entry_fee_usd: f.entryFeeUsd,
    exit_fee_usd: f.exitFeeUsd,
    rent_paid_lamports: f.rentPaidLamports,
    rent_reclaimed_lamports: f.rentReclaimedLamports,
    rent_paid_usd: f.rentPaidUsd,
    rent_reclaimed_usd: f.rentReclaimedUsd,
    entry_sol_price_usd: f.entrySolPriceUsd,
    exit_sol_price_usd: f.exitSolPriceUsd,
    sell_attempts: f.sellAttempts,
    failed_sell_fees_lamports: f.failedSellFeesLamports,
    failed_sell_fees_usd: f.failedSellFeesUsd,
    proceeds_unknown: f.proceedsUnknown ? 1 : 0,
  };
}

/** DB access for `trades` (SPEC.md section 11.1). */
export class TradesStore {
  constructor(private readonly db: Db) {}

  insert(row: NewTradeRow): number {
    const info = this.db
      .prepare(
        `INSERT INTO trades (
          mode, mint, symbol, pair_address, entry_time, exit_time, size_usd, cost_basis, proceeds,
          net_pnl_usd, net_pnl_pct, exit_reason, peak_pnl, timer_restarts, target_extensions, fees_usd,
          entry_pair_snapshot, top1_pct, top10_pct, score, score_components, animal_flag, trading_day,
          token_amount, token_decimals, entry_valuation_pnl_pct, entry_quote_in_amount, entry_quote_out_amount,
          exit_quote_in_amount, exit_quote_out_amount,
          entry_signature, exit_signature, entry_usdc_raw, entry_tokens_raw, exit_tokens_raw, exit_usdc_raw,
          entry_fee_lamports, exit_fee_lamports, entry_fee_usd, exit_fee_usd, rent_paid_lamports, rent_reclaimed_lamports,
          rent_paid_usd, rent_reclaimed_usd, entry_sol_price_usd, exit_sol_price_usd, sell_attempts,
          failed_sell_fees_lamports, failed_sell_fees_usd, proceeds_unknown,
          sellability_loss_pct, sellability_checked_at, dex_id, stop_poll_pnl_pct, stop_confirm_pnl_pct
        ) VALUES (@mode, @mint, @symbol, @pair_address, @entry_time, @exit_time, @size_usd, @cost_basis, @proceeds,
          @net_pnl_usd, @net_pnl_pct, @exit_reason, @peak_pnl, @timer_restarts, @target_extensions, @fees_usd,
          @entry_pair_snapshot, @top1_pct, @top10_pct, @score, @score_components, @animal_flag, @trading_day,
          @token_amount, @token_decimals, @entry_valuation_pnl_pct, @entry_quote_in_amount, @entry_quote_out_amount,
          @exit_quote_in_amount, @exit_quote_out_amount,
          @entry_signature, @exit_signature, @entry_usdc_raw, @entry_tokens_raw, @exit_tokens_raw, @exit_usdc_raw,
          @entry_fee_lamports, @exit_fee_lamports, @entry_fee_usd, @exit_fee_usd, @rent_paid_lamports, @rent_reclaimed_lamports,
          @rent_paid_usd, @rent_reclaimed_usd, @entry_sol_price_usd, @exit_sol_price_usd, @sell_attempts,
          @failed_sell_fees_lamports, @failed_sell_fees_usd, @proceeds_unknown,
          @sellability_loss_pct, @sellability_checked_at, @dex_id, @stop_poll_pnl_pct, @stop_confirm_pnl_pct)`,
      )
      .run({
        ...tradeLiveToDb({ ...TRADE_LIVE_DEFAULTS, ...definedOnly(row) }),
        sellability_loss_pct: row.sellabilityLossPct ?? DEFAULT_DETAIL_FIELDS.sellabilityLossPct,
        sellability_checked_at: row.sellabilityCheckedAt ?? DEFAULT_DETAIL_FIELDS.sellabilityCheckedAt,
        dex_id: row.dexId ?? DEFAULT_DETAIL_FIELDS.dexId,
        stop_poll_pnl_pct: row.stopPollPnlPct ?? DEFAULT_DETAIL_FIELDS.stopPollPnlPct,
        stop_confirm_pnl_pct: row.stopConfirmPnlPct ?? DEFAULT_DETAIL_FIELDS.stopConfirmPnlPct,
        mode: row.mode,
        mint: row.mint,
        symbol: row.symbol,
        pair_address: row.pairAddress,
        entry_time: row.entryTime,
        exit_time: row.exitTime,
        size_usd: row.sizeUsd,
        cost_basis: row.costBasis,
        proceeds: row.proceeds,
        net_pnl_usd: row.netPnlUsd,
        net_pnl_pct: row.netPnlPct,
        exit_reason: row.exitReason,
        peak_pnl: row.peakPnl,
        timer_restarts: row.timerRestarts,
        target_extensions: row.targetExtensions,
        fees_usd: row.feesUsd,
        entry_pair_snapshot: row.entryPairSnapshot ? JSON.stringify(row.entryPairSnapshot) : null,
        top1_pct: row.top1Pct,
        top10_pct: row.top10Pct,
        score: row.score,
        score_components: row.scoreComponents ? JSON.stringify(row.scoreComponents) : null,
        animal_flag: row.animalFlag === null ? null : row.animalFlag ? 1 : 0,
        trading_day: row.tradingDay,
        token_amount: row.tokenAmount,
        token_decimals: row.tokenDecimals,
        entry_valuation_pnl_pct: row.entryValuationPnlPct,
        entry_quote_in_amount: row.entryQuoteInAmount,
        entry_quote_out_amount: row.entryQuoteOutAmount,
        exit_quote_in_amount: row.exitQuoteInAmount,
        exit_quote_out_amount: row.exitQuoteOutAmount,
      });
    return Number(info.lastInsertRowid);
  }

  get(id: number): TradeRow | undefined {
    const row = this.db.prepare("SELECT * FROM trades WHERE id = ?").get(id) as TradeRowDb | undefined;
    return row ? fromDb(row) : undefined;
  }

  listAll(opts: { mode?: string; from?: string; to?: string } = {}): TradeRow[] {
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
    const rows = this.db.prepare(`SELECT * FROM trades ${where} ORDER BY exit_time ASC`).all(params) as TradeRowDb[];
    return rows.map(fromDb);
  }

  listSince(sinceExitTime: number): TradeRow[] {
    const rows = this.db.prepare("SELECT * FROM trades WHERE exit_time >= ? ORDER BY exit_time ASC").all(sinceExitTime) as TradeRowDb[];
    return rows.map(fromDb);
  }

  listForTradingDay(tradingDay: string): TradeRow[] {
    const rows = this.db.prepare("SELECT * FROM trades WHERE trading_day = ? ORDER BY exit_time ASC").all(tradingDay) as TradeRowDb[];
    return rows.map(fromDb);
  }
}
