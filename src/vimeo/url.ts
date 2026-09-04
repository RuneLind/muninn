/**
 * Vimeo URL parsing — pure, no I/O.
 *
 * HOST-GATED, the same rule `extractTikTokVideoId` lives by (`src/video/media.ts`):
 * the hostname is checked FIRST and the path regex only runs against a real Vimeo
 * host. A bare `/(\d+)` match over the whole URL string would accept
 * `https://evil.example/vimeo.com/123` — a URL a third party controls, pointed at
 * a capture pipeline that then loads it in a browser.
 *
 * The dedup key is the numeric id ALONE (`canonicalVimeoUrl`). The unlisted
 * "private hash" is a credential for reaching the page, not part of the video's
 * identity — the same video reached with and without one must not capture twice.
 */

/** A Vimeo video reference: the numeric id, plus the unlisted private hash when
 *  the URL carried one. */
export interface VimeoVideoRef {
  readonly id: string;
  readonly hash?: string;
}

/**
 * Vimeo's unlisted private hash is lowercase hex (10 chars in the wild; the
 * range here is deliberately loose). Hex rather than `[0-9a-z]+` is what
 * disambiguates `vimeo.com/<id>/<hash>` from the video's own sub-pages —
 * `/likes`, `/collections`, `/settings`, `/videos` are all non-hex, so a strict
 * charset answers "is this segment a hash?" without a hand-kept deny list.
 */
const HASH_RE = /^[0-9a-f]{6,32}$/i;

/** Exact hosts, not a suffix test: `endsWith("vimeo.com")` also accepts
 *  `evilvimeo.com`. */
function isVimeoHost(hostname: string): "watch" | "player" | null {
  const host = hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (host === "vimeo.com") return "watch";
  if (host === "player.vimeo.com") return "player";
  return null;
}

/**
 * Extract `{id, hash?}` from any Vimeo URL shape muninn accepts:
 *   - `vimeo.com/<id>`                     (public)
 *   - `vimeo.com/<id>/<hash>`              (unlisted — the hash is KEPT)
 *   - `player.vimeo.com/video/<id>`        (embed)
 *   - `vimeo.com/channels/<channel>/<id>`  (channel page)
 * plus `?h=<hash>` on any of them, which is how the embed carries the same
 * private hash. `www.` is tolerated. Returns null for every other host and for
 * any Vimeo path that does not name a numeric video id.
 */
export function extractVimeoVideoId(url: string): VimeoVideoRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const kind = isVimeoHost(parsed.hostname);
  if (!kind) return null;

  const path = parsed.pathname;
  let id: string | null = null;
  let hash: string | undefined;

  if (kind === "player") {
    const m = path.match(/^\/video\/(\d+)\/?$/);
    if (m) id = m[1]!;
  } else {
    const bare = path.match(/^\/(\d+)(?:\/([^/]+))?\/?$/);
    if (bare) {
      id = bare[1]!;
      const seg = bare[2];
      // A trailing segment is a hash only if it LOOKS like one; `/likes` and the
      // other sub-pages fall through to "no hash", not to "not a Vimeo URL".
      if (seg && HASH_RE.test(seg)) hash = seg.toLowerCase();
    } else {
      const channel = path.match(/^\/channels\/[^/]+\/(\d+)\/?$/);
      if (channel) id = channel[1]!;
    }
  }
  if (!id) return null;

  const q = parsed.searchParams.get("h");
  if (!hash && q && HASH_RE.test(q)) hash = q.toLowerCase();

  return hash ? { id, hash } : { id };
}

/** The dedup/ingest key: the id alone, never the private hash. */
export function canonicalVimeoUrl(id: string): string {
  return `https://vimeo.com/${id}`;
}

/**
 * The URL to actually LOAD (browser, oEmbed) — carries the private hash when
 * there is one, because an unlisted video 404s without it. Deliberately separate
 * from {@link canonicalVimeoUrl}: one addresses the page, the other identifies
 * the video.
 */
export function vimeoWatchUrl(ref: VimeoVideoRef): string {
  return ref.hash ? `https://vimeo.com/${ref.id}/${ref.hash}` : canonicalVimeoUrl(ref.id);
}
