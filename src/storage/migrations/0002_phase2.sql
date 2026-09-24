-- Phase 2 tables (SPEC.md section 12): positions/trades/shadows/skip_tracks/
-- post_exit_tracks/safety_cache, plus a snapshot column on pending for READY
-- mints so slot filling doesn't need a fresh DexScreener fetch.

ALTER TABLE pending ADD COLUMN snapshot TEXT;

CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  pair_address TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  entry_time INTEGER NOT NULL,
  size_usd REAL NOT NULL,
  token_amount REAL NOT NULL,
  cost_basis REAL NOT NULL,
  entry_liquidity_usd REAL NOT NULL,
  entry_pair_snapshot TEXT,
  score REAL,
  score_components TEXT,
  safety_result TEXT,
  holders_result TEXT,
  peak_pnl REAL NOT NULL DEFAULT 0,
  current_target REAL NOT NULL,
  target_extensions INTEGER NOT NULL DEFAULT 0,
  timer_restarts INTEGER NOT NULL DEFAULT 0,
  last_restart_at INTEGER,
  deadline INTEGER NOT NULL,
  trail_armed INTEGER NOT NULL DEFAULT 0,
  fast_streak INTEGER NOT NULL DEFAULT 0,
  low_liq_streak INTEGER NOT NULL DEFAULT 0,
  no_route_since INTEGER,
  closing_since INTEGER,
  pending_exit_reason TEXT,
  last_pnl_pct REAL,
  last_value_usd REAL,
  last_polled_at INTEGER
);
CREATE INDEX idx_positions_status ON positions (status);
CREATE INDEX idx_positions_mint ON positions (mint);

CREATE TABLE position_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL REFERENCES positions (id),
  t INTEGER NOT NULL,
  pnl_pct REAL NOT NULL
);
CREATE INDEX idx_position_history_position ON position_history (position_id, t);

CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  pair_address TEXT,
  entry_time INTEGER NOT NULL,
  exit_time INTEGER NOT NULL,
  size_usd REAL NOT NULL,
  cost_basis REAL NOT NULL,
  proceeds REAL NOT NULL,
  net_pnl_usd REAL NOT NULL,
  net_pnl_pct REAL NOT NULL,
  exit_reason TEXT NOT NULL,
  peak_pnl REAL NOT NULL,
  timer_restarts INTEGER NOT NULL,
  target_extensions INTEGER NOT NULL,
  fees_usd REAL NOT NULL,
  entry_pair_snapshot TEXT,
  top1_pct REAL,
  top10_pct REAL,
  score REAL,
  score_components TEXT,
  animal_flag INTEGER,
  trading_day TEXT NOT NULL
);
CREATE INDEX idx_trades_exit_time ON trades (exit_time);
CREATE INDEX idx_trades_trading_day ON trades (trading_day);
CREATE INDEX idx_trades_mode ON trades (mode);

CREATE TABLE shadows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  symbol TEXT,
  pair_address TEXT,
  outcome TEXT NOT NULL DEFAULT 'open',
  entry_time INTEGER NOT NULL,
  cost_basis REAL NOT NULL,
  token_amount REAL NOT NULL,
  entry_liquidity_usd REAL NOT NULL,
  entry_price_usd REAL NOT NULL,
  score REAL,
  score_components TEXT,
  peak_pnl REAL NOT NULL DEFAULT 0,
  current_target REAL NOT NULL,
  target_extensions INTEGER NOT NULL DEFAULT 0,
  timer_restarts INTEGER NOT NULL DEFAULT 0,
  last_restart_at INTEGER,
  deadline INTEGER NOT NULL,
  trail_armed INTEGER NOT NULL DEFAULT 0,
  fast_streak INTEGER NOT NULL DEFAULT 0,
  low_liq_streak INTEGER NOT NULL DEFAULT 0,
  no_route_since INTEGER,
  exit_time INTEGER,
  exit_reason TEXT,
  proceeds REAL,
  net_pnl_usd REAL,
  net_pnl_pct REAL
);
CREATE INDEX idx_shadows_mint ON shadows (mint);
CREATE INDEX idx_shadows_outcome ON shadows (outcome);

CREATE TABLE skip_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  skip_reason TEXT NOT NULL,
  discovered_at INTEGER NOT NULL,
  skipped_at INTEGER NOT NULL,
  price_at_skip_usd REAL,
  price_15m_usd REAL,
  price_60m_usd REAL,
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_skip_tracks_resolved ON skip_tracks (resolved, skipped_at);

CREATE TABLE post_exit_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL REFERENCES trades (id),
  mint TEXT NOT NULL,
  exit_time INTEGER NOT NULL,
  exit_price_usd REAL,
  price_15m_usd REAL,
  price_30m_usd REAL,
  price_60m_usd REAL,
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_post_exit_tracks_resolved ON post_exit_tracks (resolved, exit_time);

CREATE TABLE safety_cache (
  mint TEXT PRIMARY KEY,
  passed INTEGER NOT NULL,
  reason TEXT,
  checked_at INTEGER NOT NULL
);
