import type { WatcherType } from "../types.ts";

/**
 * Watcher types whose run DRAFTS into a wiki — refused on a readonly instance
 * (`MUNINN_WIKI_READONLY`, see `src/wiki/readonly.ts`).
 *
 * Deliberately not "every wiki-ish type": `wiki-linter` is report-only and
 * `wiki-committer` only commits (git is exactly what `MUNINN_WIKI_READONLY`
 * leaves open, since the readonly instance's repo-sync loop needs it).
 *
 * Lives here rather than in the dashboard because BOTH entry points into these
 * checkers must agree: the manual `POST /api/watchers/:id/trigger` route
 * (`data-routes.ts`) and the SCHEDULED run (`runChecker` in `./runner.ts`).
 * Guarding only the route left the weekly runs minting proposals a readonly
 * instance can never apply, on a box where `SCHEDULER_ENABLED=true`.
 */
export const WIKI_DRAFTING_WATCHER_TYPES: ReadonlySet<WatcherType> = new Set<WatcherType>([
  "wiki-gardener",
  "consolidation-gardener",
]);

/** Should this watcher type's run be skipped on this instance? Pure — the
 *  readonly answer is passed in, so both call sites read it at their own seam. */
export function shouldSkipWikiDraftingRun(type: WatcherType, isReadonly: boolean): boolean {
  return isReadonly && WIKI_DRAFTING_WATCHER_TYPES.has(type);
}
