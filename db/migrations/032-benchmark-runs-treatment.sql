-- Phase 1: extend benchmark_runs to record the treatment that produced
-- a candidate analysis (vs. just judging a historical report).
--
-- Phase 0's runs were judging existing markdown reports — so the only
-- thing the row needed was (issue, candidate_path, judge result). Phase 1's
-- runner produces candidates itself, so each row needs to capture *what
-- configuration was used* to produce the candidate, with enough detail
-- that two rows can be A/B compared and the winner re-run for verification.
--
-- All columns are nullable because Phase 0 rows pre-date this migration
-- and have nothing to backfill.

ALTER TABLE benchmark_runs
  -- The treatment that produced the candidate. JSONB so we can grow the
  -- shape without further migrations as new dimensions get added.
  -- Current shape: { connector, model, mcpStack, promptId }
  ADD COLUMN treatment           JSONB,

  -- Identifier of the analysis prompt variant (e.g. "default",
  -- "cross-issue-hint-v1"). Pulled out of treatment.promptId so it can
  -- be indexed and grouped by directly.
  ADD COLUMN prompt_id           TEXT,

  -- The full prompt text passed to the analysis call. Includes the bot
  -- persona, jiraAnalysis template, the Jira issue, and any tool-stack
  -- preamble. Stored for reproducibility — we want to be able to re-run
  -- exactly this prompt in the future.
  ADD COLUMN full_prompt         TEXT,
  ADD COLUMN full_prompt_hash    TEXT,

  -- The actual report markdown the analysis call produced. Also stored
  -- on disk under benchmarks/runs/, but having it in the DB makes the
  -- dashboard self-contained (no filesystem reads from the web layer).
  ADD COLUMN report_md           TEXT,

  -- Tool calls extracted from the analysis trace. JSONB array of
  -- { name, displayName, durationMs } — same shape that
  -- ProcessMessageResult.toolCalls returns.
  ADD COLUMN tool_calls          JSONB,

  -- Token usage from the analysis call (separate from the judge call's
  -- input_tokens/output_tokens which already exist on this row).
  -- Shape: { inputTokens, outputTokens, contextTokens, costUsd, model, durationMs }
  ADD COLUMN tokens              JSONB,

  -- Resolved model snapshot ID for the analysis call. Same caveat as
  -- judge_model: for the 4.6 generation this is just the alias because
  -- the CLI doesn't expose snapshot IDs (see known-bugs.md Bug 2).
  ADD COLUMN model_snapshot_id   TEXT,

  -- The MCP stack configuration the analysis call used.
  -- Shape: { stack: "knowledge-only" | "knowledge+serena" | ..., serenaInstances: [...], ... }
  ADD COLUMN stack_config        JSONB;

CREATE INDEX idx_benchmark_runs_prompt   ON benchmark_runs (prompt_id);
CREATE INDEX idx_benchmark_runs_hit_rate ON benchmark_runs (hit_rate DESC);
