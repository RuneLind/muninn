-- 009: Add index on messages.platform for analytics queries
CREATE INDEX IF NOT EXISTS idx_messages_platform ON messages (platform);
CREATE INDEX IF NOT EXISTS idx_messages_platform_created ON messages (platform, created_at);
