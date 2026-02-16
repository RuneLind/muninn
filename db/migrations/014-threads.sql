-- Add conversation threads: isolated chat history per topic, shared memories/goals
-- Each user+bot pair gets multiple named threads with independent message history.

-- ============================================================================
-- Threads table
-- ============================================================================
CREATE TABLE threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  bot_name TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one active thread per user+bot
CREATE UNIQUE INDEX idx_threads_active ON threads(user_id, bot_name)
  WHERE is_active = true;

-- Unique thread names per user+bot
CREATE UNIQUE INDEX idx_threads_name ON threads(user_id, bot_name, name);

CREATE INDEX idx_threads_user_bot ON threads(user_id, bot_name, updated_at DESC);

CREATE OR REPLACE FUNCTION update_threads_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER threads_updated_at
  BEFORE UPDATE ON threads
  FOR EACH ROW
  EXECUTE FUNCTION update_threads_updated_at();

-- ============================================================================
-- Add thread_id to messages
-- ============================================================================
ALTER TABLE messages ADD COLUMN thread_id UUID REFERENCES threads(id) ON DELETE SET NULL;

CREATE INDEX idx_messages_thread ON messages(thread_id, created_at DESC);
