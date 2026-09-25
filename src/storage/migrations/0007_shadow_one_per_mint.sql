-- SPEC.md section 11.2: exactly one shadow per mint and mode. Before this, a
-- mint that dropped back to pending and became READY again got another
-- shadow, and two concurrent bot processes could each create one. Nothing is
-- deleted: every shadow after the earliest per (mint, mode) (by entry_time,
-- then id) is marked with the id of the one kept, and excluded everywhere.

ALTER TABLE shadows ADD COLUMN duplicate_of INTEGER REFERENCES shadows (id);

UPDATE shadows
SET duplicate_of = (
  SELECT k.id FROM shadows k
  WHERE k.mint = shadows.mint AND k.mode = shadows.mode
  ORDER BY k.entry_time ASC, k.id ASC
  LIMIT 1
)
WHERE id <> (
  SELECT k.id FROM shadows k
  WHERE k.mint = shadows.mint AND k.mode = shadows.mode
  ORDER BY k.entry_time ASC, k.id ASC
  LIMIT 1
);

-- A classification recorded only on a duplicate moves to the kept shadow,
-- unsellable taking precedence over selected (unsellable mints are excluded
-- from comparisons; a kept shadow left 'closed' would count as unselected).
UPDATE shadows SET outcome = 'unsellable'
WHERE duplicate_of IS NULL AND outcome <> 'unsellable'
  AND EXISTS (SELECT 1 FROM shadows d WHERE d.duplicate_of = shadows.id AND d.outcome = 'unsellable');

UPDATE shadows SET outcome = 'selected'
WHERE duplicate_of IS NULL AND outcome NOT IN ('unsellable', 'selected')
  AND EXISTS (SELECT 1 FROM shadows d WHERE d.duplicate_of = shadows.id AND d.outcome = 'selected');

CREATE UNIQUE INDEX idx_shadows_one_per_mint ON shadows (mint, mode) WHERE duplicate_of IS NULL;
