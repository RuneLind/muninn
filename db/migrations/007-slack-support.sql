-- Migration: Slack support
-- Changes user_id from BIGINT to TEXT (Slack user IDs are strings like U0123ABC)
-- Adds platform column to messages

-- Messages
ALTER TABLE messages ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;

-- Activity log
ALTER TABLE activity_log ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;

-- Memories
ALTER TABLE memories ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;

-- Goals
ALTER TABLE goals ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;

-- Scheduled tasks
ALTER TABLE scheduled_tasks ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;

-- Watchers
ALTER TABLE watchers ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;

-- User settings
ALTER TABLE user_settings ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;

-- Add platform column to messages (telegram, slack, etc.)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'telegram';
