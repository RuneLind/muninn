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

/** `MUNINN_WIKI_READONLY` / `WIKI_READONLY_ROOTS` — the two write-permission
 *  flags. The first is the INSTANCE switch (the mini is the non-write-owner and
 *  carries it), the second the per-wiki sibling. Both are read through the wiki
 *  seams' defaults, so an ambient value flips `written` to `forbidden` under a
 *  test that never mentioned either. */
const WIKI_WRITE_FLAGS = ["MUNINN_WIKI_READONLY", "WIKI_READONLY_ROOTS"];

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
  "MUNINN_ADMIN_IDENTS",
  "MUNINN_ALLOWED_ORIGINS",
  "NAIS_CLUSTER_NAME",
];

/** Every name above, in one array. */
export const AMBIENT_INSTANCE_ENV: readonly string[] = [
  ...WIKI_WRITE_FLAGS,
  ...SYNC_FLAGS,
  ...AUTH_FLAGS,
];
