-- Response-quality feedback: capture a ground-truth signal per assistant message.
--
-- Two capture surfaces feed one narrow side table:
--   - Telegram message reactions (👍/👎/… on the bot's reply)
--   - a lightweight 👍/👎 control on the web chat
-- Nothing consumes this yet — the point is to START accumulating labeled data so
-- a dataset exists when we do.
--
-- Reaction lookup path: Telegram reactions arrive keyed by (chat_id, message_id),
-- NOT by our DB message id. So we stamp the Telegram (chat_id, message_id) onto the
-- assistant `messages` row when we send it, and resolve reactions back through a
-- partial composite index. Storing chat_id alongside message_id is required because
-- message_id is only unique within a chat.
--
-- ⚠️ Mirrored in db/init.sql: same columns, constraints, indexes and trigger so
-- schema-drift.test.ts (which diffs both build paths structurally) stays green.
-- Column ORDER on `messages` differs by construction — init.sql places the
-- telegram columns before created_at while this migration appends them — which is
-- fine because the drift test compares columns by name, not position.

ALTER TABLE messages ADD COLUMN telegram_chat_id BIGINT;
ALTER TABLE messages ADD COLUMN telegram_message_id BIGINT;

-- Reaction lookup: resolve (chat_id, message_id) → messages.id. Partial — only the
-- assistant replies we stamped carry these ids.
CREATE INDEX idx_messages_telegram_msg ON messages (telegram_chat_id, telegram_message_id)
  WHERE telegram_message_id IS NOT NULL;

CREATE TABLE message_feedback (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  bot_name    TEXT,
  platform    TEXT,
  source      TEXT NOT NULL CHECK (source IN ('telegram_reaction', 'web')),
  value       SMALLINT NOT NULL CHECK (value IN (-1, 1)),
  raw         TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id, source)
);

CREATE INDEX idx_message_feedback_message ON message_feedback (message_id);

CREATE OR REPLACE FUNCTION update_message_feedback_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER message_feedback_updated_at
  BEFORE UPDATE ON message_feedback
  FOR EACH ROW
  EXECUTE FUNCTION update_message_feedback_updated_at();
