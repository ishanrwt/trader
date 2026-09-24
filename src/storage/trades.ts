import type { Db } from "./db.js";

export interface TradeRow {
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
}

export type NewTradeRow = Omit<TradeRow, "id">;

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
}

function fromDb(row: TradeRowDb): TradeRow {
  return {
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
          entry_pair_snapshot, top1_pct, top10_pct, score, score_components, animal_flag, trading_day
        ) VALUES (@mode, @mint, @symbol, @pair_address, @entry_time, @exit_time, @size_usd, @cost_basis, @proceeds,
          @net_pnl_usd, @net_pnl_pct, @exit_reason, @peak_pnl, @timer_restarts, @target_extensions, @fees_usd,
          @entry_pair_snapshot, @top1_pct, @top10_pct, @score, @score_components, @animal_flag, @trading_day)`,
      )
      .run({
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
      });
    return Number(info.lastInsertRowid);
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
