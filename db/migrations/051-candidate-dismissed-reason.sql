-- Why a candidate was dismissed (gate-outcome calibration).
--
-- `dismissed_reason` distinguishes the two very different ways a row reaches
-- `status = 'dismissed'`:
--   'manual'  — a human clicked Dismiss in the inbox (a real "not worth a summary"
--               judgement — the negative label the acceptance-rate metric needs).
--   'expired' — expireStaleCandidates() auto-dismissed an untouched non-terminal row
--               after 14 days (NOT a quality judgement — the user never looked).
-- Auto-expired rows would otherwise pollute per-kind acceptance rates, so the
-- calibration aggregation excludes them from the denominator.
--
-- Nullable, NO backfill: rows dismissed before this migration keep dismissed_reason
-- NULL = "unknown", counted separately from both 'manual' and 'expired' (they predate
-- the distinction, so we can't honestly label them either way).
--
-- ⚠️ Mirror of db/init.sql: the column must exist on BOTH sides or schema-drift.test.ts
-- reds. Plain nullable TEXT (no CHECK), so only presence + type must match.
ALTER TABLE summary_candidates
  ADD COLUMN dismissed_reason TEXT;
