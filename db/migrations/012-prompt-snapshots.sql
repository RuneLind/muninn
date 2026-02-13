-- Prompt snapshots: store full system + user prompts per trace for inspection
-- No FK on trace_id — snapshots have shorter retention (3d) than traces (7d)
CREATE TABLE prompt_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id UUID NOT NULL,
  system_prompt TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_prompt_snapshots_trace ON prompt_snapshots (trace_id);
CREATE INDEX idx_prompt_snapshots_created ON prompt_snapshots (created_at DESC);
