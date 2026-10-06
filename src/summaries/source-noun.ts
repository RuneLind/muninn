/**
 * The noun a summary uses for its captured item (D7): from the URL's host
 * first — `article-summaries` holds pasted transcripts of videos and talks too —
 * then from the collection. Shared by the drafter rider
 * (`src/gardener/factcheck-carry.ts`) and the `/summaries` Integrate
 * (`factcheck-integrate.ts`), so both attribute to the same noun.
 */

const HOST_NOUNS: readonly [RegExp, string][] = [
  [/(^|\.)(youtube\.com|youtu\.be|tiktok\.com)$/, "the video"],
  [/(^|\.)vimeo\.com$/, "the talk"],
  [/(^|\.)(x\.com|twitter\.com)$/, "the post"],
];

const COLLECTION_NOUNS: Readonly<Record<string, string>> = {
  "vimeo-summaries": "the talk",
  "youtube-summaries": "the video",
  "tiktok-summaries": "the video",
  "x-articles": "the post",
  "anthropic-summaries": "the article",
  "article-summaries": "the article",
};

/** `"the video"`, `"the talk"`, `"the post"`, `"the article"`, or `"the source"`. */
export function sourceKindNoun(collection: string, url?: string | null): string {
  let host = "";
  try {
    host = url ? new URL(url).hostname.toLowerCase() : "";
  } catch {
    host = "";
  }
  for (const [re, noun] of HOST_NOUNS) if (host && re.test(host)) return noun;
  return COLLECTION_NOUNS[collection] ?? "the source";
}
