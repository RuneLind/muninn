-- Chat preferences: per-user, per-bot preferences (connector, user selection)
-- Replaces in-memory Maps and localStorage sync for preferred connector/user

CREATE TABLE chat_preferences (
  user_id TEXT NOT NULL,
  bot_name TEXT NOT NULL,
  preferred_connector_id UUID REFERENCES connectors(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bot_name)
);

CREATE OR REPLACE FUNCTION update_chat_preferences_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_preferences_updated_at
  BEFORE UPDATE ON chat_preferences
  FOR EACH ROW
  EXECUTE FUNCTION update_chat_preferences_updated_at();
