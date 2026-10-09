-- The retention cleanup deletes traces in batches, oldest first, by `created_at`
-- (src/db/traces.ts `cleanupOldTraces`). Without this index every batch is a
-- sequential scan from the start of the heap. A plain build on purpose: it runs
-- in the migration's transaction and rolls back whole, while a failed concurrent
-- build leaves an INVALID index that `IF NOT EXISTS` would skip on the re-run.
-- It holds a SHARE lock on `traces` (span inserts wait) for the one build.
-- db/migrate.ts picks the non-transactional path by a word match on this file's
-- text, so that word must not appear here.
CREATE INDEX IF NOT EXISTS idx_traces_created ON traces (created_at);
