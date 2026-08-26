-- The Entra → users.id linking table (MUNINN_AUTH=entra).
--
-- An `entra` session arrives as CLAIMS, not as a muninn user id. This table is
-- what decides which `users` row a NAV colleague acts as, and what makes that
-- answer stable across restarts, renames and machines.
--
--  * The key is (provider, tenant, oid). `oid` is the only claim immutable for a
--    person within a tenant — a NAVident is RE-ISSUED when someone leaves, so
--    keying on it would eventually resolve two humans to one account.
--  * `tenant` is provenance bookkeeping written from MUNINN_TENANT, never
--    compared against the token's own `tid`: Texas is the authority on which
--    directory it introspected, and a config value overruling it would be a
--    second, weaker check in front of the real one. It is in the key because an
--    `oid` is unique per tenant, not globally.
--  * `nav_ident` / `display_name` are MUTABLE and refreshed on every login, so
--    an operator reading the database can tell whose `nav-…` id a row is.
--  * `provider` is stored rather than implied so a second IdP can coexist
--    without a migration.
--
-- ON DELETE CASCADE: deleting a `users` row must not leave a link pointing at
-- nothing, which would resolve the next login to a missing account.
--
-- Rationale in full: src/db/user-identities.ts + src/auth/CLAUDE.md.
-- ⚠️ Mirrored in db/init.sql — identical columns, indexes and constraints, or
-- src/db/schema-drift.test.ts reds.

CREATE TABLE IF NOT EXISTS user_identities (
  provider      TEXT NOT NULL,
  tenant        TEXT NOT NULL,
  oid           TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nav_ident     TEXT,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, tenant, oid)
);

-- The reverse lookup: "which identities point at this account?" — used when a
-- collision has to be untangled by hand, and by the FK's own cascade.
CREATE INDEX IF NOT EXISTS idx_user_identities_user_id
  ON user_identities (user_id);
