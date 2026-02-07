-- Goals table for tracking user goals, commitments, and deadlines
CREATE TABLE goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  deadline TIMESTAMPTZ,
  tags TEXT[] DEFAULT '{}',
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  last_checked_at TIMESTAMPTZ,
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_goals_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER goals_updated_at
  BEFORE UPDATE ON goals
  FOR EACH ROW
  EXECUTE FUNCTION update_goals_updated_at();

-- Index for fetching active goals by user
CREATE INDEX idx_goals_user_status ON goals (user_id, status);

-- Partial index for active goals approaching deadline (scheduler queries)
CREATE INDEX idx_goals_active_deadline ON goals (deadline)
  WHERE status = 'active' AND deadline IS NOT NULL;

-- Partial index for active goals needing check-in
CREATE INDEX idx_goals_active_last_checked ON goals (last_checked_at)
  WHERE status = 'active';
