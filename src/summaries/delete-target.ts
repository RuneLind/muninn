/**
 * Which wiki the `/summaries` doc panel's 🗑 Delete posts against.
 *
 * The delete is the gardener's `backlog-doc-delete` route, which is keyed on a
 * BOT wiki (its source drafter wrote the proposals the route also deletes, and
 * its `wiki-gardener` watcher owns the snapshots it prunes). The page therefore
 * decides the target ONCE, server-side, and injects it — a client that posted
 * with no `?wiki=` would inherit `resolveWikiRequest`'s defaults, which answer a
 * `WIKI_DIR` override with NO entry at all (a 404 "no wiki bot resolved") and a
 * `WIKI_EXTRA` default with a standalone wiki (a 400 about the ingest backlog).
 *
 * Returns `null` — the button is NOT rendered — when there is no bot wiki, when
 * the instance is wiki-readonly, or when the chosen root is a read-only root.
 * Those are the three refusals the route answers with, and a destructive confirm
 * dialog in front of a guaranteed refusal is worse than no button.
 *
 * Which bot wiki: the registry's default (`jarvis`, else the first entry) when it
 * IS a bot wiki, else the first bot wiki whose root is writable. (`/wiki/gardener`
 * stops at the default and renders a "not a bot wiki" notice for a standalone one;
 * this page has no such notice, so it falls through instead.) The one gate this
 * cannot see is the seeded `wiki-gardener` watcher — the route 404s without one,
 * and the client shows that message.
 */
import type { WikiRegistryEntry } from "../wiki/registry.ts";
import { defaultWikiEntry } from "../wiki/registry.ts";

export function resolveSummariesDeleteTarget(
  registry: WikiRegistryEntry[],
  opts: { instanceReadonly: boolean; isReadonlyRoot: (root: string) => boolean },
): { wiki: string } | null {
  if (opts.instanceReadonly) return null;
  const dflt = defaultWikiEntry(registry);
  const usable = (e: WikiRegistryEntry) => e.source === "bot" && !opts.isReadonlyRoot(e.root);
  const entry = dflt && usable(dflt) ? dflt : registry.find(usable);
  return entry ? { wiki: entry.name } : null;
}
