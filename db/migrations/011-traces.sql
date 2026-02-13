-- Observability: request tracing and span data
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
