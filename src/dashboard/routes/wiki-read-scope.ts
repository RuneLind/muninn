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
import { resolveWikiRoot } from "../../wiki/store.ts";

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
