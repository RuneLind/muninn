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
 * Which bot wiki — the whole state space, enumerated:
 *   - no bot wiki in the registry            ⇒ null
 *   - default is a bot wiki, root writable    ⇒ the default
 *   - default is a bot wiki, root read-only   ⇒ null — NEVER the next bot: the route
 *     deletes the resolved bot's proposals, and another bot's drafts are not the
 *     ones written from this doc's gardener, so re-pointing would delete the wrong
 *     bot's drafts and leave the right ones dangling behind a "success" notice
 *   - default is standalone (`WIKI_EXTRA`)    ⇒ the first bot wiki, if writable, else null
 * (`/wiki/gardener` keeps a standalone default and explains itself on the page;
 * this page has no such notice, so it falls through past a standalone only.) The
 * one gate this cannot see is the seeded `wiki-gardener` watcher — the route 404s
 * without one, and the client shows that message.
 */
import type { WikiRegistryEntry } from "../wiki/registry.ts";
import { defaultWikiEntry } from "../wiki/registry.ts";

export function resolveSummariesDeleteTarget(
  registry: WikiRegistryEntry[],
  opts: { instanceReadonly: boolean; isReadonlyRoot: (root: string) => boolean },
): { wiki: string } | null {
  if (opts.instanceReadonly) return null;
  const dflt = defaultWikiEntry(registry);
  const entry = dflt && dflt.source === "bot" ? dflt : registry.find((e) => e.source === "bot");
  if (!entry || opts.isReadonlyRoot(entry.root)) return null;
  return { wiki: entry.name };
}
