-- Track Anthropic prompt-cache breakdown per assistant message.
-- input_tokens already includes cache reads + creations; these columns expose
-- the breakdown so the inspector can show cache hit ratio after a reload.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER;
