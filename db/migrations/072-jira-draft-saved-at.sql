-- The draft card in the chat: a «Lagret» mark, and a thread-keyed listing.
--
--  1. `saved_at` — the reader's «Lagre» on the card. Nothing else on the row can
--     carry it: `updated_at` moves on every write the runner makes, and `status`
--     is about the generation, not about whether a human decided to keep the
--     result. Backfilled from `created_at` on `ready` rows — those predate the
--     card and were reached through `/jira`, where reaching them WAS the save;
--     `failed`/`generating` stay null, there is nothing there to have kept.
--  2. `idx_jira_drafts_thread` — the card's listing (`GET /api/jira/drafts?
--     thread=<id>`, served OLDEST first), hit on every thread load, thread
--     switch and `response_meta`. Without it that is a seq scan on a hot path.
--
-- Rationale for the card itself: src/chat/CLAUDE.md + src/jira/wire.ts.
-- ⚠️ Mirrored in db/init.sql — identical columns + index, or
-- src/db/schema-drift.test.ts reds.

ALTER TABLE jira_drafts ADD COLUMN IF NOT EXISTS saved_at TIMESTAMPTZ;

UPDATE jira_drafts SET saved_at = created_at WHERE status = 'ready' AND saved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_jira_drafts_thread
  ON jira_drafts (thread_id, created_at DESC);
