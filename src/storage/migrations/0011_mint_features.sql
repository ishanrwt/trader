-- SPEC.md section 11.6: rug-risk features, recorded once per mint and mode at
-- first READY (independent of the price-path cap; joins price_paths on mint
-- and mode). Data collection only. Additive only.

CREATE TABLE mint_features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  mode TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  pool_program TEXT,
  pool_canonical INTEGER,
  pump_migrated INTEGER,
  lp_supply_pool TEXT,               -- PumpSwap pool lp_supply (raw; burns don't reduce it)
  lp_mint_supply TEXT,               -- the LP mint's current supply (raw)
  lp_status TEXT,                    -- burned | withdrawable
  lp_burned_pct REAL,
  lp_locked_pct REAL,
  lp_withdrawable_pct REAL,
  holder_count INTEGER,
  sniper_share_pct REAL,
  sniper_slots INTEGER,
  sniper_txs INTEGER,
  sniper_capped INTEGER,
  creator TEXT,
  creator_holding_pct REAL,
  rugcheck_score REAL,
  rugcheck_score_normalised REAL,
  rugcheck_lp_locked_pct REAL,
  rugcheck_risks TEXT,               -- JSON
  reasons TEXT NOT NULL,             -- JSON: feature -> reason code, for every null feature
  credits_used INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_mint_features_mint_mode ON mint_features (mint, mode);
