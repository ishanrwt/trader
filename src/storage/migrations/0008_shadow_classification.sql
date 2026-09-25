-- SPEC.md section 11.2: a shadow's lifecycle (outcome: open/closed) is
-- separate from its classification (unselected/selected/unsellable). Before
-- this, marking a shadow 'selected' or 'unsellable' overwrote 'open', so the
-- shadow poll (which reads open shadows) stopped pricing it; and a mint bought
-- after its shadow had closed was never marked selected.

ALTER TABLE shadows ADD COLUMN classification TEXT NOT NULL DEFAULT 'unselected'
  CHECK (classification IN ('unselected', 'selected', 'unsellable'));

-- 1. Move the classification out of outcome.
UPDATE shadows SET classification = outcome WHERE outcome IN ('selected', 'unsellable');

-- 2. Repair the missed marks: a kept shadow whose mint has a trade or an open
--    position in the SAME mode was selected.
UPDATE shadows SET classification = 'selected'
WHERE duplicate_of IS NULL
  AND classification = 'unselected'
  AND (
    EXISTS (SELECT 1 FROM trades t WHERE t.mint = shadows.mint AND t.mode = shadows.mode)
    OR EXISTS (SELECT 1 FROM positions p WHERE p.mint = shadows.mint AND p.mode = shadows.mode)
  );

-- 3. Lifecycle: former 'selected'/'unsellable' rows stopped being polled when they
--    were marked and can't be resumed (today's price against an old entry would
--    fake an exit). Close them unpriced; the report counts them as "no data".
UPDATE shadows SET outcome = 'closed', exit_reason = COALESCE(exit_reason, 'not_priced')
WHERE outcome IN ('selected', 'unsellable');
