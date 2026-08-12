/**
 * `MUNINN_WIKI_READONLY` — the wiki write-owner switch.
 *
 * A second muninn instance (the Mac mini) runs with no bot tokens and
 * `SCHEDULER_ENABLED=false`. That closes the SCHEDULER only: every dashboard
 * route is registered unconditionally in `createDashboardRoutes`, so the whole
 * HTTP write surface stays live and two instances would write the same wiki
 * working tree. `MUNINN_WIKI_READONLY=1` closes that surface instead.
 *
 * **Precise semantics: it forbids programmatic page CONTENT writes, not git.**
 * `commitWikiChange` is deliberately NOT guarded — the repo-sync loop on the
 * readonly instance commits and pushes through it, and the two content seams
 * below plus the route guards already cover every content-write funnel:
 *
 *   - `writeWikiPage` (fact-check append + integrate/apply)
 *   - `applyWikiProposal` (gardener approve)
 *
 * The `wiki-committer` watcher also calls `commitWikiChange` (it commits stray
 * dirty files and writes no page content) and stays unguarded too.
 *
 * Offline scripts that write with a bare `Bun.write` are out of scope — this
 * guards the HTTP surface, and the readonly instance runs no such scripts.
 */

import { wikiReadonlyFromEnv } from "../config.ts";

/** The env var name, so error copy and the `/models` machine card agree. */
export const WIKI_READONLY_ENV = "MUNINN_WIKI_READONLY";

/** The one refusal sentence — reported as the seam outcome's `reason` and as
 *  the 403 body's `error` on every guarded route. */
export const WIKI_READONLY_REASON =
  `this muninn instance is wiki-readonly (${WIKI_READONLY_ENV}=1) — programmatic wiki page writes are disabled here`;

/** Test override. `undefined` ⇒ read the env (production behaviour). */
let testOverride: boolean | undefined;

/**
 * Is this instance forbidden from writing wiki page content? Read at CALL time,
 * never cached, so a test (or a future hot toggle) flipping the flag takes
 * effect immediately. Every seam takes it as an injectable `isReadonly` option
 * defaulting to this, so a test can drive one seam without touching the process.
 */
export function isWikiReadonly(): boolean {
  return testOverride ?? wikiReadonlyFromEnv();
}

/** Force the flag for a test; call with no argument to restore env resolution. */
export function __setWikiReadonlyForTest(value?: boolean): void {
  testOverride = value;
}
