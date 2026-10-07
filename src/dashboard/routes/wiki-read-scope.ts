/**
 * Which wikis the READ slice serves (`registerWikiReadRoutes` + the graph
 * route), and the one `?wiki=`/`?bot=` resolution those routes share.
 *
 * On the full surface (`default`) this is `resolveWikiRequest` over the whole
 * registry, unchanged. When the read slice is the whole wiki surface
 * (`servesWikiReadSliceOnly` — the nais pod, where role `user` reaches these
 * routes), only a wiki whose served ROOT is read-only (`isReadonlyWikiRoot`,
 * i.e. listed in `WIKI_READONLY_ROOTS`) is servable, for every role. Any other
 * registered wiki — a bot's `wikiDir`, a writable `WIKI_EXTRA`, the `WIKI_DIR`
 * env override, the hard-coded jarvis fallback — resolves as UNKNOWN: the API
 * routes answer 404 and the `/wiki` picker never lists it. Defence in depth
 * behind the deployment shape, which registers only the mirror: a stray
 * `WIKI_EXTRA` entry must not become readable by every team member.
 */
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { resolveWikiRequest, type WikiRegistryEntry, type WikiRequestResolution } from "../../wiki/registry.ts";
import { isReadonlyWikiRoot } from "../../wiki/readonly.ts";
import { getWikiIndex, resolveWikiRoot, type WikiIndex, type WikiPageMeta } from "../../wiki/store.ts";

export interface ReadScopeResolution extends WikiRequestResolution {
  /** The registry the request was resolved against — the picker's list. */
  readonly registry: WikiRegistryEntry[];
}

/** The registry a read route may serve from. Read-only roots only under the slice. */
export function readScopeRegistry(readSliceOnly: boolean): WikiRegistryEntry[] {
  const registry = getWikiRegistry();
  return readSliceOnly ? registry.filter((e) => isReadonlyWikiRoot(e.root)) : registry;
}

export function resolveReadRequest(
  readSliceOnly: boolean,
  rawWiki: string | undefined,
  rawBot: string | undefined,
): ReadScopeResolution {
  const registry = readScopeRegistry(readSliceOnly);
  if (!readSliceOnly) {
    return { registry, ...resolveWikiRequest(registry, rawWiki, rawBot, process.env.WIKI_DIR) };
  }
  // The env override counts only when its own root is read-only.
  const envDir = process.env.WIKI_DIR;
  const envServable = !!envDir?.trim() && isReadonlyWikiRoot(resolveWikiRoot(undefined));
  const r = resolveWikiRequest(registry, rawWiki, rawBot, envServable ? envDir : undefined);
  // No entry and no servable override: the store would fall back to WIKI_DIR or
  // the jarvis default, neither of which is servable here.
  if (!r.entry && !r.envOverride && !r.unknownWiki) return { registry, ...r, unknownWiki: true };
  return { registry, ...r };
}

/** One page resolved in the served scope, or the status and error the read
 *  routes answer when it is not. */
export type ScopedPageLookup =
  | { ok: true; entry: WikiRegistryEntry | undefined; index: WikiIndex; meta: WikiPageMeta }
  | { ok: false; status: 400 | 404 | 503; error: string };

/**
 * The page resolution `/api/wiki/page`, `/api/wiki/page/provenance`,
 * `/api/wiki/related` and the answer routes share: `wiki`/`bot` → registry
 * entry in the served scope ({@link resolveReadRequest}), then `relPath`
 * (exact, collision-proof) else `name` (first stem match) → page. Takes values,
 * not a request, so a POST resolves its body's page through the same ladder.
 */
export async function resolveScopedPage(
  readSliceOnly: boolean,
  q: { wiki?: string; bot?: string; relPath?: string; name?: string },
): Promise<ScopedPageLookup> {
  if (!q.relPath && !q.name) return { ok: false, status: 400, error: "name or relPath query param required" };
  const { entry, unknownWiki } = resolveReadRequest(readSliceOnly, q.wiki, q.bot);
  if (unknownWiki) return { ok: false, status: 404, error: "no wiki configured for that name" };
  const index = await getWikiIndex({ root: entry?.root });
  if (!index) return { ok: false, status: 503, error: "wiki directory not found" };
  const meta = q.relPath ? index.resolveRelPath(q.relPath) : index.resolve(q.name!);
  if (!meta) {
    const which = q.relPath ? `relPath "${q.relPath}"` : `name "${q.name}"`;
    return { ok: false, status: 404, error: `no wiki page for ${which}` };
  }
  return { ok: true, entry, index, meta };
}
