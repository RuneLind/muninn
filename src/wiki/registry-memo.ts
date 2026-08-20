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
import { getLog } from "../logging.ts";
import { buildWikiRegistry, type WikiRegistryEntry } from "./registry.ts";
import { isReadonlyWikiRoot, readonlyWikiRoots, sameWikiRoot } from "./readonly.ts";

const log = getLog("wiki", "registry");

let cachedRegistry: WikiRegistryEntry[] | null = null;

/** The full wiki registry (bot wikis + `WIKI_EXTRA` standalone wikis), memoized.
 *  The `WIKI_READONLY_ROOTS` predicate is threaded in for the presentational
 *  `readonly` flag ONLY — every enforcement point calls `isReadonlyWikiRoot` on
 *  the root it already holds, so this memo is never the guard. */
export function getWikiRegistry(): WikiRegistryEntry[] {
  if (cachedRegistry) return cachedRegistry;
  cachedRegistry = buildWikiRegistry({
    bots: discoverAllBots(),
    extra: process.env.WIKI_EXTRA,
    isReadonlyRoot: isReadonlyWikiRoot,
  });
  // A `WIKI_READONLY_ROOTS` entry matching no registered wiki means someone
  // edited one var and not the other. It fails CLOSED for that entry (it names a
  // root nothing writes) and leaves every matching entry enforced, so this is a
  // diagnostic — but a LOUD one, because the silent reading is "the guard is on"
  // when nothing is guarded.
  //
  // It lives HERE, not in the pure builder, because the comparison has to be the
  // realpath-aware one. The builder's own normalize-only `sameRoot` warned for
  // every symlinked root — on macOS `/tmp` is a symlink to `/private/tmp`, so a
  // wiki registered at `/tmp/w` was flagged "matches no registered wiki root"
  // while its entry carried `readonly: true`: the diagnostic contradicting the
  // guard it exists to describe.
  for (const root of unmatchedReadonlyWikiRoots(cachedRegistry, readonlyWikiRoots())) {
    log.warn(
      "WIKI_READONLY_ROOTS: {root} matches no registered wiki root — nothing is guarded by that entry (check WIKI_EXTRA / a bot's wikiDir)",
      { root },
    );
  }
  return cachedRegistry;
}

/** The configured read-only roots that match NO entry in this registry — the
 *  drift between `WIKI_READONLY_ROOTS` and `WIKI_EXTRA`/`wikiDir`. Drives the
 *  warn above and the `/models` Machine card's matched-vs-unmatched split, so
 *  the log line and the card can never disagree about which entry is inert. */
export function unmatchedReadonlyWikiRoots(
  entries: WikiRegistryEntry[],
  roots: string[],
): string[] {
  return roots.filter((root) => !entries.some((e) => sameWikiRoot(e.root, root)));
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
