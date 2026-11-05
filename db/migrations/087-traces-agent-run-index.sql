-- `/agents` Recently finished reads the spans `finishAgentRunTrace` stamped
-- (src/db/agent-activity.ts `getRecentAgentRuns`). Without this index that read
-- filters the whole table on a poll: measured 13-23 ms over the 5,982 rows of a dev
-- database, against about 0.8 ms for the query beside it, and 0.03 ms with the index.
-- Stamped spans are a small share of the table, so the partial index stays small.
-- A plain build for the reasons in 083, and the same SHARE lock for the one build.
CREATE INDEX IF NOT EXISTS idx_traces_agent_run ON traces (started_at DESC) WHERE attributes ? 'agentKind';
