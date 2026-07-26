/**
 * Destination-URL normalization for pointer-tweet (`x-link`) candidate keying.
 *
 * A "X just dropped …" wave arrives as N pointer tweets from N different authors,
 * ≈1 per 2h watcher batch over days — all pointing at the SAME destination. Keying
 * each candidate row on the tweet permalink yields N near-identical inbox rows;
 * keying on the normalized destination collapses the wave to ONE row ACROSS runs
 * (in-batch dedup alone would almost never fire at that arrival rate).
 *
 * **Deliberately NOT `normalizeArticleUrl`** (`src/watchers/x-amplification.ts`):
 * that one strips the WHOLE query, which is correct for `x.com/<owner>/article/<id>`
 * permalinks but would collapse every `youtube.com/watch?v=…` into a single key here.
 * This normalizer keeps the query and strips only tracking params.
 */

import { isSkippedHost } from "./doc-links.ts";
import { youTubeVideoId } from "../anthropic/link-enrichment.ts";

/**
 * Query params that carry no identity — sharing/attribution noise two members of the
 * same wave will disagree on. `utm_*` is matched by prefix; these are matched exactly.
 * Kept deliberately short: an unknown param is assumed load-bearing (`?v=`, `?id=`).
 */
const TRACKING_PARAMS = new Set(["si", "ref"]);

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith("utm_") || TRACKING_PARAMS.has(k);
}

/**
 * Normalize an external destination URL into a stable group key:
 * lowercase scheme + host (NEVER the path or query — those are case-significant,
 * e.g. a YouTube video id), a leading `www.` stripped from the host, `http://`
 * upgraded to `https://` (the scheme is upstream data; one `http://` member would
 * silently split a wave in half), fragment dropped, tracking params (`utm_*`, `si`,
 * `ref`) dropped, the rest of the query KEPT, and trailing slashes trimmed. Every
 * YouTube form (`youtu.be/<id>`, `/shorts/`, `/embed/`, `/live/`, `watch?v=`)
 * canonicalizes to `https://youtube.com/watch?v=<id>`.
 *
 * **Deliberate non-decisions**, both re-checked against real x-feed data (see
 * `src/watchers/CLAUDE.md`, "Destination-URL keying"):
 *  - the remaining query params are **NOT sorted** — zero real occurrences of a
 *    same-destination pair disagreeing only on param order, and reordering risks
 *    order-sensitive servers when the key is later fetched;
 *  - `ref` is stripped along with `si`/`utm_*`. It's the borderline one (a few sites
 *    use `ref` as a real path-ish selector); on the wave-collapse side of the trade,
 *    flagged as a watch item.
 *  - the `http://`→`https://` upgrade **keeps an explicit port**, so a
 *    `http://host:8080/x` key is unfetchable as written. Zero real occurrences; not
 *    worth a special case.
 *
 * Returns null when the input doesn't parse or isn't `http(s)`.
 */
export function normalizeDestinationUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const protocol = u.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return null;

  // One video = one key, whichever of the five YouTube URL shapes a wave member used
  // (`youtu.be/<id>` vs `www.youtube.com/watch?v=<id>&t=42` vs `/shorts/<id>`). The id
  // extractor is host-gated, so a non-YouTube URL that happens to carry `?v=<11 chars>`
  // is untouched. Timestamps/playlist params are dropped WITH the rewrite — they're
  // view state, not identity.
  const videoId = youTubeVideoId(u.href);
  if (videoId) return `https://youtube.com/watch?v=${videoId}`;

  for (const key of [...u.searchParams.keys()]) {
    if (isTrackingParam(key)) u.searchParams.delete(key);
  }
  const query = u.searchParams.toString();
  const path = u.pathname.replace(/\/+$/, "");
  // `u.host` carries the port; the URL parser already lowercases the hostname. Real
  // x-feed data carries BOTH `anthropic.com` and `www.anthropic.com` for the same
  // destination, so the `www.` prefix is host variance, not identity.
  const host = u.host.replace(/^www\./, "");
  // The fragment is dropped — EXCEPT on a hash-routed SPA (`site.example/#/post/123`),
  // where the path is empty and the whole route lives after the `#`. Dropping it there
  // would collapse every page of that site onto one key.
  const hashRoute = path === "" && u.hash.startsWith("#/") ? u.hash : "";
  return `https://${host}${path}${query ? `?${query}` : ""}${hashRoute}`;
}

/** Is `url` a fetchable EXTERNAL destination (parseable http(s), not an x.com/t.co self-link)? */
export function isDestinationUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  const protocol = u.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return false;
  return !isSkippedHost(u.hostname);
}

/**
 * Does the URL's path point at a PDF? Matches a `.pdf` extension OR a `/pdf/` path
 * SEGMENT (the extension-less arxiv form `arxiv.org/pdf/2401.00001v1`), both
 * case-insensitively. The segment rule deliberately over-matches a little
 * (`site/pdf/guide` counts) — over-matching only means the candidate keeps today's
 * tweet-URL keying, which is the conservative side of the carve-out.
 */
export function isPdfUrl(raw: string): boolean {
  try {
    const path = new URL(raw.trim()).pathname.toLowerCase();
    if (path.endsWith(".pdf")) return true;
    return path.split("/").includes("pdf");
  } catch {
    return false;
  }
}

/**
 * The destination group key for a pointer tweet, or null when the tweet must keep
 * TODAY'S tweet-URL keying.
 *
 * Group key = `normalize(links[0])` — the FIRST external link only, matching the gate's
 * `links to:` line and `pickEnrichmentLink`'s single-link design. Two docs listing the
 * same pair of links in a different order key differently and don't collapse; accepted.
 *
 * Returns null (⇒ tweet-URL keying) when:
 *  - there is no external link, or it doesn't parse / isn't http(s);
 *  - the destination is an x.com/twitter.com/t.co self-link (defence in depth —
 *    `extractDocLinks` already filters those hosts, so this can't fire today);
 *  - the destination is a **PDF** ({@link isPdfUrl}). NOT because destination-keying
 *    would degrade the content: enrichment already `res.text()`s the PDF today on the
 *    tweet-keyed path, so the model sees the same bytes either way. The carve-out is
 *    **conservative v1 scoping** — the PDF pointer class holds the most-valued
 *    summarized candidates on the shelf (the Andrew Ng PDF), and the plan pins its
 *    exact current behavior rather than moving two things at once. Real PDF text
 *    extraction + destination-keying for PDFs is a named follow-up; until then a paper
 *    drop gets no wave-collapse (N pointer rows), a stated trade.
 */
export function destinationGroupKey(links: readonly string[]): string | null {
  const first = links[0];
  if (!first) return null;
  if (!isDestinationUrl(first)) return null;
  if (isPdfUrl(first)) return null;
  return normalizeDestinationUrl(first);
}
