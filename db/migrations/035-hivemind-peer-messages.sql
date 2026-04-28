-- Phase 2 of the hivemind integration. Allow inbound peer messages to be
-- persisted in the same `messages` table as user/assistant turns so they
-- appear in chat threads alongside human conversation history.
--
-- Adds a `from_peer_id` column (only set for peer messages) and extends
-- the role CHECK constraint to accept 'peer'.

ALTER TABLE messages
  ADD COLUMN from_peer_id TEXT;

ALTER TABLE messages
  DROP CONSTRAINT messages_role_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_role_check CHECK (role IN ('user', 'assistant', 'peer'));
