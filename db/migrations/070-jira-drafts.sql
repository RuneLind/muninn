-- Jira composer drafts — the raw material, the retrieved hit set, and the task.
--
-- Two reasons this table exists, and the second is the one that makes it
-- load-bearing rather than a convenience:
--
--  1. The new Jira editor converts markdown ON PASTE but will not give raw
--     markdown back. After the paste the source exists NOWHERE ELSE, so the draft
--     has to live somewhere the reader can come back to.
--  2. Retrieval runs ONCE PER DRAFT SESSION, not once per generation. The hit set
--     is stored here and reused by a regenerate (`excludeDocIds`), because
--     re-retrieving would be nondeterministic (a fresh Haiku decomposition per
--     call) — the second run's hits could differ from the rows the reader was
--     toggling, which makes the toggle a lie.
--
-- What is stored in `citations` is the built `JiraCitation[]` at maxSources 24 —
-- the widest the feature uses — and deliberately NOT the raw `ResearchHit[]`,
-- whose `matchedChunks`/`graph_context` are unbounded `unknown[]` and would make
-- a heavy JSONB row for nothing the reader sees.
--
-- Lifecycle, stated rather than omitted: rows are small and kept indefinitely —
-- no retention knob in v1, unlike traces and prompt snapshots. `GET
-- /api/jira/draft/:id` carries `Access-Control-Allow-Origin: *` for the Chrome
-- extension (matching `/api/research/chat`), so any page the browser visits could
-- read a draft id it can guess, and drafts hold pasted meeting notes and Slack
-- threads. The bound is `DASHBOARD_HOST` defaulting to loopback. That is a stated
-- acceptance of risk on a precedent-consistent surface, not an oversight —
-- revisit it if the dashboard is ever exposed on the LAN.
--
-- ⚠️ Mirrored in db/init.sql — identical columns + constraints + index, or
-- schema-drift.test.ts reds.
CREATE TABLE IF NOT EXISTS jira_drafts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The bot that drafted it (JIRA_BOT). Kept for attribution + per-bot listing;
  -- deliberately not a FK — bots are folders, not rows.
  bot_name           TEXT NOT NULL,
  -- Template id (bug | story | task | spike, or a per-bot jiraTemplate.<id>.md).
  template           TEXT NOT NULL,
  -- ingen | skisse | full — the technical-depth axis.
  depth              TEXT NOT NULL,
  -- The reader's raw material. Bounded by JIRA_NOTES_MAX (24k) at the route.
  notes              TEXT NOT NULL,
  extra              TEXT NOT NULL DEFAULT '',
  -- generating | ready | failed. `GET /api/jira/draft/:id` reports it, and the
  -- page POLLS that endpoint rather than re-attaching to the stream: the only SSE
  -- endpoint STARTS a generation, and re-POSTing identical content would hit the
  -- single-flight 409.
  status             TEXT NOT NULL DEFAULT 'generating',
  -- The generated task, `## Referanser` included. NULL while generating.
  markdown           TEXT,
  -- JiraCitation[] at maxSources 24 — see the note above.
  citations          JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The doc ids the reader toggled OFF, as the last generation used them. Stored
  -- because `citations` is deliberately the WIDE set: without this a poll answers
  -- with 24 sources beside markdown that cites 23, and the PUT re-verification
  -- ran against the wide set — flipping an excluded key back to `verified`.
  exclude_doc_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- JiraKeyVerdict[] from the verify-keys post-pass.
  key_verdicts       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- JiraMarkdownFlag[] from the paste-subset post-pass.
  markdown_flags     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- answer | no_hits | low_confidence. The VERDICT, not a weakCoverage boolean:
  -- at low_confidence the draft is grounded-but-weak, at no_hits there is no
  -- `## Referanser` section at all, and the two render differently.
  --
  -- ⚠️ This is what RETRIEVAL found, written ONCE (`saveJiraDraftRetrieval`) and
  -- never overwritten — hence the name. The verdict for a given GENERATION is a
  -- function of it and the exclusion set that run used, derived at read time by
  -- `effectiveCoverage` (src/jira/wire.ts). Storing the derived value here is
  -- what made the composer latch: one regenerate with every source toggled off
  -- wrote `no_hits`, the next read it back as the retrieval verdict, and the
  -- draft stayed `no_hits` with a full `## Referanser` underneath it.
  retrieval_coverage TEXT,
  -- The condensed retrieval question (query.ts), shown so the reader can see
  -- what was actually searched.
  retrieval_question TEXT NOT NULL DEFAULT '',
  -- Failure reason on `status = 'failed'`.
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only list query v1 needs: newest drafts, for a future /jira history pane.
CREATE INDEX IF NOT EXISTS idx_jira_drafts_created_at
  ON jira_drafts (created_at DESC);
