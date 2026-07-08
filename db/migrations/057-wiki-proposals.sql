-- Wiki-gardener proposals: drafted knowledge-wiki pages awaiting review.
-- The gardener clusters recent summaries and drafts concept/entity pages as
-- rows here; PR 2 adds the web review gate + apply step. Mirrored in init.sql
-- (schema-drift.test.ts requires both sides to converge).
CREATE TABLE wiki_proposals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_name      TEXT NOT NULL,
  topic_key     TEXT NOT NULL,           -- stable slug for dedup across runs
  kind          TEXT NOT NULL,           -- concept | entity
  mode          TEXT NOT NULL,           -- create | update
  target_path   TEXT NOT NULL,           -- wiki-relative, e.g. concepts/Context Compaction.md
  base_hash     TEXT,                    -- sha256 of target file at draft time (update mode)
  draft         TEXT NOT NULL,           -- full file body incl. frontmatter
  source_docs   JSONB NOT NULL,          -- [{collection, docId, title, url}]
  rationale     TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',  -- draft|approved|applied|rejected|stale|error
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX ON wiki_proposals (bot_name, status);
CREATE UNIQUE INDEX ON wiki_proposals (bot_name, topic_key) WHERE status IN ('draft', 'approved');
