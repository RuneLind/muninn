-- Muninn database schema
-- Consolidated from supabase/migrations/00001-00005

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- Users: canonical source of user identity
-- ============================================================================
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT,
  platform TEXT NOT NULL DEFAULT 'web',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);

CREATE INDEX idx_users_platform ON users(platform);
CREATE INDEX idx_users_last_seen ON users(last_seen_at DESC);

CREATE OR REPLACE FUNCTION update_users_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_users_updated_at();

-- ============================================================================
-- Connectors: named AI connector configurations
-- ============================================================================
CREATE TABLE connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  connector_type TEXT NOT NULL,
  model TEXT,
  base_url TEXT,
  thinking_max_tokens INTEGER,
  timeout_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_connectors_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER connectors_updated_at
  BEFORE UPDATE ON connectors
  FOR EACH ROW
  EXECUTE FUNCTION update_connectors_updated_at();

-- ============================================================================
-- Threads: isolated conversation contexts per topic
-- (must be created before messages, which has a FK reference)
-- ============================================================================
CREATE TABLE threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  bot_name TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  connector_id UUID REFERENCES connectors(id),
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one active thread per user+bot
CREATE UNIQUE INDEX idx_threads_active ON threads(user_id, bot_name)
  WHERE is_active = true;

-- Unique thread names per user+bot
CREATE UNIQUE INDEX idx_threads_name ON threads(user_id, bot_name, name);

CREATE INDEX idx_threads_user_bot ON threads(user_id, bot_name, updated_at DESC);

CREATE OR REPLACE FUNCTION update_threads_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER threads_updated_at
  BEFORE UPDATE ON threads
  FOR EACH ROW
  EXECUTE FUNCTION update_threads_updated_at();

-- ============================================================================
-- Messages: full conversation history
-- ============================================================================
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  bot_name TEXT NOT NULL DEFAULT 'jarvis',
  username TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  cost_usd DOUBLE PRECISION,
  duration_ms INTEGER,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  source TEXT DEFAULT NULL,
  platform TEXT DEFAULT 'telegram',
  thread_id UUID REFERENCES threads(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_user_created ON messages(user_id, created_at DESC);
CREATE INDEX idx_messages_bot_user_created ON messages(bot_name, user_id, created_at DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id, created_at DESC);

-- ============================================================================
-- Activity log: persisted version of the in-memory ring buffer
-- ============================================================================
CREATE TABLE activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('message_in', 'message_out', 'error', 'system', 'slack_channel_post')),
  user_id TEXT,
  bot_name TEXT,
  username TEXT,
  text TEXT NOT NULL,
  duration_ms INTEGER,
  cost_usd DOUBLE PRECISION,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_activity_log_created ON activity_log(created_at DESC);
CREATE INDEX idx_activity_log_user ON activity_log(user_id, bot_name, created_at DESC);

-- ============================================================================
-- Memories: searchable via full-text search + vector embeddings
-- ============================================================================
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  bot_name TEXT NOT NULL DEFAULT 'jarvis',
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  search_vector TSVECTOR,
  embedding vector(384),
  source_message_id UUID REFERENCES messages(id),
  scope TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'shared')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_memories_search ON memories USING GIN(search_vector);
CREATE INDEX idx_memories_user ON memories(user_id, created_at DESC);
CREATE INDEX idx_memories_bot_user ON memories(bot_name, user_id, created_at DESC);
CREATE INDEX idx_memories_embedding ON memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_memories_bot_shared ON memories(bot_name, created_at DESC)
  WHERE scope = 'shared';

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

-- ============================================================================
-- Goals: tracking user goals, commitments, and deadlines
-- ============================================================================
CREATE TABLE goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  bot_name TEXT NOT NULL DEFAULT 'jarvis',
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  deadline TIMESTAMPTZ,
  tags TEXT[] DEFAULT '{}',
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  platform TEXT DEFAULT 'telegram',
  last_checked_at TIMESTAMPTZ,
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

CREATE INDEX idx_goals_user_status ON goals (user_id, status);
CREATE INDEX idx_goals_bot_user_status ON goals (bot_name, user_id, status);
CREATE INDEX idx_goals_active_deadline ON goals (deadline)
  WHERE status = 'active' AND deadline IS NOT NULL;
CREATE INDEX idx_goals_active_last_checked ON goals (last_checked_at)
  WHERE status = 'active';

