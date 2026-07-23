-- Add 'wiki-committer' to the watchers type constraint for the daily wiki-committer
-- sweeper watcher (commits uncommitted wiki-subtree changes on the default branch;
-- sibling of wiki-gardener/wiki-linter). Mirrors init.sql: append 'wiki-committer'
-- at the END of the IN (...) list so the constraint definition stays byte-identical
-- to init.sql (schema-drift.test.ts compares pg_get_constraintdef, which preserves
-- order).
ALTER TABLE watchers DROP CONSTRAINT IF EXISTS watchers_type_check;
ALTER TABLE watchers ADD CONSTRAINT watchers_type_check
  CHECK (type IN ('email', 'calendar', 'github', 'news', 'goal', 'x', 'anthropic', 'wiki-gardener', 'wiki-linter', 'wiki-committer'));
