-- Add 'wiki-gardener' to the watchers type constraint for the wiki-gardener
-- watcher (clusters recent summaries → drafts knowledge-wiki page proposals).
-- Mirrors init.sql: append 'wiki-gardener' at the END of the IN (...) list so the
-- constraint definition stays byte-identical to init.sql (schema-drift.test.ts
-- compares pg_get_constraintdef, which preserves value order).
ALTER TABLE watchers DROP CONSTRAINT IF EXISTS watchers_type_check;
ALTER TABLE watchers ADD CONSTRAINT watchers_type_check
  CHECK (type IN ('email', 'calendar', 'github', 'news', 'goal', 'x', 'anthropic', 'wiki-gardener'));
