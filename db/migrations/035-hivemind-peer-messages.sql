ALTER TABLE messages
  ADD COLUMN from_peer_id TEXT;

ALTER TABLE messages
  DROP CONSTRAINT messages_role_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_role_check CHECK (role IN ('user', 'assistant', 'peer'));
