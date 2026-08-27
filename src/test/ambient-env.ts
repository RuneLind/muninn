/**
 * The instance-profile env names a TEST must never inherit from the developer's
 * `.env` — the single list behind both hermetic harnesses.
 *
 * Bun auto-loads `.env` for every `bun` invocation. That is correct for
 * `bun run start`, and wrong for anything that asserts behaviour: these flags
 * describe WHICH INSTANCE this is, so a suite that inherits them is green on the
 * machine it was written on and red on the other one. It has now bitten twice —
 * `MUNINN_WIKI_READONLY=1` on the Mac mini turned 45 `bun test` cases red (the
 * reason `preload.ts` exists), and the same flag reaching a Playwright-spawned
 * muninn turned the e2e suite red there while the laptop stayed green.
 *
 * TWO consumers, two application modes, ONE list:
 *   - `src/test/preload.ts` DELETES them from this process (`bun test`);
 *   - `e2e/e2e-env.ts` assigns them `""` in the env of every muninn Playwright
 *     spawns. A delete does NOT work there: the child re-reads `.env` itself, so
 *     the absence of a name is exactly what makes Bun fall back to the dotenv
 *     line. Only an explicit empty-string assignment beats it (the same rule
 *     `blank-bot-tokens.ts` documents for platform tokens).
 *
 * Adding a flag here costs no coverage as long as the tests that DO exercise it
 * set it themselves — which is the existing convention: the wiki-readonly tests
 * drive `__setWikiReadonlyForTest`, the auth tests pass an explicit env record to
 * `resolveAuthConfig(env)`, and the sync tests build their own repos and set
 * `SYNC_REPOS` per case.
 */

/** `MUNINN_WIKI_READONLY` — the INSTANCE write switch (the mini is the
 *  non-write-owner and carries it). It is read through the wiki seams' default
 *  `isWikiReadonly()`, so an ambient value flips `written` to `forbidden` under a
 *  test that never mentioned it: 45 red cases on the mini, 23 e2e specs later.
 *
 *  ⚠️ Its per-wiki sibling `WIKI_READONLY_ROOTS` is deliberately NOT here, and
 *  must not be added. It is not an instance-profile flag — it is a per-root
 *  PERMISSION GUARD, and the thing it guards (`WIKI_EXTRA`) is not blanked
 *  either. Blanking only the guard leaves the wiki REGISTERED with its
 *  protection removed: this laptop registers `memory=~/.claude/projects` — Claude
 *  Code's own auto-memory, loaded into every session's context — and root
 *  `CLAUDE.md` states the rule outright, that "registration alone makes it
 *  writable and model-reachable over HTTP". Measured on a booted server: with the
 *  root blanked, `/wiki?wiki=memory` renders `__WIKI_READONLY_WIKI__ = false`,
 *  the three content seams stop refusing and the `?wiki=`-steerable egress routes
 *  stop 403-ing before their model call. Nothing needs it blank: every failure
 *  this file exists for was `MUNINN_WIKI_READONLY`. */
const WIKI_WRITE_FLAGS = ["MUNINN_WIKI_READONLY"];

/** `SYNC_REPOS` reaches further than it looks: it stands the daily
 *  `wiki-committer` sweeper DOWN for any repo it covers (`syncCoversToplevel`),
 *  so a developer carrying the real mimir/huginn-jarvis entries sees the
 *  sweeper's tests exercise the subsumption branch instead of the one they
 *  assert. `e2e/plans-write.spec.ts` had already hand-blanked this at one spawn
 *  site — that one-off is what this list generalises. */
const SYNC_FLAGS = ["SYNC_REPOS"];

/** The `MUNINN_AUTH` family is the flag a developer's `.env` is MOST likely to
 *  carry once local mode is on: the mini publishes `127.0.0.1:3010` to a tailnet
 *  and is exactly the instance that wants it. `resolveAuthConfig()` reads
 *  `process.env` by default, and in e2e it is worse than a changed resolution —
 *  an ambient `MUNINN_AUTH=local` puts the whole spawned dashboard behind a
 *  token every spec would then 401 against. `NAIS_CLUSTER_NAME` is not ours, but
 *  it is what turns the unauthenticated-boot REFUSAL on, so a nais-shaped env
 *  fails every bare-config test and stops a spawned e2e server from booting at
 *  all. */
const AUTH_FLAGS = [
  "MUNINN_AUTH",
  "MUNINN_LOCAL_TOKEN",
  "MUNINN_LOCAL_USER",
  "MUNINN_LOCAL_NAME",
  // `MUNINN_LOCAL_ROLE` decides whether the pinned identity is admin, i.e. what
  // the zone model lets it call. A machine whose `.env` sets it would spawn e2e
  // muninns at role `admin` while the other machine spawns `user`, and the
  // acceptance rows would flip by HOST — the same failure shape as
  // `MUNINN_WIKI_READONLY`, on a flag whose direction is "grants more".
  "MUNINN_LOCAL_ROLE",
  "MUNINN_ADMIN_IDENTS",
  "MUNINN_ALLOWED_ORIGINS",
  "NAIS_CLUSTER_NAME",
  // The `entra` half. Inert on their own — nothing reads either unless
  // `MUNINN_AUTH=entra`, which is blanked above — but they are the same class
  // of value (this instance's deployment identity), and leaving them ambient
  // would mean an entra-shaped `.env` decides which tenant a spawned server
  // stamps onto provisioned rows. The specs that DO exercise entra set both
  // themselves, per this file's convention.
  "MUNINN_TENANT",
  "NAIS_TOKEN_INTROSPECTION_ENDPOINT",
];

/** Every name above, in one array. */
export const AMBIENT_INSTANCE_ENV: readonly string[] = [
  ...WIKI_WRITE_FLAGS,
  ...SYNC_FLAGS,
  ...AUTH_FLAGS,
  // `MUNINN_PROFILE` — the instance-profile flag by definition: its whole job
  // is to say WHICH DEPLOYMENT this process is. An ambient `nais` drops
  // thirteen route groups and turns every Claude-CLI spawn into a throw, so the
  // wiki/gardener/plans/sync/capture tests would 404 on the machine carrying it
  // and pass on the other. The tests that DO exercise it pass an explicit
  // profile or set the variable themselves. (Spelled here rather than imported
  // from `src/config.ts`: this file is a test PRELOAD, and pulling the config
  // layer into it would evaluate the logging stack before any suite runs.)
  "MUNINN_PROFILE",
];
