/**
 * The gate's review category for a draft: `entertainment` (films, TV, streaming
 * catalogs) or null. `/wiki/gardener` groups drafts by it, so a reviewer can
 * approve everything else in one batch and handle the films and series apart.
 *
 * Two conditions: the page lands under `life/` (the drafter files films and TV
 * there; an AI-industry page about streaming or short dramas lands under
 * `sources/` and keeps its `entertainment` tag), and its frontmatter `tags:`
 * carry one of the tags below. Measured 2026-11-11 on 32 jarvis drafts: the 7
 * film/TV drafts match, none of the other 25 does. A plain `streaming` tag is
 * left out: it also means LLM token streaming.
 */

import { parseFrontmatter } from "../wiki/store.ts";
import { splitFrontmatter } from "../wiki/page-text.ts";

export type ProposalCategory = "entertainment";

const ENTERTAINMENT_TAGS = new Set([
  "entertainment",
  "film",
  "films",
  "film-review",
  "movie",
  "movies",
  "movie-list",
  "movie-review",
  "cinema",
  "documentary",
  "documentaries",
  "television",
  "tv",
  "tv-series",
  "tv-show",
  "tv-shows",
  "tv-review",
  "k-drama",
  "anime",
  "netflix",
  "prime-video",
  "apple-tv-plus",
  "hbo",
  "hbo-max",
  "disney-plus",
  "hulu",
  "paramount-plus",
]);

/** The draft's tags: an inline list or a comma string through `parseFrontmatter`,
 *  else a block list (`tags:` then `- item` lines), which it does not read. */
function draftTags(draft: string): string[] {
  const raw = parseFrontmatter(draft).tags;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return raw.split(",");
  const fm = splitFrontmatter(draft).frontmatter ?? "";
  const block = /^tags:[ \t]*\r?\n((?:[ \t]+-[^\n]*\n?)+)/m.exec(fm);
  return block ? block[1]!.split("\n").map((l) => l.replace(/^\s*-\s*/, "")) : [];
}

/** The category of a draft at `targetPath`, or null. */
export function proposalCategory(draft: string, targetPath: string): ProposalCategory | null {
  if (!targetPath.startsWith("life/")) return null;
  for (const t of draftTags(draft)) {
    if (ENTERTAINMENT_TAGS.has(t.trim().toLowerCase().replace(/^["']|["']$/g, ""))) return "entertainment";
  }
  return null;
}
