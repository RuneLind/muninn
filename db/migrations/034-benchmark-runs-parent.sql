-- Re-judge support: link child runs to the parent analysis row they were
-- scored against. Each re-judge pass gets its own benchmark_runs row with
-- parent_run_id set; the parent row stays untouched so the original verdict
-- is preserved for audit.
--
-- Why a self-referential FK instead of a separate rejudge_passes table:
-- every field we want to record for a re-judge pass is already a column on
-- benchmark_runs (hit_rate, judge_result, trace_id, judge_prompt_version,
-- wallclock_ms, tokens). Adding a second table would duplicate the schema
-- and complicate the list-view query. A parent pointer keeps the list-view
-- query simple: `WHERE parent_run_id IS NULL` hides the re-judge rows from
-- the top-level view by default.

ALTER TABLE benchmark_runs
  ADD COLUMN parent_run_id UUID REFERENCES benchmark_runs(id) ON DELETE CASCADE;

-- Lookup children of a given parent. Partial index — most rows have
-- parent_run_id NULL, so a partial index is cheaper than a full-column one.
CREATE INDEX idx_benchmark_runs_parent
  ON benchmark_runs (parent_run_id)
  WHERE parent_run_id IS NOT NULL;
