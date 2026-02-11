-- Add platform column to goals and scheduled_tasks
-- Default 'telegram' covers all existing rows (which are all from Telegram)
ALTER TABLE goals ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'telegram';
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'telegram';

-- Fix any pre-existing rows with Slack user IDs that got the wrong default
UPDATE goals SET platform = 'slack' WHERE user_id ~ '^U[A-Z0-9]+$' AND platform = 'telegram';
UPDATE scheduled_tasks SET platform = 'slack' WHERE user_id ~ '^U[A-Z0-9]+$' AND platform = 'telegram';
