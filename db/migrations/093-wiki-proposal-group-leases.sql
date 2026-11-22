-- Gardener group verbs (F35, arch review 2026-11-16): which Accept or Dismiss
-- of a group holds it, across processes. `bun run dev:chat` runs the same
-- routes on the same DB and wikis, so a per-process set let a Dismiss there
-- reject rows an Accept here was writing. A verb claims the row (insert, or take
-- one whose lease expired), renews it while it runs and deletes it by token when
-- done; an `approved` row with no live lease is stranded.
CREATE TABLE IF NOT EXISTS wiki_proposal_group_leases (
  scope       TEXT NOT NULL,           -- COALESCE(wiki_name, bot_name) of the group's rows
  group_key   TEXT NOT NULL,
  token       UUID NOT NULL,
  verb        TEXT NOT NULL,           -- accept | dismiss | self-heal
  expires_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope, group_key)
);
