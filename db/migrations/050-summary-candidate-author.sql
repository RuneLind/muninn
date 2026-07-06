-- Author transparency for X candidates (Phase 3 — author tier badges + "Top authors"
-- filter on /summaries).
--
-- `author`       — the normalized (lowercased, bare, no `@`) X handle, i.e. the key into
--                  huginn's `x-feed-author-scores.json`. NULL for anthropic rows and for
--                  X rows whose heading had no handle ("unknown").
-- `author_score` — a capture-time snapshot of that author's huginn ranking score (0–1).
--                  Nullable: unknown handle, an author absent from the ranking, or the
--                  scores file unavailable at capture time.
--
-- The score is NOT re-derived for display — the page tiers it against the CURRENT
-- percentile cuts, so a boundary tier can drift slightly between capture and render
-- (accepted). The signal is transparency + filtering only; it never re-sorts candidates.
--
-- ⚠️ Mirror of db/init.sql: both columns must exist on BOTH sides or schema-drift.test.ts
-- reds. Both are plain nullable columns (no CHECK), so only presence + type must match.
ALTER TABLE summary_candidates
  ADD COLUMN author       TEXT,
  ADD COLUMN author_score REAL;

-- Backfill `author` from candidate_src ('X (@handle)') for existing X rows — a pure-SQL
-- parse. `author_score` needs the huginn JSON lookup and is populated separately by
-- scripts/backfill-candidate-authors.ts (run manually). "X (unknown)" has no `@` and so
-- won't match the pattern, correctly leaving author NULL.
UPDATE summary_candidates
SET author = lower(substring(candidate_src FROM 'X \(@([^)]+)\)'))
WHERE source = 'x'
  AND candidate_src ~ 'X \(@[^)]+\)';
