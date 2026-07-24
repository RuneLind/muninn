-- Add 'consolidation-gardener' to the watchers type constraint for the weekly
-- consolidation-gardener watcher (clusters a wiki's OWN pages into synthesis-page
-- proposals; sibling of wiki-gardener/wiki-linter/wiki-committer). Mirrors
-- init.sql: append 'consolidation-gardener' at the END of the IN (...) list so the
-- constraint definition stays byte-identical to init.sql (schema-drift.test.ts
-- compares pg_get_constraintdef, which preserves order).
ALTER TABLE watchers DROP CONSTRAINT IF EXISTS watchers_type_check;
ALTER TABLE watchers ADD CONSTRAINT watchers_type_check
  CHECK (type IN ('email', 'calendar', 'github', 'news', 'goal', 'x', 'anthropic', 'wiki-gardener', 'wiki-linter', 'wiki-committer', 'consolidation-gardener'));
