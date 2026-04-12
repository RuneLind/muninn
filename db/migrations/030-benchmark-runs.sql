-- Phase 0.4: Persistence for benchmark judge runs.
--
-- One row per (issue, candidate, judge run). Stores enough to:
--   1. List runs in the dashboard with hit_rate / highlighted_rate
--   2. Drill into per-claim verdicts (judge_result JSONB)
--   3. Link to the traces table for the underlying Sonnet call
--
-- Schema is intentionally minimal — Phase 1+ will extend with treatment
-- fields (model, stack, prompt_id, full_prompt, etc.) once the runner is
-- doing fresh analyses against worktrees, not just judging existing reports.

CREATE TABLE benchmark_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What was scored
  issue_key            TEXT NOT NULL,
  candidate_path       TEXT NOT NULL,
  gold_path            TEXT NOT NULL,
  gold_content_hash    TEXT NOT NULL,

  -- Judge configuration (versioned for reproducibility)
  judge_prompt_version TEXT NOT NULL,
  judge_model          TEXT NOT NULL,

  -- Link to the underlying Sonnet call in the traces table
  trace_id             UUID,

  -- Execution
  started_at           TIMESTAMPTZ NOT NULL,
  finished_at          TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'running',  -- running | done | error
  error                TEXT,
  wallclock_ms         INTEGER,
  input_tokens         INTEGER,
  output_tokens        INTEGER,

  -- Judged result
  judge_result         JSONB,
  hit_rate             NUMERIC,
  highlighted_rate     NUMERIC,
  found_count          INTEGER,
  partial_count        INTEGER,
  missing_count        INTEGER,
  highlighted_total    INTEGER,
  highlighted_found    INTEGER,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_benchmark_runs_issue   ON benchmark_runs (issue_key, started_at DESC);
CREATE INDEX idx_benchmark_runs_started ON benchmark_runs (started_at DESC);
CREATE INDEX idx_benchmark_runs_trace   ON benchmark_runs (trace_id);
