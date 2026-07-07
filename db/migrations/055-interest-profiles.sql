-- Interest profiles: a persistent, periodically-refreshed distillation of what a
-- user cares about following/reading, derived from their active goals + recent
-- memories by a cheap Haiku call (src/profile/generator.ts). Templated into the
-- watcher gate/capture prompts so proactive alerts rank against the user's OWN
-- interests — NOT only the hardcoded baseline prose. One row per (user, bot).
--
-- `profile` is the rendered bullet text injected into prompts; `derived_from`
-- records the input counts (goals, memories) for observability. The refresh is
-- scheduler-driven and gated on a "stale > 7 days" predicate (isProfileStale).
--
-- ⚠️ Mirror of db/init.sql: identical column order + PK so schema-drift.test.ts
-- (which diffs the live schema against init.sql) stays green.
CREATE TABLE interest_profiles (
  user_id      TEXT NOT NULL,
  bot_name     TEXT NOT NULL,
  profile      TEXT NOT NULL,
  derived_from JSONB NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bot_name)
);
