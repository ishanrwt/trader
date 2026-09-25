-- Extra per-trade detail (SPEC.md sections 8.3, 11.1, 12): the sellability
-- check's round-trip loss and when it ran, the entry pair's dexId, and for
-- stop exits the triggering poll's pnlPct and the confirmation quote's pnlPct.
-- Carried on positions until the trade is recorded. Additive only.

ALTER TABLE positions ADD COLUMN sellability_loss_pct REAL;
ALTER TABLE positions ADD COLUMN sellability_checked_at INTEGER;
ALTER TABLE positions ADD COLUMN dex_id TEXT;
ALTER TABLE positions ADD COLUMN stop_poll_pnl_pct REAL;
ALTER TABLE positions ADD COLUMN stop_confirm_pnl_pct REAL;

ALTER TABLE trades ADD COLUMN sellability_loss_pct REAL;
ALTER TABLE trades ADD COLUMN sellability_checked_at INTEGER;
ALTER TABLE trades ADD COLUMN dex_id TEXT;
ALTER TABLE trades ADD COLUMN stop_poll_pnl_pct REAL;
ALTER TABLE trades ADD COLUMN stop_confirm_pnl_pct REAL;

-- dexId was already stored inside the entry pair snapshot, so existing rows are
-- backfilled from it. The sellability and stop values were never recorded and stay NULL.
UPDATE positions SET dex_id = json_extract(entry_pair_snapshot, '$.dexId') WHERE entry_pair_snapshot IS NOT NULL;
UPDATE trades SET dex_id = json_extract(entry_pair_snapshot, '$.dexId') WHERE entry_pair_snapshot IS NOT NULL;
