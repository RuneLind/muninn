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
