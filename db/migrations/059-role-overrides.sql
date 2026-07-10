-- Role overrides: DB-backed overrides for the process-wide role assignments that
-- are otherwise env-only (SUMMARIZER_BOT, RESEARCH_BOT, HAIKU_BACKEND). Edited
-- from the /models dashboard page; beat the matching env var at resolution time.
--
-- Unlike per-bot config.json edits (which need a restart), these are HOT: the
-- resolvers (resolveSummarizerBot / resolveResearchBot in src/bots/config.ts,
-- resolveBackendWithReason in src/ai/haiku-direct.ts) read an in-memory snapshot
-- (src/db/role-overrides.ts) that is refreshed on every write, so the next
-- /research ask / summarizer job picks up the change without a restart.
--
-- One row per role. `role` is the env-var name used as the key (e.g.
-- "RESEARCH_BOT"); `value` is the override (a bot name, or a Haiku backend for
-- HAIKU_BACKEND). Absence of a row means "no override — fall back to env/default".
--
-- ⚠️ Mirror of db/init.sql: identical column order + PK so schema-drift.test.ts
-- (which diffs the live schema against init.sql) stays green.
CREATE TABLE role_overrides (
  role       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
