-- Tier-2 snapshot state for the anthropic watcher (Phase 3).
--
-- Stores the large baseline SETs that the Tier-2 diff compares against each run:
-- the ~1753-URL llms.txt doc set + the per-section anthropic.com blog slug sets.
-- These cannot live in watchers.last_notified_ids (hard-capped at 400 and shared
-- with Tier-1 per-candidate dedup — the 1753-URL set would be truncated every run
-- and thrash Tier-1) nor in watchers.config (the dashboard's updateWatcher
-- overwrites the whole config blob, src/db/watchers.ts). One row per (watcher,key).
--
-- ⚠️ Mirror of db/init.sql: identical column order + PK + FK so
-- schema-drift.test.ts (which diffs the live schema against init.sql) stays green.
CREATE TABLE watcher_snapshots (
  watcher_id UUID NOT NULL REFERENCES watchers(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (watcher_id, key)
);
