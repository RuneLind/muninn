-- Add context_tokens column to messages table
-- Stores the last turn's input tokens (actual context window usage)
-- vs input_tokens which is cumulative across all turns in multi-tool flows
ALTER TABLE messages ADD COLUMN IF NOT EXISTS context_tokens INTEGER;
