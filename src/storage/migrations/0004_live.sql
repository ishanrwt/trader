-- Phase 3 (SPEC.md sections 11.1, 11.2, 12, 16): write-ahead intents, fee
-- losses, live fields on positions/trades, shadow mode, token program and
-- decimals in the safety cache, and per-mode risk state keys. Additive only:
-- safe to run on a database that a Phase 2 paper bot has been using.

CREATE TABLE tx_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- buy | sell | smoke
  mode TEXT NOT NULL,                 -- live (smoke-live intents are mode 'live', kind 'smoke')
  mint TEXT NOT NULL,
  position_id INTEGER,
  ref_key TEXT NOT NULL,              -- 'pos:<id>' (sells), 'mint:<mint>' (buys), 'smoke:<leg>'
  side TEXT NOT NULL,                 -- buy | sell
  status TEXT NOT NULL,               -- pending | signed | sent | landed | applied | failed | expired | abandoned
  signature TEXT,
  signed_tx_b64 TEXT,
  last_valid_block_height INTEGER,
  input_mint TEXT NOT NULL,
  output_mint TEXT NOT NULL,
  expected_in_raw TEXT,
  expected_out_raw TEXT,
  min_out_raw TEXT,
  payload TEXT,                       -- JSON: everything needed to build a position from a landed buy
  fee_lamports INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  resolved_at INTEGER
);
-- SPEC.md section 16.4 / addition A: at most one unresolved intent per position
-- (or, for buys, per mint) and side, across EVERY unresolved status.
CREATE UNIQUE INDEX idx_tx_intents_one_unresolved ON tx_intents (ref_key, side)
  WHERE status IN ('pending', 'signed', 'sent', 'landed');
CREATE INDEX idx_tx_intents_status ON tx_intents (status);
CREATE INDEX idx_tx_intents_mint ON tx_intents (mint);

CREATE TABLE fee_losses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  ts INTEGER NOT NULL,
  trading_day TEXT NOT NULL,
  mint TEXT NOT NULL,
  position_id INTEGER,
  intent_id INTEGER,
  signature TEXT,
  kind TEXT NOT NULL,
  lamports INTEGER NOT NULL,
  usd REAL NOT NULL,
  sol_price_usd REAL
);
CREATE INDEX idx_fee_losses_day ON fee_losses (mode, trading_day);
CREATE INDEX idx_fee_losses_position ON fee_losses (position_id);

ALTER TABLE positions ADD COLUMN token_program TEXT;
ALTER TABLE positions ADD COLUMN token_account TEXT;
ALTER TABLE positions ADD COLUMN token_amount_raw TEXT;
ALTER TABLE positions ADD COLUMN entry_signature TEXT;
ALTER TABLE positions ADD COLUMN entry_usdc_raw TEXT;
ALTER TABLE positions ADD COLUMN entry_fee_lamports INTEGER;
ALTER TABLE positions ADD COLUMN entry_rent_lamports INTEGER;
ALTER TABLE positions ADD COLUMN entry_sol_price_usd REAL;
ALTER TABLE positions ADD COLUMN sell_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN sell_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN sell_fees_lamports INTEGER NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN failed_sell_fees_lamports INTEGER NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN sell_budget_lamports INTEGER;
ALTER TABLE positions ADD COLUMN stuck_state TEXT;          -- null | stuck | budget_exhausted
ALTER TABLE positions ADD COLUMN stuck_since INTEGER;
ALTER TABLE positions ADD COLUMN next_sell_at INTEGER;
ALTER TABLE positions ADD COLUMN close_ata INTEGER NOT NULL DEFAULT 1;

ALTER TABLE trades ADD COLUMN entry_signature TEXT;
ALTER TABLE trades ADD COLUMN exit_signature TEXT;
ALTER TABLE trades ADD COLUMN entry_usdc_raw TEXT;
ALTER TABLE trades ADD COLUMN entry_tokens_raw TEXT;
ALTER TABLE trades ADD COLUMN exit_tokens_raw TEXT;
ALTER TABLE trades ADD COLUMN exit_usdc_raw TEXT;
ALTER TABLE trades ADD COLUMN entry_fee_lamports INTEGER;
ALTER TABLE trades ADD COLUMN exit_fee_lamports INTEGER;
ALTER TABLE trades ADD COLUMN entry_fee_usd REAL;
ALTER TABLE trades ADD COLUMN exit_fee_usd REAL;
ALTER TABLE trades ADD COLUMN rent_paid_lamports INTEGER;
ALTER TABLE trades ADD COLUMN rent_reclaimed_lamports INTEGER;
ALTER TABLE trades ADD COLUMN rent_paid_usd REAL;
ALTER TABLE trades ADD COLUMN rent_reclaimed_usd REAL;
ALTER TABLE trades ADD COLUMN entry_sol_price_usd REAL;
ALTER TABLE trades ADD COLUMN exit_sol_price_usd REAL;
ALTER TABLE trades ADD COLUMN sell_attempts INTEGER;
ALTER TABLE trades ADD COLUMN failed_sell_fees_lamports INTEGER;
ALTER TABLE trades ADD COLUMN failed_sell_fees_usd REAL;
ALTER TABLE trades ADD COLUMN proceeds_unknown INTEGER NOT NULL DEFAULT 0;

-- Existing shadows were all created by paper runs.
ALTER TABLE shadows ADD COLUMN mode TEXT NOT NULL DEFAULT 'paper';

ALTER TABLE safety_cache ADD COLUMN token_program TEXT;
ALTER TABLE safety_cache ADD COLUMN decimals INTEGER;

-- Per-mode risk state (SPEC.md section 9.1): the Phase 2 keys were paper-only.
INSERT OR IGNORE INTO state (key, value)
  SELECT key || ':paper', value FROM state WHERE key IN ('dailyLossHaltDay', 'lossStreak', 'lossPauseUntil');
