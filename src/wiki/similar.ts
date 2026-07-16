/**
 * "Similar articles" for a wiki page — the semantic-cousins layer behind the
 * reader's Connections panel. Given a page, we build a short search query from
 * its title + tags + first body paragraph, run it against the wiki's backing
 * Huginn collections, and resolve the hits back onto pages in the SAME wiki
 * (reusing `citation-links.ts`'s `matchCitationToPage`). The current page and
 * any hit that doesn't resolve to a wiki page are dropped.
 *
 * All logic here is pure/DOM-free so the query construction and hit resolution
 * are unit-testable without a Huginn call; the route (`wiki-routes.ts`) supplies
 * the actual `fetchKnowledgeApi` search.
 */

import { matchCitationToPage } from "./citation-links.ts";
import type { WikiIndex, WikiPageMeta } from "./store.ts";

/** The minimal shape of a Huginn `/api/search` hit this module reads. */
export interface SimilarSearchHit {
  collection?: string;
  id?: string;
  title?: string;
  relevance?: number;
  matchedChunks?: unknown[];
}

/** One resolved similar page, as returned to the reader client. */
export interface SimilarPage {
  name: string;
  title: string;
  relPath: string;
  type: string;
  snippet?: string;
  relevance: number;
}

/**
 * Extract the first real body paragraph from a markdown page: skip the
 * frontmatter fence and any leading heading lines, then take the first
 * non-empty, non-heading block. Whitespace is collapsed and the result capped
 * (default 500 chars) so the search query stays bounded. Returns "" when the
 * page is heading-only or empty.
 */
export function firstBodyParagraph(md: string, cap = 500): string {
  let text = md;
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const afterFence = text.indexOf("\n", end + 1);
      text = afterFence === -1 ? "" : text.slice(afterFence + 1);
    }
  }
  for (const block of text.split(/\n\s*\n/)) {
    let trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("```")) continue; // fenced code block — not prose
    // Drop leading heading lines but keep any prose that follows in the same
    // block (tightly-formatted pages put `# Heading\nintro` in one block).
    trimmed = trimmed
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
      .trim();
    if (!trimmed) continue; // heading-only block
    return trimmed.replace(/\s+/g, " ").slice(0, cap);
  }
  return "";
}

/**
 * Build the semantic-search query for a page. Title + tags always; the first
 * body paragraph is appended when a body is given — the markdown page body for
 * md pages, the sniffed `<meta name="description">` for explainers (empty when
 * an explainer has none, leaving its query title + tags only).
 */
export function buildSimilarQuery(meta: WikiPageMeta, body: string): string {
  const parts: string[] = [meta.title];
  if (meta.tags.length) parts.push(meta.tags.join(" "));
  const para = body ? firstBodyParagraph(body) : "";
  if (para) parts.push(para);
  return parts.join(" — ").trim();
}

/**
 * Build the Huginn `/api/search` path with ONE repeated `collection` param per
 * collection (Huginn rejects a comma-joined list) and the HTTP `limit` param
 * (not the internal `max_number_of_documents`). Mirrors `buildSearchPath` in
 * `research-knowledge.ts`.
 */
export function buildSimilarSearchPath(
  query: string,
  collections: string[],
  limit: number,
): string {
  const params = new URLSearchParams({ q: query });
  if (limit > 0) params.set("limit", String(limit));
  for (const c of collections) params.append("collection", c);
  return `/api/search?${params}`;
}

/** Pull a short snippet from a hit's first matched chunk, if any. */
function hitSnippet(hit: SimilarSearchHit, cap = 240): string | undefined {
  const chunk = Array.isArray(hit.matchedChunks) ? hit.matchedChunks[0] : undefined;
  if (chunk && typeof chunk === "object" && "content" in chunk) {
    const content = (chunk as { content: unknown }).content;
    if (typeof content === "string") {
      const text = content.replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, cap);
    }
  }
  return undefined;
}

/** Resolve a single hit to a page in this wiki, or `undefined`. Prefers the
 *  relPath lookup (Huginn doc `id` IS the wiki-relative path) and falls back to
 *  the citation-links name/title matcher. */
function resolveHitMeta(index: WikiIndex, hit: SimilarSearchHit): WikiPageMeta | undefined {
  if (hit.id) {
    const byRel = index.resolveRelPath(hit.id);
    if (byRel) return byRel;
  }
  const name = matchCitationToPage({ docId: hit.id, title: hit.title }, index.resolve);
  return name ? index.resolve(name) : undefined;
}

/**
 * Resolve raw Huginn hits to wiki pages, drop the current page (matched on
 * relPath or name), drop hits that don't resolve to a page, dedupe by relPath,
 * and return the top `limit` ordered by relevance (descending).
 */
export function resolveSimilarHits(
  hits: SimilarSearchHit[],
  index: WikiIndex,
  current: WikiPageMeta,
  limit = 5,
): SimilarPage[] {
  const out: SimilarPage[] = [];
  const seen = new Set<string>();
  const sorted = [...hits].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
  for (const hit of sorted) {
    const meta = resolveHitMeta(index, hit);
    if (!meta) continue; // unresolved external — drop
    if (meta.relPath === current.relPath || meta.name === current.name) continue; // self
    if (seen.has(meta.relPath)) continue;
    seen.add(meta.relPath);
    out.push({
      name: meta.name,
      title: meta.title,
      relPath: meta.relPath,
      type: meta.type,
      snippet: hitSnippet(hit),
      relevance: hit.relevance ?? 0,
    });
    if (out.length >= limit) break;
  }
  return out;
}