-- ============================================================================
-- Scheduled tasks: cron-style or interval-based recurring tasks
-- ============================================================================
CREATE TABLE scheduled_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  bot_name TEXT NOT NULL DEFAULT 'jarvis',
  title TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('reminder', 'briefing', 'custom')),
  prompt TEXT,
  schedule_hour INT NOT NULL CHECK (schedule_hour >= 0 AND schedule_hour <= 23),
  schedule_minute INT NOT NULL DEFAULT 0 CHECK (schedule_minute >= 0 AND schedule_minute <= 59),
  schedule_days INT[] DEFAULT NULL,
  schedule_interval_ms BIGINT DEFAULT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/Oslo',
  platform TEXT DEFAULT 'telegram',
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

CREATE INDEX idx_scheduled_tasks_due ON scheduled_tasks (enabled, next_run_at)
  WHERE enabled = true;
CREATE INDEX idx_scheduled_tasks_bot_due ON scheduled_tasks (bot_name, enabled, next_run_at)
  WHERE enabled = true;
CREATE INDEX idx_scheduled_tasks_user ON scheduled_tasks (user_id, enabled);

-- ============================================================================
-- Haiku usage: token tracking for async background calls
-- ============================================================================
CREATE TABLE haiku_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL, -- 'memory', 'goals', 'schedule', 'task', 'briefing', 'reminder', 'checkin'
  bot_name TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_haiku_usage_created ON haiku_usage(created_at DESC);

-- ============================================================================
-- Watchers: registered background monitors (email, calendar, etc.)
-- ============================================================================
CREATE TABLE watchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  bot_name TEXT NOT NULL DEFAULT 'jarvis',
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('email', 'calendar', 'github', 'news', 'goal')),
  config JSONB NOT NULL DEFAULT '{}',
  interval_ms INTEGER NOT NULL DEFAULT 300000,  -- 5 min default
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  last_notified_ids JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_watchers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER watchers_updated_at
  BEFORE UPDATE ON watchers
  FOR EACH ROW
  EXECUTE FUNCTION update_watchers_updated_at();

CREATE INDEX idx_watchers_due ON watchers (enabled, last_run_at)
  WHERE enabled = true;
CREATE INDEX idx_watchers_bot_due ON watchers (bot_name, enabled, last_run_at)
  WHERE enabled = true;
CREATE INDEX idx_watchers_user ON watchers (user_id, enabled);

-- ============================================================================
-- User settings: quiet hours, timezone preferences
-- ============================================================================
CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY,
  quiet_start INTEGER CHECK (quiet_start >= 0 AND quiet_start <= 23),
  quiet_end INTEGER CHECK (quiet_end >= 0 AND quiet_end <= 23),
  timezone TEXT NOT NULL DEFAULT 'Europe/Oslo',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_user_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_settings_updated_at
  BEFORE UPDATE ON user_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_user_settings_updated_at();

-- ============================================================================
-- Traces: observability spans for request tracing
-- ============================================================================
CREATE TABLE traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id UUID NOT NULL,
  parent_id UUID,  -- no FK: spans are inserted fire-and-forget, child may arrive before parent
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'span',  -- 'root' | 'span' | 'event'
  status TEXT NOT NULL DEFAULT 'ok',   -- 'ok' | 'error'
  bot_name TEXT,
  user_id TEXT,
  username TEXT,
  platform TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER,
  attributes JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_traces_trace_id ON traces (trace_id, started_at);
CREATE INDEX idx_traces_root ON traces (started_at DESC) WHERE parent_id IS NULL;
CREATE INDEX idx_traces_bot ON traces (bot_name, started_at DESC) WHERE parent_id IS NULL;

-- ============================================================================
-- Prompt snapshots: full system + user prompts per trace for inspection
-- No FK on trace_id — snapshots have shorter retention (3d) than traces (7d),
-- so traces may be deleted while snapshots still exist, and vice versa.
-- ============================================================================
CREATE TABLE prompt_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id UUID NOT NULL,
  system_prompt TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_prompt_snapshots_trace ON prompt_snapshots (trace_id);
CREATE INDEX idx_prompt_snapshots_created ON prompt_snapshots (created_at DESC);

-- ============================================================================
-- Schema migrations: tracks which migrations have been applied
-- ============================================================================
CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
