-- Persist retrieval signals that were previously generated-then-discarded (PR2).
--
-- Two durable ledgers rescue signals that today only live transiently:
--
-- 1. `research_citations` — every source PRESENTED for a Research answer, with a
--    `cited` flag marking whether the synthesized answer actually referenced it.
--    Today `citedIndices(answer)` is computed, streamed to the browser on the SSE
--    `done` event, and then thrown away. Persisting BOTH halves — the cited AND the
--    retrieved-but-ignored — is the point: the ignored rows are the other half of
--    the "what did retrieval surface that the answer didn't need" signal.
--
-- 2. `search_signals` — per-sub-question search quality (lowConfidence / bestScore /
--    no-hits / Path-D corrective rescue). Today this lives only in `traces`
--    attributes JSONB and is hard-deleted with the 7-day trace retention cleanup.
--    A scheduled harvest (see src/db/search-signals.ts::harvestSearchSignals) rolls
--    the `search` spans into this durable ledger BEFORE cleanupOldTraces runs, so
--    "what the knowledge base couldn't confidently answer" survives past 7 days.
--
-- ⚠️ Mirror of db/init.sql: both tables + their indexes must exist on BOTH sides or
-- src/db/schema-drift.test.ts reds. Keep the two definitions byte-identical.

-- Presented Research sources, one row per (answer × source). `cited` = the answer
-- referenced this source via an inline [n] marker.
CREATE TABLE research_citations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_name    TEXT,
  user_id     TEXT,
  trace_id    UUID,
  question    TEXT,
  doc_id      TEXT NOT NULL,
  collection  TEXT NOT NULL,
  url         TEXT,
  title       TEXT,
  relevance   REAL,
  cited       BOOLEAN NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_research_citations_created ON research_citations (created_at DESC);
CREATE INDEX idx_research_citations_cited ON research_citations (cited, created_at DESC);

-- Harvested per-sub-question search quality. `span_id` is the source `traces.id`
-- and the idempotency key — the hourly harvest re-scans overlapping trace windows,
-- so ON CONFLICT (span_id) DO NOTHING makes re-runs a no-op.
CREATE TABLE search_signals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  span_id         UUID NOT NULL UNIQUE,
  trace_id        UUID,
  bot_name        TEXT,
  query           TEXT,
  collections     JSONB,
  result_count    INTEGER NOT NULL DEFAULT 0,
  best_score      REAL,
  low_confidence  BOOLEAN NOT NULL DEFAULT false,
  no_hits         BOOLEAN NOT NULL DEFAULT false,
  rescue_fired    BOOLEAN NOT NULL DEFAULT false,
  rescue_verdict  TEXT,
  rescue_retries  INTEGER,
  span_started_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_search_signals_lowconf ON search_signals (low_confidence, created_at DESC);
