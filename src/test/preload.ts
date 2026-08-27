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
 * WHICH names, and why each one, lives in `ambient-env.ts` — the same list the
 * Playwright harness applies to every muninn it spawns (`e2e/e2e-env.ts`). The
 * two differ only in HOW they apply it: a delete is right here, because this
 * process has already loaded `.env` and nothing re-reads it; a spawned child
 * re-reads it itself, so there the blank has to be an explicit assignment.
 *
 * Wired via `[test] preload` in `bunfig.toml` (test-scoped: `bun run start` and
 * the dev server still see the real flags).
 */

import { AMBIENT_INSTANCE_ENV, AMBIENT_INSTANCE_ENV_PREFIXES } from "./ambient-env.ts";

for (const name of AMBIENT_INSTANCE_ENV) {
  delete process.env[name];
}
// And the open-ended families. `process.env` here has already absorbed `.env`,
// so enumerating it is the whole scan — unlike the e2e side, where a spawned
// child re-reads the files itself.
for (const name of Object.keys(process.env)) {
  if (AMBIENT_INSTANCE_ENV_PREFIXES.some((p) => name.toUpperCase().startsWith(p))) {
    delete process.env[name];
  }
}
