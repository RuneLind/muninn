-- Messages: full conversation history
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL,
  username TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  cost_usd DOUBLE PRECISION,
  duration_ms INTEGER,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_user_created ON messages(user_id, created_at DESC);

-- Activity log: persisted version of the in-memory ring buffer
CREATE TABLE activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('message_in', 'message_out', 'error', 'system')),
  user_id BIGINT,
  username TEXT,
  text TEXT NOT NULL,
  duration_ms INTEGER,
  cost_usd DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_activity_log_created ON activity_log(created_at DESC);

-- Memories: searchable via full-text search
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  search_vector TSVECTOR,
  source_message_id UUID REFERENCES messages(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_memories_search ON memories USING GIN(search_vector);
CREATE INDEX idx_memories_user ON memories(user_id, created_at DESC);

-- Trigger to auto-update search_vector on insert/update
CREATE OR REPLACE FUNCTION memories_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    to_tsvector('english', NEW.summary || ' ' || NEW.content || ' ' || array_to_string(NEW.tags, ' '));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memories_search_vector_trigger
  BEFORE INSERT OR UPDATE ON memories
  FOR EACH ROW
  EXECUTE FUNCTION memories_search_vector_update();
