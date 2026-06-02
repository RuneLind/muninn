-- 044: Add messages.source column to the migration history.
--
-- This column has existed in db/init.sql since commit 07987d3 ("Add news
-- watcher…") and is written/read by src/db/messages.ts, but it was never
-- captured by a migration. Fresh DBs get it from init.sql; any DB built purely
-- by replaying migrations (or an old DB that predates the init.sql change) was
-- missing it. The init.sql drift guard (src/db/schema-drift.test.ts) surfaced
-- this gap. IF NOT EXISTS makes it a no-op on every DB that already has it.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source TEXT DEFAULT NULL;
