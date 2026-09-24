-- Preserves position history past a close (trade_history), and records what
-- was actually used to value a position at entry and exit: the token amount
-- and decimals, the raw (pre-decimal-adjustment) Jupiter quote amounts for
-- the entry fill and first exit-lane valuation, and that first valuation's
-- pnlPct (the true entry-time mark, not an assumed 0%). SPEC.md sections
-- 11.1 and 12.

ALTER TABLE positions ADD COLUMN token_decimals INTEGER;
ALTER TABLE positions ADD COLUMN entry_valuation_pnl_pct REAL;
ALTER TABLE positions ADD COLUMN entry_quote_in_amount TEXT;
ALTER TABLE positions ADD COLUMN entry_quote_out_amount TEXT;

ALTER TABLE trades ADD COLUMN token_amount REAL;
ALTER TABLE trades ADD COLUMN token_decimals INTEGER;
ALTER TABLE trades ADD COLUMN entry_valuation_pnl_pct REAL;
ALTER TABLE trades ADD COLUMN entry_quote_in_amount TEXT;
ALTER TABLE trades ADD COLUMN entry_quote_out_amount TEXT;
ALTER TABLE trades ADD COLUMN exit_quote_in_amount TEXT;
ALTER TABLE trades ADD COLUMN exit_quote_out_amount TEXT;

-- A trade's position_history, copied here (not deleted) when the position closes.
CREATE TABLE trade_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL REFERENCES trades (id),
  t INTEGER NOT NULL,
  pnl_pct REAL NOT NULL
);
CREATE INDEX idx_trade_history_trade ON trade_history (trade_id, t);
