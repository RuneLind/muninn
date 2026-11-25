-- Discuss v2 (mimir plan muninn-wiki-discuss-v2, PR 3): a wiki page's Discuss
-- runs as a chat thread. `threads.kind = 'wiki'` marks one, keyed by its wiki
-- and either a page (`rel_path`) or a trace (`trace_key`, PR 6); «Start over»
-- sets `closed_at`, and only one live thread exists per user, bot and key.
-- Existing rows default to `kind = 'chat'`: no backfill.
ALTER TABLE threads ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE threads ADD COLUMN IF NOT EXISTS wiki TEXT;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS rel_path TEXT;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS trace_key TEXT;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE threads DROP CONSTRAINT IF EXISTS threads_kind_check;
ALTER TABLE threads ADD CONSTRAINT threads_kind_check CHECK (kind IN ('chat', 'wiki'));
ALTER TABLE threads DROP CONSTRAINT IF EXISTS threads_wiki_key_check;
ALTER TABLE threads ADD CONSTRAINT threads_wiki_key_check CHECK (
  kind <> 'wiki' OR (wiki IS NOT NULL AND ((rel_path IS NULL) <> (trace_key IS NULL)))
);
-- A wiki thread is never the active thread: every chat turn resolves the
-- active thread, and the chat pipeline refuses a wiki one (D7).
ALTER TABLE threads DROP CONSTRAINT IF EXISTS threads_wiki_not_active_check;
ALTER TABLE threads ADD CONSTRAINT threads_wiki_not_active_check CHECK (NOT (kind = 'wiki' AND is_active));
CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_wiki_page ON threads (user_id, bot_name, wiki, rel_path)
  WHERE kind = 'wiki' AND closed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_wiki_trace ON threads (user_id, bot_name, wiki, trace_key)
  WHERE kind = 'wiki' AND closed_at IS NULL;

-- The ledger row of a thread's turn: deleting the thread deletes its turns
-- (they never come back as one-shot turns, `thread_id IS NULL`); the two
-- messages the turn stored are pointed at, and cleared when /chat deletes them.
ALTER TABLE wiki_discuss_turns ADD COLUMN IF NOT EXISTS thread_id UUID REFERENCES threads(id) ON DELETE CASCADE;
ALTER TABLE wiki_discuss_turns ADD COLUMN IF NOT EXISTS user_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE wiki_discuss_turns ADD COLUMN IF NOT EXISTS assistant_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE wiki_discuss_turns ADD COLUMN IF NOT EXISTS trace_key TEXT;
ALTER TABLE wiki_discuss_turns ALTER COLUMN rel_path DROP NOT NULL;
ALTER TABLE wiki_discuss_turns ALTER COLUMN page_hash DROP NOT NULL;
ALTER TABLE wiki_discuss_turns DROP CONSTRAINT IF EXISTS wiki_discuss_turns_key_check;
ALTER TABLE wiki_discuss_turns ADD CONSTRAINT wiki_discuss_turns_key_check CHECK (rel_path IS NOT NULL OR trace_key IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_wiki_discuss_turns_thread ON wiki_discuss_turns (thread_id) WHERE thread_id IS NOT NULL;
