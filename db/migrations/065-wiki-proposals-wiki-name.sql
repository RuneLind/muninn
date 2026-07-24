-- Wiki-keyed proposals for the consolidation gardener.
--
-- The consolidation gardener turns semantic clusters of a wiki's OWN pages into
-- reviewable `synthesis` proposals for STANDALONE (bot-less) wikis like mimir
-- (registered via WIKI_EXTRA). Those rows still carry a truthful `bot_name` (the
-- synthesis bot that drafts them, e.g. jarvis), but they belong to the WIKI, not
-- the bot — so a new nullable `wiki_name` column keys them to the wiki. Legacy
-- bot-keyed rows leave `wiki_name` NULL and behave byte-identically.
--
-- The dedup partial unique index moves from (bot_name, topic_key) to
-- (COALESCE(wiki_name, bot_name), topic_key): when wiki_name IS NULL the COALESCE
-- collapses to bot_name, so legacy semantics are preserved exactly; a wiki-keyed
-- row dedups against its wiki instead of the shared synthesis bot.
--
-- `kind` is a plain TEXT column (no CHECK constraint — the TS `WikiProposalKind`
-- union is the real gate), so `synthesis` needs no DDL change here.
--
-- ⚠️ Mirror of db/init.sql: keep the column + the index swap in both, or
-- schema-drift.test.ts (which diffs the live schema against init.sql) fails.

ALTER TABLE wiki_proposals ADD COLUMN wiki_name TEXT;

DROP INDEX IF EXISTS wiki_proposals_bot_name_topic_key_idx;

CREATE UNIQUE INDEX wiki_proposals_wiki_topic_live_idx
  ON wiki_proposals (COALESCE(wiki_name, bot_name), topic_key)
  WHERE status IN ('draft', 'approved');
