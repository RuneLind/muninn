-- Source-drafter attempt ledger — why a captured doc has no wiki page.
--
-- The per-capture source drafter (`src/gardener/source-drafter.ts`) has four
-- outcomes, and three of them write NOTHING anywhere: a `covered`/`skipped`/`error`
-- attempt leaves no `wiki_proposals` row, so the doc simply reappears in the
-- /wiki/gardener backlog as "new" — indistinguishable from a doc the drafter never
-- ran on. The reason existed only as a log line (2026-07-31: "First, the graph
-- itself" and "Rewriting Bun in Rust" both SKIPped on a title collision with an
-- existing page, and the backlog showed nothing).
--
-- One row per (bot, collection, doc) — LATEST attempt wins (upsert on the PK). This
-- is a diagnosis surface, not an audit log: the backlog row asks "what happened last
-- time and what do I do about it", and a bounded table needs no pruning job.
--
-- `colliding_path` is what makes the answer actionable: on a title collision it is
-- the wiki-relative path of the page that blocked the draft, so the row can link
-- straight to it in the reader.
--
-- ⚠️ Mirrored in db/init.sql — identical columns + constraints + index, or
-- schema-drift.test.ts reds.
CREATE TABLE IF NOT EXISTS source_draft_attempts (
  bot_name       TEXT NOT NULL,
  collection     TEXT NOT NULL,
  doc_id         TEXT NOT NULL,
  -- drafted | covered | skipped | error (SourceDraftOutcome's discriminant).
  outcome        TEXT NOT NULL,
  -- Mirrors `SourceDraftOutcome.degraded`: a skip that BURNED model calls, as
  -- opposed to a cheap deterministic guard. Drives the row's warning styling.
  degraded       BOOLEAN NOT NULL DEFAULT FALSE,
  reason         TEXT,
  -- The encyclopedic title the drafter chose (set on `drafted` and on both
  -- collision paths, where it names the page that already owns the stem).
  title          TEXT,
  -- Wiki-relative path of the existing page that blocked this draft, when known.
  colliding_path TEXT,
  -- The `wiki_proposals` row on a `drafted` outcome. Deliberately NOT a foreign key:
  -- a rejected proposal may be pruned, and losing the attempt's reason with it would
  -- defeat the purpose of the ledger.
  proposal_id    UUID,
  -- capture | run-now | backlog | doc — which entry point ran the drafter.
  trigger_source TEXT NOT NULL DEFAULT 'capture',
  attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_name, collection, doc_id)
);

-- The backlog route reads every attempt for one bot; the PK's leading column serves
-- that. This index is for the reverse question — "what has the drafter been doing
-- lately" — on the /agents + debugging paths.
CREATE INDEX IF NOT EXISTS idx_source_draft_attempts_attempted_at
  ON source_draft_attempts (attempted_at DESC);
