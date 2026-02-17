-- Backfill: create "main" threads for all user+bot combos that have messages
-- with NULL thread_id but no "main" thread, then link those orphaned messages.

-- Step 1: Create missing "main" threads
INSERT INTO threads (user_id, bot_name, name, is_active)
SELECT DISTINCT m.user_id, m.bot_name, 'main', false
FROM messages m
WHERE m.thread_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM threads t
    WHERE t.user_id = m.user_id AND t.bot_name = m.bot_name AND t.name = 'main'
  )
ON CONFLICT (user_id, bot_name, name) DO NOTHING;

-- Step 2: Activate "main" thread for user+bot combos that have no active thread
UPDATE threads SET is_active = true
WHERE name = 'main'
  AND NOT EXISTS (
    SELECT 1 FROM threads t2
    WHERE t2.user_id = threads.user_id AND t2.bot_name = threads.bot_name AND t2.is_active = true
  );

-- Step 3: Link orphaned messages to their "main" thread
UPDATE messages SET thread_id = t.id
FROM threads t
WHERE messages.thread_id IS NULL
  AND t.user_id = messages.user_id
  AND t.bot_name = messages.bot_name
  AND t.name = 'main';
