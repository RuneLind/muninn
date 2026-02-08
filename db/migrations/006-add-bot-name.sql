-- Migration: Add bot_name column to all relevant tables for multi-bot isolation
-- Existing rows default to 'jarvis' since that was the only bot before this migration.

-- Messages
ALTER TABLE messages ADD COLUMN bot_name TEXT NOT NULL DEFAULT 'jarvis';
CREATE INDEX idx_messages_bot_user_created ON messages(bot_name, user_id, created_at DESC);

-- Memories
ALTER TABLE memories ADD COLUMN bot_name TEXT NOT NULL DEFAULT 'jarvis';
CREATE INDEX idx_memories_bot_user ON memories(bot_name, user_id, created_at DESC);

-- Goals
ALTER TABLE goals ADD COLUMN bot_name TEXT NOT NULL DEFAULT 'jarvis';
CREATE INDEX idx_goals_bot_user_status ON goals(bot_name, user_id, status);

-- Scheduled tasks
ALTER TABLE scheduled_tasks ADD COLUMN bot_name TEXT NOT NULL DEFAULT 'jarvis';
CREATE INDEX idx_scheduled_tasks_bot_due ON scheduled_tasks(bot_name, enabled, next_run_at) WHERE enabled = true;

-- Watchers
ALTER TABLE watchers ADD COLUMN bot_name TEXT NOT NULL DEFAULT 'jarvis';
CREATE INDEX idx_watchers_bot_due ON watchers(bot_name, enabled, last_run_at) WHERE enabled = true;

-- Activity log (optional — for filtering dashboard by bot)
ALTER TABLE activity_log ADD COLUMN bot_name TEXT;

-- Haiku usage (optional — for per-bot token tracking)
ALTER TABLE haiku_usage ADD COLUMN bot_name TEXT;
