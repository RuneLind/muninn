-- Stamp each candidate's kind (Phase 2 — kind filter chips on /summaries).
--
-- `kind` mirrors the capture-time classification the watcher already computes to pick
-- per-kind capture floors (candidateKind() in src/watchers/anthropic.ts → commit /
-- release / doc / blog), plus 'x-post' for the X vertical. It was previously derived
-- and discarded; storing it lets the Candidates inbox filter one uniform column and
-- gives future X sub-kinds a home. 'x-post' is technically derivable from source='x',
-- but is stored anyway so chips filter a single `kind` (accepted redundancy — widen
-- the CHECK if a new source arrives).
--
-- Nullable: a NULL kind just falls out of every chip filter but the "All" chip.
-- Backfill below stamps every existing row so none are orphaned.
--
-- ⚠️ Mirror of db/init.sql: the column + its CHECK must exist on BOTH sides or
-- schema-drift.test.ts reds (it diffs pg_get_constraintdef by name — a column CHECK
-- auto-names summary_candidates_kind_check on both sides, and the value-set order
-- must match exactly, so keep the ARRAY order identical here and in init.sql).
ALTER TABLE summary_candidates
  ADD COLUMN kind TEXT CHECK (kind IN ('commit', 'release', 'doc', 'blog', 'x-post'));

-- Backfill: X rows → 'x-post'; anthropic (and any other) rows via URL shape, mirroring
-- candidateKind()'s ordered logic (commit → release → doc → blog fallback).
UPDATE summary_candidates
SET kind = CASE
  WHEN source = 'x' THEN 'x-post'
  WHEN url ~ 'github\.com/[^/]+/[^/]+/commit/' THEN 'commit'
  WHEN url ~ 'github\.com/[^/]+/[^/]+/releases/tag/' THEN 'release'
  WHEN url LIKE '%.md' THEN 'doc'
  ELSE 'blog'
END;
