/**
 * Process-wide memoized wiki registry. The pure builder lives in `registry.ts`
 * (no bot discovery, no env parsing at import) so route logic stays unit-testable;
 * this thin wrapper is the ONE place that runs `discoverAllBots()` + parses
 * `WIKI_EXTRA` and caches the result. The registry is static until restart, so
 * building it once avoids re-running discovery + re-logging config/env-validation
 * warnings on every /api/wiki request. Shared by the wiki reader routes, the
 * gardener routes (filtering to `source === "bot"`), citation enrichment, and the
 * /models overview — one memo, not four.
 */

import { discoverAllBots } from "../bots/config.ts";
import { buildWikiRegistry, type WikiRegistryEntry } from "./registry.ts";
import { isReadonlyWikiRoot, readonlyWikiRoots } from "./readonly.ts";

let cachedRegistry: WikiRegistryEntry[] | null = null;

/** The full wiki registry (bot wikis + `WIKI_EXTRA` standalone wikis), memoized.
 *  The `WIKI_READONLY_ROOTS` inputs are threaded in for the presentational
 *  `readonly` flag + the no-match warn ONLY — every enforcement point calls
 *  `isReadonlyWikiRoot` on the root it already holds, so this memo is never the
 *  guard. */
export function getWikiRegistry(): WikiRegistryEntry[] {
  return (cachedRegistry ??= buildWikiRegistry({
    bots: discoverAllBots(),
    extra: process.env.WIKI_EXTRA,
    isReadonlyRoot: isReadonlyWikiRoot,
    readonlyRoots: readonlyWikiRoots(),
  }));
}

/** Test-only: drop the memoized registry so a test can re-derive it from a
 *  freshly-set `WIKI_EXTRA` (mirrors `__resetWikiCacheForTest` in the store). */
export function __resetWikiRegistryForTest(): void {
  cachedRegistry = null;
}

/** Test-only: pin a fabricated registry so a route test can exercise a BOT wiki
 *  without real bot discovery (`WIKI_EXTRA` can only register standalone wikis).
 *  Cleared by {@link __resetWikiRegistryForTest}. */
export function __setWikiRegistryForTest(entries: WikiRegistryEntry[]): void {
  cachedRegistry = entries;
}
