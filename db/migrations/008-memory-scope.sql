-- Add scope column to memories: 'personal' (default) or 'shared'
ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal'
  CHECK (scope IN ('personal', 'shared'));

-- Index for efficient shared memory queries per bot
CREATE INDEX idx_memories_bot_shared ON memories(bot_name, created_at DESC)
  WHERE scope = 'shared';
