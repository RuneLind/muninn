-- Saved fact-check results for /summaries documents — one row per document; a
-- re-check replaces it (upsert on the primary key).
--
-- Keyed (collection, doc_id), not (collection, url): `doc_id` is huginn's file
-- path (`<category>/<title>.md`), which the doc panel already addresses every
-- document by, which a re-run keeps (it pins title + category), and which a
-- pasted `article` capture has even when it has no url. `url` rides along for
-- PR 2's write-back and for a reader of the table.
--
-- `body_sha256` hashes the CHECKED text (the source file's summary, cut above
-- `## Transcript` and `## Visual reference`), so `/result` can say "stale" when
-- the summary changed since the check.
--
-- ⚠️ Mirrored in db/init.sql — identical columns + constraints + index, or
-- schema-drift.test.ts reds.
CREATE TABLE IF NOT EXISTS summary_factchecks (
  collection   TEXT NOT NULL,
  doc_id       TEXT NOT NULL,
  url          TEXT,
  body_sha256  TEXT NOT NULL,
  -- The assembled fact-check markdown (lede + per-claim verdict blocks).
  answer       TEXT NOT NULL,
  -- [{index, title, quote?, verdict, outcome, confidence?, sources[]}]
  claims       JSONB NOT NULL DEFAULT '[]'::jsonb,
  bot_name     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, doc_id)
);
