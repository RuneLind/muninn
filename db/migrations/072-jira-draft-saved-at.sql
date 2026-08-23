-- The draft card in the chat: a «Lagret» mark, and a thread-keyed listing.
--
-- The draft now lives as a CARD under the assistant bubble it came from, in the
-- web chat itself — the finalized text (fence stripped, `[n]` repaired,
-- `## Referanser` appended) delivered where the conversation is, instead of
-- behind a hand-off to `/jira`. Two schema consequences:
--
--  1. `saved_at` — the reader's «Lagre». The card's own state has to SURVIVE a
--     reload, and nothing on the row could carry it: `updated_at` moves on every
--     write the runner makes, and `status` is about the generation, not about
--     whether a human decided to keep the result. A nullable timestamp is the
--     whole feature: null ⇒ not saved, set ⇒ saved, and the moment is worth
--     keeping over a boolean because it dates the decision.
--
--     Backfilled from `created_at` for every `ready` row: those drafts predate the
--     card and were all reached through `/jira`, where reaching them at all WAS
--     the save. Marking them saved is the honest reading; marking them unsaved
--     would invite a reader to "save" a draft nobody is going to look at again.
--     `failed` and `generating` rows are deliberately left null — there is
--     nothing there to have kept.
--
--  2. `idx_jira_drafts_thread` — the card's listing. On every thread load, thread
--     switch and `response_meta`, the chat asks `GET /api/jira/drafts?thread=<id>`
--     for every draft on the thread, so the poller is keyed on the DRAFT rather
--     than on "this tab is the one that clicked". Without the index that is a seq
--     scan over the whole table on a hot client path.
--
-- ⚠️ Mirrored in db/init.sql — identical columns + index, or
-- src/db/schema-drift.test.ts reds.

ALTER TABLE jira_drafts ADD COLUMN IF NOT EXISTS saved_at TIMESTAMPTZ;

UPDATE jira_drafts SET saved_at = created_at WHERE status = 'ready' AND saved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_jira_drafts_thread
  ON jira_drafts (thread_id, created_at DESC);
