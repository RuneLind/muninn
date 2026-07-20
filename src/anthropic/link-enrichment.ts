/**
 * Pure link-enrichment helpers for the X (source-doc-id) summarize path.
 *
 * An x-feed doc's value often sits behind a link the tweet points to (a YouTube
 * video, an article) that the summarizer never fetched — it judged/summarized on
 * the tweet text alone. These helpers parse the ONE fetchable external destination
 * out of the doc footer so the summarizer can follow it.
 *
 * Footer contract (huginn `x_fetcher.py`): a tweet doc carries TWO distinct
 * footer lines and they must not be confused —
 *   - `**Link:**  <url>`  (SINGULAR) — on EVERY tweet, the tweet's OWN x.com
 *     permalink. Never a destination; ignored here.
 *   - `**Links:** <url> <url> …` (PLURAL) — only when the tweet carries external
 *     destinations, the t.co-expanded URLs space-joined on ONE line.
 * So the "has a link" predicate parses ONLY the plural `**Links:**` line and
 * token-splits it on whitespace, then filters out x.com/twitter.com/t.co hosts so
 * only true external destinations remain.
 */

/** Hosts that are never an external destination (self-links + un-expanded t.co). */
const SKIP_HOSTS = ["x.com", "twitter.com", "t.co"];

/** Matches the plural `**Links:**` footer marker (NOT the singular `**Link:**`). */
const LINKS_MARKER = "**Links:**";

/** Is `host` one of the skip hosts, or a subdomain of one? */
function isSkippedHost(host: string): boolean {
  const h = host.toLowerCase();
  return SKIP_HOSTS.some((skip) => h === skip || h.endsWith(`.${skip}`));
}

/**
 * Extract the external destination URLs from an x-feed doc's `**Links:**` footer
 * line. Parses ONLY the plural marker (see contract above), token-splits it on
 * whitespace keeping `https?://` tokens, and drops x.com/twitter.com/t.co hosts.
 * Returns [] when there is no plural `**Links:**` line or it carries only
 * self/unexpanded hosts.
 */
export function extractDocLinks(docText: string): string[] {
  const out: string[] = [];
  for (const line of docText.split("\n")) {
    const idx = line.indexOf(LINKS_MARKER);
    if (idx === -1) continue;
    const after = line.slice(idx + LINKS_MARKER.length);
    for (const token of after.split(/\s+/)) {
      if (!/^https?:\/\//i.test(token)) continue;
      let host: string;
      try {
        host = new URL(token).hostname;
      } catch {
        continue;
      }
      if (isSkippedHost(host)) continue;
      out.push(token);
    }
  }
  return out;
}

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
