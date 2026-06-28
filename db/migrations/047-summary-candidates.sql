-- Summary candidates — the Candidates → Summaries inbox (Claude Learning Center, Phase B).
--
-- The anthropic watcher already discovers + scores + writes a "why" for every new
-- item, then discards it after alerting. With config.captureCandidates on (the
-- Highlights row), it persists each gated candidate here instead, forming a ranked,
-- pre-annotated reading queue surfaced on /summaries. status walks
-- new → summarizing → summarized | dismissed | error; doc_id links the resulting
-- anthropic-summaries doc once a candidate is summarized (Phase C/D).
--
-- watcher_id is ON DELETE SET NULL (provenance, not ownership — losing the watcher
-- must not delete the captured backlog). UNIQUE (source, url) = candidate identity;
-- the watcher upserts and keeps the max score.
--
-- ⚠️ Mirror of db/init.sql: identical column order + constraints + index so
-- schema-drift.test.ts (which diffs the live schema against init.sql) stays green.
CREATE TABLE summary_candidates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL,
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  candidate_src TEXT,
  score         REAL NOT NULL,
  why           TEXT,
  status        TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'summarizing', 'summarized', 'dismissed', 'error')),
  doc_id        TEXT,
  watcher_id    UUID REFERENCES watchers(id) ON DELETE SET NULL,
  bot_name      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, url)
);

CREATE INDEX idx_summary_candidates_status ON summary_candidates (status, score DESC);
