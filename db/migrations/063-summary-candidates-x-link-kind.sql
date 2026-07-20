-- Add 'x-link' to the summary_candidates.kind CHECK (PR 3 — pointer tweets).
--
-- A "pointer tweet" is a short tweet whose value is the external link it points at
-- (a 28-min video, an article), not its own text. Previously structurally excluded
-- from capture (isLongFormTweet requires long body/note; link-tweets are neither).
-- The X watcher now captures top-author link-tweets under kind 'x-link'; the
-- summarizer already treats the linked content as the primary subject for this kind.
--
-- Mechanics (mirror of migration 045's watcher-type drop+add): migration 049 added
-- `kind` as an inline column CHECK, so the constraint is auto-named
-- `summary_candidates_kind_check`. To extend the value set we DROP that named
-- constraint and re-ADD it with the SAME explicit name and 'x-link' appended at the
-- END of the value list — schema-drift.test.ts diffs pg_get_constraintdef BY NAME
-- and preserves value order, so the ADD must match db/init.sql's line byte-for-byte
-- (identical value-set order, 'x-link' last).
ALTER TABLE summary_candidates DROP CONSTRAINT IF EXISTS summary_candidates_kind_check;
ALTER TABLE summary_candidates ADD CONSTRAINT summary_candidates_kind_check
  CHECK (kind IN ('commit', 'release', 'doc', 'blog', 'x-post', 'x-link'));
