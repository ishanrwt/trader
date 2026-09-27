-- SPEC.md section 11.5: a price path for every mint that becomes READY, for
-- offline replay of exit rules and entry filters. Data collection only.
-- Additive only.

CREATE TABLE price_paths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  mode TEXT NOT NULL,
  started_at INTEGER NOT NULL,          -- first READY
  ends_at INTEGER NOT NULL,             -- started_at + 60 minutes
  status TEXT NOT NULL DEFAULT 'recording' CHECK (status IN ('recording', 'done')),
  -- Entry features at first READY
  pair_snapshot TEXT,                   -- the selected DexScreener pair, JSON
  dex_id TEXT,
  pair_age_ms INTEGER,
  top1_pct REAL,
  top10_pct REAL,
  score REAL,
  score_components TEXT,                -- JSON
  selected INTEGER NOT NULL DEFAULT 0,  -- a position opened for the mint
  sellability_loss_pct REAL,            -- round-trip loss if a sellability check ran
  sellability_checked_at INTEGER
);
CREATE UNIQUE INDEX idx_price_paths_mint_mode ON price_paths (mint, mode);
CREATE INDEX idx_price_paths_status ON price_paths (status);

CREATE TABLE price_path_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path_id INTEGER NOT NULL REFERENCES price_paths (id),
  t INTEGER NOT NULL,
  price_usd REAL,
  liquidity_usd REAL,
  buys_m5 INTEGER,
  sells_m5 INTEGER,
  volume_m5 REAL,
  gap TEXT CHECK (gap IS NULL OR gap IN ('no_pair', 'fetch_failed'))  -- null = a normal point
);
CREATE INDEX idx_price_path_points_path ON price_path_points (path_id, t);
