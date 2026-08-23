-- The Jira draft as a TURN IN A THREAD, and the citation signal that makes it
-- possible.
--
-- A Jira task is almost never written from notes: it is DISCUSSED first, in the
-- melosys web chat, which retrieves over the same three collections through the
-- `research_knowledge` MCP tool. Condensing that thread back into notes and
-- re-retrieving throws away both halves of what the conversation already did —
-- the retrieval, and the adjustments the person made to the answer. So the draft
-- becomes a turn in the thread rather than a product of it.
--
-- Two schema consequences:
--
--  1. `research_citations.thread_id` — the tool's own hits, persisted. Today only
--     `/research` ask writes this table (`persistResearchCitations`); the chat's
--     `research_knowledge` handler writes nothing, and trace tool-span outputs are
--     truncated to a `_truncated` head, so a thread's citations cannot be
--     reconstructed after the fact. Nullable: every existing row (and every
--     /research ask row from here on) carries no thread.
--
--  2. `jira_drafts.thread_id` / `.message_id` / `.source` — where a thread-sourced
--     draft came from and which assistant message currently IS the draft. `source`
--     is `notes` | `thread`; the DEFAULT keeps every pre-existing row honest,
--     since they were all written from pasted raw material.
--
-- `message_id` is re-pointed by a regenerate (which is another thread turn), so
-- it always names the message whose text the row's `markdown` was taken from.
-- No FKs, matching the table's existing style — a deleted thread leaves an
-- orphaned pointer the read side simply resolves to null.
--
-- ⚠️ Mirrored in db/init.sql — identical columns + index, or
-- src/db/schema-drift.test.ts reds.

ALTER TABLE research_citations ADD COLUMN IF NOT EXISTS thread_id UUID;

-- The read pattern is "every citation this thread ever retrieved, oldest first".
CREATE INDEX IF NOT EXISTS idx_research_citations_thread
  ON research_citations (thread_id, created_at DESC);

ALTER TABLE jira_drafts ADD COLUMN IF NOT EXISTS thread_id UUID;
ALTER TABLE jira_drafts ADD COLUMN IF NOT EXISTS message_id UUID;
ALTER TABLE jira_drafts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'notes';
