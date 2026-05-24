-- Spec-driven dev loop, Phase A (progress tracking) — interim "discoveries" feed.
--
-- dev_run_events is an append-only timeline of NON-TERMINAL progress notes a peer
-- emits WHILE it works (discovery | decision | blocker | milestone). It is purely
-- additive on top of the verified terminal/green pipeline: a note NEVER runs
-- computeRunStatus, NEVER touches the green/CI gate, and NEVER reopens a terminal
-- run. The only handoff mutation a note triggers is a guarded sent → working bump
-- (markHandoffWorking) — the loop today goes sent → done/failed with nothing ever
-- setting `working`, leaving agents silent from delegation to terminal marker.
--
-- A note rides in a `<!-- note: <kind> run:<id> -->` marker (parsed terminal-first
-- in handoff-interpreter.ts, so the verified path always wins). peer_name uses the
-- same cwd-basename derivation as dev_run_handoffs; role is best-effort from the
-- matching handoff row (a note with no matching handoff still records the event).
-- text is the reply body minus the marker, capped at 500 chars. Display is capped
-- to the last 100 per run (bounds a chatty peer; the inserts/pushes are the cost).
CREATE TABLE dev_run_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES dev_runs(id) ON DELETE CASCADE,
  peer_name   TEXT NOT NULL,           -- cwd-basename, same derivation as handoffs
  role        TEXT,                    -- build|test|orchestrate|review (best-effort, from the handoff)
  kind        TEXT NOT NULL,           -- discovery|decision|blocker|milestone
  text        TEXT NOT NULL,           -- reply body minus marker, capped
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dev_run_events_run ON dev_run_events (run_id, created_at);
