-- Prompt snapshots: one row per PASS, and a kind that says how long it is kept.
--
-- The table was unique on trace_id, written once per chat turn. A capture now
-- writes here too, and a YouTube dense-scan capture makes TWO model calls under
-- ONE trace root (the `claude:select` selection pass over the contact sheets,
-- then the `claude` summary pass) — so `ON CONFLICT (trace_id) DO NOTHING` let
-- whichever pass ran first win the trace and threw the other away. The key is
-- (trace_id, pass).
--
-- `kind` splits retention: a chat prompt is swept after 3 days, a capture's is
-- kept for 90 (PROMPT_SNAPSHOTS_CAPTURE_RETENTION_DAYS) so a summary read months
-- later can still show the prompt that produced it — well past the 7-day trace
-- sweep, which is why the by-url lookup below exists at all rather than going
-- through the trace.
--
-- Existing rows are chat prompts written by src/core/prompt-assembly.ts: the
-- defaults ('' and 'chat') describe them exactly, so no backfill is needed.
ALTER TABLE prompt_snapshots
  ADD COLUMN pass TEXT NOT NULL DEFAULT '',
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat',
  ADD COLUMN source_url TEXT;

DROP INDEX idx_prompt_snapshots_trace;
CREATE UNIQUE INDEX idx_prompt_snapshots_trace_pass ON prompt_snapshots (trace_id, pass);

-- The by-url lookup behind GET /api/summaries/prompt: newest capture snapshot
-- for a source url. (The /summaries doc-panel control that will call it is a
-- later PR; the index serves the route.)
-- PARTIAL, on the kind it serves — chat rows carry no source_url and would be
-- dead weight in it.
CREATE INDEX idx_prompt_snapshots_capture_url
  ON prompt_snapshots (source_url, created_at DESC)
  WHERE kind = 'capture';
