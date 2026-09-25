-- SPEC.md section 11.1: whether a live bot would have been blocked at entry
-- time, and by which halt: 'none', 'daily_loss', 'loss_streak' or
-- 'daily_loss+loss_streak'. Set on the position at entry and copied to its
-- trade. Additive only; existing rows stay NULL (not recorded).

ALTER TABLE positions ADD COLUMN would_block_at_entry TEXT;
ALTER TABLE trades ADD COLUMN would_block_at_entry TEXT;
