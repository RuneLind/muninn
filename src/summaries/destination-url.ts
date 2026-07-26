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
 * e.g. a YouTube video id), `http://` upgraded to `https://` (the scheme is upstream
 * data; one `http://` member would silently split a wave in half), fragment dropped,
 * tracking params (`utm_*`, `si`, `ref`) dropped, the rest of the query KEPT, and
 * trailing slashes trimmed.
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

  for (const key of [...u.searchParams.keys()]) {
    if (isTrackingParam(key)) u.searchParams.delete(key);
  }
  const query = u.searchParams.toString();
  const path = u.pathname.replace(/\/+$/, "");
  // `u.host` carries the port; the URL parser already lowercases the hostname.
  return `https://${u.host}${path}${query ? `?${query}` : ""}`;
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

/** Does the URL's path point at a PDF? (`.pdf`, case-insensitive.) */
export function isPdfUrl(raw: string): boolean {
  try {
    return new URL(raw.trim()).pathname.toLowerCase().endsWith(".pdf");
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
 *  - the destination is a **PDF**. A destination-keyed `.pdf` row would be summarized
 *    by the article path's `res.text()`, which has zero PDF handling and would feed raw
 *    bytes to the model. PDFs keep today's exact behavior (tweet-keyed `x-link` row,
 *    summarized from the tweet doc).
 */
export function destinationGroupKey(links: readonly string[]): string | null {
  const first = links[0];
  if (!first) return null;
  if (!isDestinationUrl(first)) return null;
  if (isPdfUrl(first)) return null;
  return normalizeDestinationUrl(first);
}
