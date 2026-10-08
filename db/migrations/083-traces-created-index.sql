-- The retention cleanup deletes traces in batches, oldest first, by `created_at`
-- (src/db/traces.ts `cleanupOldTraces`). Without this index every batch is a
-- sequential scan from the start of the heap. CONCURRENTLY, so building it on a
-- large table does not block span inserts (db/migrate.ts runs it outside a
-- transaction). Mirrored in db/init.sql without CONCURRENTLY.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_traces_created ON traces (created_at);
