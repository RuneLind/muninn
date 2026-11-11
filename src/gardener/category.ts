/**
 * The gate's review category for a draft: `entertainment` (films, TV, streaming
 * catalogs) or null. `/wiki/gardener` groups drafts by it, so a reviewer can
 * approve everything else in one batch and handle the films and series apart.
 *
 * Read from the draft's frontmatter `tags:`. The source drafter tags these pages
 * itself; measured 2026-11-11 on 32 jarvis drafts, every film/TV draft (7) carried
 * one of these tags and none of the other 25 did. A plain `streaming` tag is left
 * out on purpose: it also means LLM token streaming.
 */

import { parseFrontmatter } from "../wiki/store.ts";

export type ProposalCategory = "entertainment";

const ENTERTAINMENT_TAGS = new Set([
  "entertainment",
  "film",
  "films",
  "movie",
  "movies",
  "movie-list",
  "cinema",
  "television",
  "tv",
  "tv-series",
  "tv-show",
  "tv-shows",
  "netflix",
  "prime-video",
  "apple-tv-plus",
  "hbo",
  "hbo-max",
  "disney-plus",
  "anime",
]);

/** The category of a draft's frontmatter tags, or null. */
export function proposalCategory(draft: string): ProposalCategory | null {
  const raw = parseFrontmatter(draft).tags;
  const tags = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  for (const t of tags) {
    if (ENTERTAINMENT_TAGS.has(t.trim().toLowerCase().replace(/^["']|["']$/g, ""))) return "entertainment";
  }
  return null;
}
