-- Link assistant messages to their request trace for tool call history
ALTER TABLE messages ADD COLUMN IF NOT EXISTS trace_id UUID;
CREATE INDEX IF NOT EXISTS idx_messages_trace_id ON messages (trace_id) WHERE trace_id IS NOT NULL;
