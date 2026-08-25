/**
 * `bun test` preload — makes the suite HERMETIC w.r.t. the instance-profile env
 * flags that a developer's `.env` may legitimately carry.
 *
 * Bun auto-loads `.env` for every `bun` invocation, `bun test` included. The Mac
 * mini's `.env` carries `MUNINN_WIKI_READONLY=1` (it is the non-write-owner
 * instance), and that flag is read through the seams' default `isWikiReadonly()`
 * — so every pre-existing wiki/gardener write test that expects `written` got
 * `forbidden` there: 45 failures on a tree that is green on the laptop.
 *
 * The flag's own tests never rely on the env (they drive
 * `__setWikiReadonlyForTest`, deliberately, so a crashing test can't leave the
 * whole suite readonly), so clearing it here costs no coverage. A test that
 * really wants to observe env resolution sets the variable itself and restores
 * it — this only removes the ambient value.
 *
 * Wired via `[test] preload` in `bunfig.toml` (test-scoped: `bun run start` and
 * the dev server still see the real flag).
 */

delete process.env.MUNINN_WIKI_READONLY;

/**
 * `SYNC_REPOS` is the same class of ambient flag, and it reaches further: it
 * makes the `wiki-committer` sweeper STAND DOWN for any repo it covers
 * (`syncCoversToplevel`), so a developer with the real mimir/huginn-jarvis
 * entries in `.env` would see the sweeper's tests exercise the subsumption
 * branch instead of the branch they assert. The sync tests build their own
 * repos and set the variable explicitly.
 */
delete process.env.SYNC_REPOS;

/**
 * The `MUNINN_AUTH` family is the same class again, and it is the one a
 * developer's `.env` is MOST likely to carry once local mode is turned on: the
 * mini publishes `127.0.0.1:3010` to a tailnet and is exactly the instance that
 * wants it. `resolveAuthConfig()` reads `process.env` by default, so an ambient
 * `MUNINN_AUTH=local` would silently change what a bare call resolves to — the
 * "green on the laptop, red on the mini" shape this file exists to prevent.
 *
 * The auth tests pass explicit env records rather than mutating `process.env`
 * (`resolveAuthConfig(env)`), so clearing these costs no coverage.
 */
for (const name of [
  "MUNINN_AUTH",
  "MUNINN_LOCAL_TOKEN",
  "MUNINN_LOCAL_USER",
  "MUNINN_LOCAL_NAME",
  "MUNINN_ADMIN_IDENTS",
  "MUNINN_ALLOWED_ORIGINS",
  // Not ours, but it is what turns refusal (1) on, and a developer running
  // against a nais-shaped env would otherwise fail every bare-config test.
  "NAIS_CLUSTER_NAME",
]) {
  delete process.env[name];
}
