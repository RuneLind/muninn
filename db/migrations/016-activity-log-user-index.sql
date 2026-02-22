-- Add index for getUserOverview queries that filter by user_id + bot_name
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_log_user
  ON activity_log(user_id, bot_name, created_at DESC);
