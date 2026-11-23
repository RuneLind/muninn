-- Add 'youtube-discovery' to the watchers type constraint: the weekly YouTube
-- discovery watcher (plan muninn-youtube-discovery, PR 3). Appended at the END of
-- the IN (...) list so the constraint stays byte-identical to init.sql
-- (schema-drift.test.ts compares pg_get_constraintdef, which keeps the order).
ALTER TABLE watchers DROP CONSTRAINT IF EXISTS watchers_type_check;
ALTER TABLE watchers ADD CONSTRAINT watchers_type_check
  CHECK (type IN ('email', 'calendar', 'github', 'news', 'goal', 'x', 'anthropic', 'wiki-gardener', 'wiki-linter', 'wiki-committer', 'consolidation-gardener', 'youtube-discovery'));
