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
 * Returns `null` — the button is NOT rendered — when there is no bot wiki (the
 * route 404s), when the chosen root is a read-only root (the route 403s), or when
 * the instance is wiki-readonly. The last is this PAGE's choice, not a route
 * refusal: `backlog-doc-delete` carries no `MUNINN_WIKI_READONLY` gate (it writes
 * no wiki page), but a second instance that may not edit the wiki has no business
 * deleting the drafts the write owner's gardener is reviewing. A destructive
 * confirm dialog in front of a refusal is worse than no button.
 *
 * Which bot wiki — the whole state space, enumerated:
 *   - no bot wiki in the registry            ⇒ null
 *   - default is a bot wiki, root writable    ⇒ the default
 *   - default is a bot wiki, root read-only   ⇒ null — NEVER the next bot: the route
 *     deletes the resolved bot's proposals, and another bot's drafts are not the
 *     ones written from this doc's gardener, so re-pointing would delete the wrong
 *     bot's drafts and leave the right ones dangling behind a "success" notice
 *   - default is standalone (`WIKI_EXTRA`)    ⇒ the first bot wiki, if writable, else null
 *     — "first" is positional, not "the bot whose drafter wrote from this doc"; on
 *     a multi-bot instance with a standalone default that can be the wrong bot
 *     (0 proposals matched, the right bot's drafts left dangling). Known residual,
 *     declared on the PR; the fix is to resolve the bot from the proposal rows.
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
