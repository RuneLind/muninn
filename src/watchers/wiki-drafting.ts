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

/**
 * What the per-wiki (`WIKI_READONLY_ROOTS`) gate should do with one watcher.
 *
 * `unhandled` is the fail-closed case: the type IS a drafting type, but this
 * resolver does not know which root it drafts into. Returning "allow" there is
 * how a third drafting type would silently gain the right to force-run against
 * a read-only wiki.
 */
export type WikiDraftingTarget =
  | { kind: "allow" }
  | { kind: "readonly-root"; root: string }
  | { kind: "unhandled" };

/**
 * The seams the resolution needs. Injected rather than imported so this stays a
 * leaf module (`../types.ts` only) and the decision is unit-testable without the
 * bot discovery, the wiki registry or the env.
 *
 * `types` exists so the "a drafting type with no resolver" branch is reachable
 * from a test without mutating the exported set.
 */
export interface WikiDraftingTargetDeps {
  /** The wiki a bot owns (`BotConfig.wikiDir`), if any. */
  botWikiDir: (botName: string) => string | undefined;
  /** A registered wiki's root, by registry name. */
  wikiRootByName: (name: string) => string | undefined;
  /** Is this root listed in `WIKI_READONLY_ROOTS`? */
  isReadonlyRoot: (root: string) => boolean;
  /** Which types are drafting types (defaults to the shared set). */
  types?: ReadonlySet<WatcherType>;
}

/**
 * The read-only root a wiki-drafting watcher would draft INTO, as a decision.
 *
 * The two drafting types name their wiki differently and there is no shared
 * accessor: `wiki-gardener` drafts into the OWNING BOT's `wikiDir`, while
 * `consolidation-gardener` drafts into the registry wiki named by
 * `config.wiki` (which need not be a bot wiki at all — mimir is the live case).
 * Both checkers skip a read-only root on the SCHEDULED path; this is the same
 * question asked one layer up.
 *
 * The type gate is `WIKI_DRAFTING_WATCHER_TYPES` — the same set the instance
 * gate reads — never a second hardcoded list, because a set with a member this
 * function has no branch for is exactly the disagreement the shared set exists
 * to prevent. A watcher naming no wiki at all is `allow`: there is nothing to
 * judge, and the checker's own resolution is what will complain.
 */
export function wikiDraftingTarget(
  watcher: { type: WatcherType; botName: string; config?: Record<string, unknown> | null },
  deps: WikiDraftingTargetDeps,
): WikiDraftingTarget {
  const types = deps.types ?? WIKI_DRAFTING_WATCHER_TYPES;
  if (!types.has(watcher.type)) return { kind: "allow" };
  let root: string | undefined;
  if (watcher.type === "wiki-gardener") {
    root = deps.botWikiDir(watcher.botName);
  } else if (watcher.type === "consolidation-gardener") {
    const name = watcher.config?.wiki;
    if (typeof name === "string" && name.trim()) root = deps.wikiRootByName(name);
  } else {
    return { kind: "unhandled" };
  }
  if (root && deps.isReadonlyRoot(root)) return { kind: "readonly-root", root };
  return { kind: "allow" };
}
