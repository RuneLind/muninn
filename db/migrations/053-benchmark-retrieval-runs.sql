-- Retrieval eval: persistence for the offline retrieval golden-set runs.
--
-- One row per `runRetrievalEval` invocation. Stores the aggregate metrics
-- (recall@k / hit-rate / MRR, per-target + overall) plus a per-query
-- breakdown so a regression can be traced back to the individual query that
-- moved. Deliberately mirrors the `benchmark_runs` conventions (UUID id,
-- started/finished timestamps, status enum, JSONB result blobs).
--
-- Intentionally NOT added to db/init.sql: like benchmark_runs (030-034) this
-- is experimental tooling that fresh deploys don't carry, and the
-- schema-drift guard excludes `benchmark_*` tables for exactly this reason.
-- Migration-only is the whole truth for this table.

CREATE TABLE benchmark_retrieval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Execution lifecycle
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running',  -- running | done | error
  error           TEXT,

  -- What was run
  target_filter   TEXT,                             -- huginn | memories | research | NULL (= all)
  query_count     INTEGER NOT NULL DEFAULT 0,
  huginn_base_url TEXT,

  -- Results
  metrics         JSONB,                            -- { overall, perTarget } aggregates
  per_query       JSONB,                            -- [{ id, target, hitAtK, recallAtK, reciprocalRank, ... }]

  notes           TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_benchmark_retrieval_runs_started ON benchmark_retrieval_runs (started_at DESC);
