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

CREATE UNIQUE INDEX idx_connectors_unique_config
  ON connectors (connector_type, COALESCE(model, ''), COALESCE(base_url, ''));

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
  auto_respond_paused BOOLEAN NOT NULL DEFAULT false,
  pause_reason TEXT,
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
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'peer')),
  content TEXT NOT NULL,
  cost_usd DOUBLE PRECISION,
  duration_ms INTEGER,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  context_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  source TEXT DEFAULT NULL,
  platform TEXT DEFAULT 'telegram',
  thread_id UUID REFERENCES threads(id) ON DELETE SET NULL,
  trace_id UUID,
  from_peer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_user_created ON messages(user_id, created_at DESC);
CREATE INDEX idx_messages_bot_user_created ON messages(bot_name, user_id, created_at DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id, created_at DESC);
CREATE INDEX idx_messages_trace_id ON messages (trace_id) WHERE trace_id IS NOT NULL;
-- Platform analytics indexes (from migration 009-platform-index.sql)
CREATE INDEX idx_messages_platform ON messages (platform);
CREATE INDEX idx_messages_platform_created ON messages (platform, created_at);

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
  type TEXT NOT NULL CHECK (type IN ('email', 'calendar', 'github', 'news', 'goal', 'x', 'anthropic')),
  config JSONB NOT NULL DEFAULT '{}',
  interval_ms INTEGER NOT NULL DEFAULT 300000,  -- 5 min default
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  last_notified_ids JSONB DEFAULT '[]',
  force_next_run BOOLEAN NOT NULL DEFAULT false,
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
-- Watcher snapshots: large per-watcher baseline SETs (anthropic Tier-2 diff).
-- Stores the ~1753-URL llms.txt doc set + blog slug sets the Tier-2 diff
-- compares against each run — NOT in last_notified_ids (400-cap, shared with
-- Tier-1 dedup) and NOT in config (updateWatcher overwrites the whole blob).
-- ⚠️ Mirror of db/migrations/046-watcher-snapshots.sql: identical column order +
-- PK + FK or schema-drift.test.ts reds.
-- ============================================================================
CREATE TABLE watcher_snapshots (
  watcher_id UUID NOT NULL REFERENCES watchers(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (watcher_id, key)
);

-- ============================================================================
-- Summary candidates: the Candidates → Summaries inbox (Claude Learning Center).
-- The anthropic watcher (config.captureCandidates) persists each gated candidate
-- here — a ranked, pre-annotated reading queue surfaced on /summaries. status walks
-- new → summarizing → summarized | dismissed | error; doc_id links the resulting
-- anthropic-summaries doc once summarized. watcher_id is ON DELETE SET NULL
-- (provenance, not ownership). ⚠️ Mirror of db/migrations/047-summary-candidates.sql:
-- identical column order + constraints + index or schema-drift.test.ts reds.
-- ============================================================================
CREATE TABLE summary_candidates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL,
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  candidate_src TEXT,
  score         REAL NOT NULL,
  why           TEXT,
  status        TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'summarizing', 'summarized', 'dismissed', 'error')),
  doc_id        TEXT,
  source_doc_id TEXT,
  watcher_id    UUID REFERENCES watchers(id) ON DELETE SET NULL,
  bot_name      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, url)
);

CREATE INDEX idx_summary_candidates_status ON summary_candidates (status, score DESC);

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
-- Chat preferences: per-user, per-bot preferences (connector selection)
-- ============================================================================
CREATE TABLE chat_preferences (
  user_id TEXT NOT NULL,
  bot_name TEXT NOT NULL,
  preferred_connector_id UUID REFERENCES connectors(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bot_name)
);

CREATE OR REPLACE FUNCTION update_chat_preferences_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_preferences_updated_at
  BEFORE UPDATE ON chat_preferences
  FOR EACH ROW
  EXECUTE FUNCTION update_chat_preferences_updated_at();

