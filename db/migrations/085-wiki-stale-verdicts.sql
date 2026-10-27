-- The Stale check's verdicts (plan muninn-wiki-drift-check, PR 2a): one row per
-- model or reader verdict on a status line (`status-line`) or a linking page's
-- passage (`passage`), and, from PR 3, an applied fix (`fixed`). Still true and
-- Not a status are rows too, written by the reader.
--
-- Keyed by CONTENT, never by commit (D22): `key_hash` is sha256 over what the
-- verdict was about — a status line: the page, the line's text, the target
-- plan and its `plan_status`; a passage: the linking page, the passage text and
-- the changed page's content hash (body, `plan_status`, `status_note`). A
-- routine frontmatter stamp changes none of those, so it resets no verdict.
-- Written by upsert on the unique key; rows older than 90 days leave through
-- `retention-cleanup`.
--
-- ⚠️ Mirrored in db/init.sql — identical columns + constraints + index, or
-- schema-drift.test.ts reds.
CREATE TABLE IF NOT EXISTS wiki_stale_verdicts (
  id          BIGSERIAL PRIMARY KEY,
  wiki        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('status-line', 'passage', 'fixed')),
  page        TEXT NOT NULL,
  key_hash    TEXT NOT NULL,
  verdict     TEXT NOT NULL CHECK (verdict IN ('stale', 'unsure', 'true', 'not-status', 'fixed')),
  reason      TEXT NOT NULL DEFAULT '',
  edit        JSONB,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_by  TEXT NOT NULL,
  UNIQUE (wiki, kind, key_hash)
);

CREATE INDEX IF NOT EXISTS idx_wiki_stale_verdicts_checked ON wiki_stale_verdicts (checked_at);
