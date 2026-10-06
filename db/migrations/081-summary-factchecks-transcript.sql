-- The transcript check's result on the same `summary_factchecks` row as the web
-- check it reads (the `/summaries` doc panel's "Check transcript").
--
--   transcript_claims  {claims: [{index, verdict, note}], cut: {truncated,
--                      keptChars, totalChars}, model, botName, checkedAt}
--   transcript_sha256  sha256 of the `## Transcript` appendix it was checked
--                      against, so `/result` can say the transcript changed.
--
-- The check's input is the row's own saved web claims, and its verdicts join
-- them by `index`. A web re-check upsert sets BOTH columns back to NULL, so a
-- transcript verdict never pairs with a claim set it was not given.
--
-- NULLable, NULL on every existing row: no transcript check has run there.
-- Independent of migration 080 (`applied_at`): neither reads the other.
--
-- ⚠️ Mirrored in db/init.sql, or schema-drift.test.ts reds.
ALTER TABLE summary_factchecks ADD COLUMN IF NOT EXISTS transcript_claims JSONB;
ALTER TABLE summary_factchecks ADD COLUMN IF NOT EXISTS transcript_sha256 TEXT;
