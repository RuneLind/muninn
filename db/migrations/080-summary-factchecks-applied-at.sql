-- When a /summaries fact check was last integrated into its document; cleared
-- by a re-check. Mirrored in db/init.sql. Contract: src/summaries/CLAUDE.md.
ALTER TABLE summary_factchecks ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
