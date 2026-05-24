-- Spec-driven dev loop, Phase 6b — auto re-engage on a red e2e.
--
-- reengage_count is the termination guard for the autonomous re-engage loop: a
-- red run is re-opened (status red → building) and the build agent is re-engaged
-- from code, capped at MAX_REENGAGE_ATTEMPTS (src/db/dev-runs.ts). The atomic
-- claim (claimForReengage) increments this only while the run is `red` and below
-- the cap, so a red → re-engage → red cycle stops after N attempts and the run
-- parks at `red` with an "exhausted — needs you" affordance. Existing rows
-- default to 0 (never auto-re-engaged), so no data backfill is needed.
ALTER TABLE dev_runs ADD COLUMN reengage_count INTEGER NOT NULL DEFAULT 0;
