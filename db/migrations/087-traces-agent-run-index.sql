-- `/agents` Recently finished reads the spans `finishAgentRunTrace` stamped
-- (src/db/agent-activity.ts `getRecentAgentRuns`). Without this index that read
-- detoasts the attributes of every span in its window: measured 2.7 ms over 1,043
-- rows, on a poll, against 0.56 ms for the query beside it. Stamped spans are a small
-- share of the table, so the partial index stays small.
-- A plain build for the reasons in 083, and the same SHARE lock for the one build.
CREATE INDEX IF NOT EXISTS idx_traces_agent_run ON traces (started_at DESC) WHERE attributes ? 'agentKind';
