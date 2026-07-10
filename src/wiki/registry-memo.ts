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

let cachedRegistry: WikiRegistryEntry[] | null = null;

/** The full wiki registry (bot wikis + `WIKI_EXTRA` standalone wikis), memoized. */
export function getWikiRegistry(): WikiRegistryEntry[] {
  return (cachedRegistry ??= buildWikiRegistry(discoverAllBots(), process.env.WIKI_EXTRA));
}

/** Test-only: drop the memoized registry so a test can re-derive it from a
 *  freshly-set `WIKI_EXTRA` (mirrors `__resetWikiCacheForTest` in the store). */
export function __resetWikiRegistryForTest(): void {
  cachedRegistry = null;
}
