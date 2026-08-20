/**
 * Map research/ask citations onto pages in a registered wiki, so a citation can
 * open as a page in the `/wiki` reader instead of a raw doc panel.
 *
 * Two layers:
 *  - `matchCitationToPage` (pure, testable): given a citation's doc id/title and
 *    a wiki index's `resolve` (names/titles/aliases, case-insensitive) plus its
 *    optional `resolveRelPath`, return the matched page's meta or `null`.
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
 *
 * Assumes collections are 1:1 per wiki — a given collection belongs to exactly
 * one wiki. `/research` passes the full registry and relies on this first-wins
 * behavior; `/api/wiki/ask` sidesteps the assumption by passing only the resolved
 * wiki entry, so a collection shared across wikis still attributes correctly.
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
 * Resolve a citation to a wiki PAGE (its `WikiPageMeta`), or `null`.
 *
 * Tries, in order: the doc id as a wiki-relative PATH (a huginn doc id for a wiki
 * collection IS the relPath), the full doc id sans `.md` through `resolve` (whose
 * own path branch handles the extension-less form), the doc id's basename, then
 * the title — `resolve` handles names/titles/aliases case-insensitively, so the
 * first that lands wins.
 *
 * **The path forms are tried BEFORE the bare stem, and the META is returned
 * rather than its name.** Both halves are the same bug: `resolve` is
 * first-registration-wins on the lowercased stem, so on a wiki holding two
 * same-stem pages a cite of `projects/yggdrasil/architecture.md` matched
 * `projects/claude-hivemind/architecture.md` — and a caller that took the NAME
 * back and re-resolved it landed there even when the match had been correct.
 * Returning the matched meta is what lets the caller stamp ITS relPath, so the
 * cite marker and the reader open the page that was actually cited.
 */
export function matchCitationToPage(
  citation: CitationDocRef,
  resolve: (target: string) => WikiPageMeta | undefined,
  resolveRelPath?: (relPath: string) => WikiPageMeta | undefined,
): WikiPageMeta | null {
  const docId = citation.docId?.trim();
  if (docId && resolveRelPath) {
    const byRel = resolveRelPath(docId);
    if (byRel) return byRel;
  }
  const candidates: string[] = [];
  if (docId) {
    const stripped = docId.replace(/\.md$/i, "");
    candidates.push(docId, stripped);
    const base = stripped.split("/").pop() ?? stripped;
    candidates.push(base);
  }
  if (citation.title) candidates.push(citation.title);
  for (const cand of candidates) {
    const name = cand.trim();
    if (!name) continue;
    const meta = resolve(name);
    if (meta) return meta;
  }
  return null;
}

/**
 * Attach `wikiName` + `pageName` (+ `pageRelPath`) to each citation whose collection belongs to a
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
    // The MATCHED page rides along whole: `pageName` is a stem, and every consumer
    // of it (the cite marker, the Sources row) resolves that stem
    // first-registration-wins. Re-resolving the name here to recover a path put a
    // yggdrasil cite's `pageRelPath` on claude-hivemind's page; the matcher hands
    // back the meta it matched, so the two can never name different pages.
    const meta = index ? matchCitationToPage(c, index.resolve, index.resolveRelPath) : null;
    result.push(
      meta
        ? { ...c, wikiName, pageName: meta.name, ...(meta.relPath ? { pageRelPath: meta.relPath } : {}) }
        : c,
    );
  }
  return result;
}