-- ============================================================================
-- Bot default user: single source of truth for plugin + chat page
-- ============================================================================
CREATE TABLE bot_default_user (
  bot_name TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Peer-reply correlation: maps an outbound (bot, peer) to the originating
-- thread so an inbound reply routes back there instead of the default
-- peer:<ns>/<name> bucket. Durable so it survives muninn restarts + long peer
-- delays. No FK on thread_id — the router validates + lazily clears stale rows.
-- ============================================================================
CREATE TABLE peer_thread_correlation (
  bot_name   TEXT        NOT NULL,
  peer_id    TEXT        NOT NULL,
  thread_id  UUID        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_name, peer_id)
);

CREATE INDEX idx_peer_thread_correlation_expires
  ON peer_thread_correlation (expires_at);

-- ============================================================================
-- Precise peer-reply correlation via opaque minted tokens. An initiating
-- outbound mints a fresh correlation_id, sends it on the wire, and stores
-- token → originating thread here; the peer's reply echoes the token and the
-- router resolves it to the exact thread (no last-write-wins collision).
-- Primary path; peer_thread_correlation above stays as the (bot, peer) un-echoed
-- fallback. Grows one row per outbound, so it has its own expires_at sweep
-- (cleanup runs opportunistically on insert). No FK on thread_id — the router
-- validates + lazily clears stale rows.
-- ============================================================================
CREATE TABLE peer_correlation_tokens (
  bot_name       TEXT        NOT NULL,
  correlation_id TEXT        NOT NULL,
  thread_id      UUID        NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_name, correlation_id)
);

CREATE INDEX idx_peer_correlation_tokens_expires
  ON peer_correlation_tokens (expires_at);

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
-- Spec-driven dev loop: control/state plane for the closed ATDD loop.
-- dev_runs is the run aggregate (born at research-thread creation, spans the
-- whole arc); dev_run_handoffs is one row per outbound build|test|orchestrate
-- handoff. dev_runs.status is a DERIVED rollup (computeRunStatus) of the
-- handoff rows. See db/migrations/041-dev-runs.sql for the full rationale.
-- ============================================================================
CREATE TABLE dev_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_name          TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  thread_id         UUID,
  issue_key         TEXT NOT NULL,
  analysis_trace_id TEXT,
  spec_path         TEXT,
  e2e_spec_path     TEXT,
  workplan_path     TEXT,
  status            TEXT NOT NULL DEFAULT 'analyzing',
  research_stage    TEXT,
  -- Phase 6b: count of autonomous re-engage-on-red attempts; capped by
  -- claimForReengage so a red → re-engage → red cycle terminates (see
  -- db/migrations/042-dev-run-reengage-count.sql).
  reengage_count    INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dev_runs_identity_idx ON dev_runs (bot_name, user_id, issue_key);
CREATE INDEX dev_runs_thread_idx ON dev_runs (thread_id);

CREATE TABLE dev_run_handoffs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID NOT NULL REFERENCES dev_runs(id) ON DELETE CASCADE,
  peer_name         TEXT NOT NULL,
  peer_id           TEXT,
  role              TEXT NOT NULL,
  correlation_token TEXT,
  status            TEXT NOT NULL DEFAULT 'sent',
  last_message      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dev_run_handoffs_lookup_idx ON dev_run_handoffs (run_id, peer_name);

-- Phase A (progress tracking): append-only timeline of NON-TERMINAL progress
-- notes a peer emits while it works (discovery|decision|blocker|milestone). A
-- note never recomputes status / touches the green gate / reopens a terminal run
-- — its only handoff side-effect is a guarded sent → working bump. See
-- db/migrations/043-dev-run-events.sql for the full rationale.
CREATE TABLE dev_run_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES dev_runs(id) ON DELETE CASCADE,
  peer_name   TEXT NOT NULL,
  role        TEXT,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dev_run_events_run ON dev_run_events (run_id, created_at);

-- ============================================================================
-- Schema migrations: tracks which migrations have been applied
-- ============================================================================
CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
