-- Add 'slack_channel_post' to activity_log type CHECK constraint
-- Required for Slack channel posting feature (slack/handler.ts)
BEGIN;
ALTER TABLE activity_log DROP CONSTRAINT activity_log_type_check;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_type_check
  CHECK (type IN ('message_in', 'message_out', 'error', 'system', 'slack_channel_post'));
COMMIT;
