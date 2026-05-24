-- Spec-driven dev loop: control/state plane for the closed ATDD loop.
--
-- dev_runs is the run aggregate, born at research-thread creation and spanning
-- the whole arc (analysis → spec → build+test → verify). One row per
-- (bot_name, user_id, issue_key); re-running a research overwrites it like the
-- report file does. issue_key is a Jira key OR the synthetic research-<8hex> id
-- the report/spec paths use — never NULL. delegate_task (later phase) resolves
-- the OPEN run by thread_id (peekActiveTurn), not issue_key, because
-- chat-started research has a synthetic key the model can't reproduce; the
-- identity index is a dup-guard, dev_runs_thread_idx is the operative lookup.
--
-- dev_runs.status is a DERIVED rollup (computeRunStatus) of the per-handoff
-- rows — building/testing are concurrent so a single enum can't hold both.
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
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dev_runs_identity_idx ON dev_runs (bot_name, user_id, issue_key);
CREATE INDEX dev_runs_thread_idx ON dev_runs (thread_id);

-- One row per outbound handoff (build | test | orchestrate; review folded into
-- build). A reply's in-marker run:<id> resolves run_id exactly; peer_name then
-- picks the role's handoff within that run. correlation_token is an optional
-- broker disambiguator — raw peers usually don't echo it, so it isn't relied on.
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
