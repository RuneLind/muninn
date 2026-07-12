-- Add trace_id to haiku_usage so a token-tracking row can be tied back to the
-- request trace that produced it. Populated by spawnHaiku when a HaikuTelemetry
-- Tracer is threaded in (the watcher/gardener paths); callers without telemetry
-- write NULL. Backfill not needed — only new rows carry the link.
--
-- ⚠️ Mirror of db/init.sql: keep the column in both, or schema-drift.test.ts
-- (which diffs the live schema against init.sql) fails.
ALTER TABLE haiku_usage ADD COLUMN trace_id UUID;
