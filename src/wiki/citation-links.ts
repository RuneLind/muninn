/**
 * Map research/ask citations onto pages in a registered wiki, so a citation can
 * open as a page in the `/wiki` reader instead of a raw doc panel.
 *
 * Two layers:
 *  - `matchCitationToPage` (pure, testable): given a citation's doc id/title and
 *    a wiki index's `resolve` fn (names/titles/aliases, case-insensitive), return
 *    the matched canonical page name or `null`.
 *  - `enrichCitationsWithPages` (async): for a list of citations, resolve each
 *    against the wiki that owns its collection (via `buildCollectionWikiMap`) and
 *    attach `wikiName` + `pageName` when a page matches. Each wiki's index is
 *    loaded at most once per call.
 */

import type { Citation } from "../research/answer.ts";
import type { WikiRegistryEntry } from "./registry.ts";
import { getWikiIndex, type WikiIndex, type WikiPageMeta } from "./store.ts";

/**
 * Collection name → owning wiki name. The first registry entry that lists a
 * collection wins (registry order: bot wikis before standalone). Collections are
 * matched exactly (they are Huginn collection ids, not free text).
 */
export function buildCollectionWikiMap(registry: WikiRegistryEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of registry) {
    for (const collection of entry.collections ?? []) {
      if (!map.has(collection)) map.set(collection, entry.name);
    }
  }
  return map;
}

/** A citation's fields this helper reads — kept minimal so tests need no full Citation. */
export interface CitationDocRef {
  docId?: string;
  title?: string;
}

/**
 * Resolve a citation to a wiki page name via the index's `resolve`, or `null`.
 * Tries, in order: the doc id's basename (sans `.md`), the full doc id (sans
 * `.md`), then the title — `resolve` handles names/titles/aliases case-
 * insensitively, so the first that lands wins.
 */
export function matchCitationToPage(
  citation: CitationDocRef,
  resolve: (target: string) => WikiPageMeta | undefined,
): string | null {
  const candidates: string[] = [];
  if (citation.docId) {
    const base = citation.docId.split("/").pop() ?? citation.docId;
    candidates.push(base.replace(/\.md$/i, ""));
    candidates.push(citation.docId.replace(/\.md$/i, ""));
  }
  if (citation.title) candidates.push(citation.title);
  for (const cand of candidates) {
    const name = cand.trim();
    if (!name) continue;
    const meta = resolve(name);
    if (meta) return meta.name;
  }
  return null;
}

/**
 * Attach `wikiName` + `pageName` to each citation whose collection belongs to a
 * registered wiki AND whose doc resolves to a page in that wiki. Citations for
 * off-wiki collections (or unmatched docs) pass through unchanged. Loads each
 * referenced wiki's index at most once.
 */
export async function enrichCitationsWithPages(
  citations: Citation[],
  registry: WikiRegistryEntry[],
): Promise<Citation[]> {
  const collMap = buildCollectionWikiMap(registry);
  if (collMap.size === 0) return citations;

  const indexCache = new Map<string, WikiIndex | null>();
  const result: Citation[] = [];
  for (const c of citations) {
    const wikiName = collMap.get(c.collection);
    if (!wikiName) {
      result.push(c);
      continue;
    }
    let index = indexCache.get(wikiName);
    if (index === undefined) {
      const entry = registry.find((e) => e.name === wikiName);
      index = await getWikiIndex({ root: entry?.root });
      indexCache.set(wikiName, index);
    }
    const pageName = index ? matchCitationToPage(c, index.resolve) : null;
    result.push(pageName ? { ...c, wikiName, pageName } : c);
  }
  return result;
}
