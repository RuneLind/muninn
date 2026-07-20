/**
 * Pure link-enrichment helpers for the X (source-doc-id) summarize path.
 *
 * An x-feed doc's value often sits behind a link the tweet points to (a YouTube
 * video, an article) that the summarizer never fetched — it judged/summarized on
 * the tweet text alone. These helpers parse the ONE fetchable external destination
 * out of the doc footer so the summarizer can follow it.
 *
 * The footer-link parser itself (`extractDocLinks`) is hoisted to
 * `src/summaries/doc-links.ts` and re-exported here — the X watcher's link-tweet
 * eligibility parses the same footer, and one definition keeps the load-bearing
 * singular-`**Link:**`-vs-plural-`**Links:**` distinction from drifting.
 */

export { extractDocLinks } from "../summaries/doc-links.ts";

/** YouTube hosts whose URLs may carry a fetchable video id. */
const YOUTUBE_HOSTS = [
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
];

/**
 * YouTube-only video-id extractor: `watch?v=<id>`, `youtu.be/<id>`,
 * `youtube.com/shorts/<id>`, `youtube.com/embed/<id>`, `youtube.com/live/<id>`
 * → the 11-char id; anything else → null.
 *
 * The id patterns are applied ONLY when the URL's hostname is a YouTube host —
 * otherwise an article URL that happens to carry `?v=<11 chars>` or a `/shorts/`
 * path segment would be misclassified as `youtube`, and the transcript fetch
 * would then 404 instead of the article being fetched.
 *
 * Deliberately narrower than `docIdFromUrl` (`../wiki/ingest-backlog.ts`, which
 * ALSO matches X `/status/` + TikTok `/video/` ids) and wider than youtube-routes'
 * `extractYouTubeVideoId` (which lacks `/shorts/`) — this is the one place these
 * quirks are handled for enrichment.
 */
export function youTubeVideoId(url: string): string | null {
  let host: string;
  let pathname: string;
  let search: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    pathname = u.pathname;
    search = u.search;
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.includes(host)) return null;
  const m =
    search.match(/[?&]v=([A-Za-z0-9_-]{11})/) ??
    pathname.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/) ??
    pathname.match(/^\/([A-Za-z0-9_-]{11})$/); // youtu.be/<id>
  return m ? m[1]! : null;
}

export type EnrichmentKind = "youtube" | "article";

export interface EnrichmentLink {
  url: string;
  kind: EnrichmentKind;
}

/**
 * Pick the ONE link to enrich from a doc's external destinations: the FIRST
 * external link (single-link by design — multi-link fetching is out of scope).
 * A YouTube watch/youtu.be/shorts URL is kind `youtube` (transcript-fetchable);
 * everything else is kind `article` (direct-fetchable). Returns null for [].
 */
export function pickEnrichmentLink(links: string[]): EnrichmentLink | null {
  const url = links[0];
  if (!url) return null;
  return { url, kind: youTubeVideoId(url) !== null ? "youtube" : "article" };
}
