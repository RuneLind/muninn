-- Scheduled tasks: cron-style or interval-based recurring tasks
CREATE TABLE scheduled_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('reminder', 'briefing', 'custom')),
  prompt TEXT,
  schedule_hour INT NOT NULL CHECK (schedule_hour >= 0 AND schedule_hour <= 23),
  schedule_minute INT NOT NULL DEFAULT 0 CHECK (schedule_minute >= 0 AND schedule_minute <= 59),
  schedule_days INT[] DEFAULT NULL,  -- 0=Sun..6=Sat, NULL=every day
  schedule_interval_ms BIGINT DEFAULT NULL,  -- repeat every N ms (alternative to cron-style)
  timezone TEXT NOT NULL DEFAULT 'Europe/Oslo',
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_scheduled_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scheduled_tasks_updated_at
  BEFORE UPDATE ON scheduled_tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_scheduled_tasks_updated_at();

-- Indexes for scheduler queries
CREATE INDEX idx_scheduled_tasks_due ON scheduled_tasks (enabled, next_run_at)
  WHERE enabled = true;
CREATE INDEX idx_scheduled_tasks_user ON scheduled_tasks (user_id, enabled);
