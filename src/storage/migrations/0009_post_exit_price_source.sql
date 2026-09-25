-- SPEC.md section 11.3: where a post-exit track's exit price came from.
-- Before this, exit_price_usd held the DexScreener priceUsd from the ENTRY
-- snapshot, so every existing row is marked 'entry_snapshot' and the report's
-- exited-too-early figures leave them out. New rows use the DexScreener price
-- fetched at exit ('dexscreener_at_exit').

ALTER TABLE post_exit_tracks ADD COLUMN exit_price_source TEXT;
UPDATE post_exit_tracks SET exit_price_source = 'entry_snapshot';
