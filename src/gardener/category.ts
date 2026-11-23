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
 * left out (it also means LLM token streaming), and so is `documentary`:
 * `life/` holds health and parenting pages, and a documentary there is not
 * one to reject with the films.
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
 *  else a block list, which it does not read: `tags:` with no value, then
 *  `- item` lines at any indent (zero included), blank lines allowed between
 *  them, up to the next key. */
function draftTags(draft: string): string[] {
  const raw = parseFrontmatter(draft).tags;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return raw.split(",");
  const lines = (splitFrontmatter(draft).frontmatter ?? "").split("\n").map((l) => l.replace(/\r$/, ""));
  const start = lines.findIndex((l) => /^tags:[ \t]*$/.test(l));
  if (start < 0) return [];
  const tags: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^[ \t]*-[ \t]*(.*)$/.exec(line);
    if (item) tags.push(item[1]!);
    else if (line.trim()) break;
  }
  return tags;
}

/** The category of a draft at `targetPath`, or null. */
export function proposalCategory(draft: string, targetPath: string): ProposalCategory | null {
  if (!targetPath.startsWith("life/")) return null;
  for (const t of draftTags(draft)) {
    if (ENTERTAINMENT_TAGS.has(t.trim().toLowerCase().replace(/^["']|["']$/g, ""))) return "entertainment";
  }
  return null;
}
