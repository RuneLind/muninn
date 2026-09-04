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

/**
 * A video id has no leading zero. `/0123` and `/123` are the same video to
 * Vimeo but two different `canonicalVimeoUrl` keys, and Vimeo never writes the
 * first — so a padded id is a malformed URL, not a second video.
 */
const VIDEO_ID_RE = /^[1-9]\d*$/;
/** The same rule inside a path match — composed, so there is ONE id rule. */
const VIDEO_ID_PATTERN = "[1-9]\\d*";
/** `/<id>` or `/<id>/<trailing segment>` — the watch host. */
const WATCH_PATH_RE = new RegExp(`^/(${VIDEO_ID_PATTERN})(?:/([^/]+))?/?$`);
/** `/video/<id>` or `/video/<id>/<trailing segment>` — the embed host. */
const PLAYER_PATH_RE = new RegExp(`^/video/(${VIDEO_ID_PATTERN})(?:/([^/]+))?/?$`);
const CHANNEL_PATH_RE = new RegExp(`^/channels/[^/]+/(${VIDEO_ID_PATTERN})/?$`);

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
 *   - `vimeo.com/<id>`                        (public)
 *   - `vimeo.com/<id>/<hash>`                 (unlisted — the hash is KEPT)
 *   - `player.vimeo.com/video/<id>[/<hash>]`  (embed)
 *   - `vimeo.com/channels/<channel>/<id>`     (channel page)
 * plus `?h=<hash>` on any of them, which is how the embed carries the same
 * private hash. A trailing PATH segment must look like a hash (see
 * {@link HASH_RE}); `?h=` is taken verbatim, whatever it looks like. `www.` is
 * tolerated. Returns null for every other host and for any Vimeo path that does
 * not name a video id — including a leading-zero one.
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

  // Both hosts spell the unlisted hash the same way — `/<id>/<hash>` — so they
  // take the same rule. `player.vimeo.com/video/<id>/<hash>` refusing outright
  // while the watch host degraded to the bare id was an accident of two regexes.
  const shape = path.match(kind === "player" ? PLAYER_PATH_RE : WATCH_PATH_RE);
  if (shape) {
    id = shape[1]!;
    const seg = shape[2];
    // A trailing PATH segment is a hash only if it LOOKS like one; `/likes` and
    // the other sub-pages fall through to "no hash", not to "not a Vimeo URL".
    if (seg && HASH_RE.test(seg)) hash = seg.toLowerCase();
  } else if (kind === "watch") {
    const channel = path.match(CHANNEL_PATH_RE);
    if (channel) id = channel[1]!;
  }
  if (!id) return null;

  // `?h=` needs NO shape rule and gets none. The hex test exists to tell a hash
  // segment from `/likes`; a query parameter is unambiguous, so a value that
  // does not look hex is still the credential the page needs — dropping it
  // turned a reachable unlisted video into a 404 a caller records as "not
  // public". Kept VERBATIM for the same reason: it is a credential, and
  // case-folding one is a guess.
  const q = parsed.searchParams.get("h");
  if (!hash && q) hash = q;

  return hash ? { id, hash } : { id };
}

/**
 * The one door for "a bare numeric id OR any URL shape" — what every caller
 * that takes user input actually wants. It existed three times (oEmbed's
 * `resolveWatchUrl`, `scripts/smoke-vimeo.ts`, and the shape rule itself), and
 * three copies of "is this a video id?" drift.
 */
export function resolveVimeoRef(idOrUrl: string): VimeoVideoRef | null {
  const trimmed = idOrUrl.trim();
  if (VIDEO_ID_RE.test(trimmed)) return { id: trimmed };
  return extractVimeoVideoId(trimmed);
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
  // The hash is ENCODED as one path segment. `?h=` is accepted verbatim because
  // it is a credential rather than a shape, and this URL is then loaded in a
  // browser — un-encoded, `?h=../../settings` addressed a different vimeo.com
  // page. A real (hex) hash is unchanged by this.
  return ref.hash
    ? `https://vimeo.com/${ref.id}/${encodeURIComponent(ref.hash)}`
    : canonicalVimeoUrl(ref.id);
}
