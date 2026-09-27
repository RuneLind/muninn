/**
 * The TikTok capture route's URL handling: the host gate, the URL handed to
 * yt-dlp, and the short-link resolver. Its own module so the three are tested
 * without loading the route's dependency graph.
 */

import { parseAllowedHttpsUrl } from "./url-gate.ts";

/**
 * The hosts POST /api/tiktok/summarize may hand to yt-dlp. The URL is caller
 * chosen and yt-dlp fetches whatever it is given, so without this gate the
 * route fetched a loopback address on the caller's behalf (architecture review
 * 2026-09, finding 12). `www.` is what the extension's content script sends;
 * `m.` is the mobile share host a pasted link can carry.
 */
export const TIKTOK_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
]);

/** {@link parseAllowedHttpsUrl} over {@link TIKTOK_HOSTS}; callers hand `href` downstream. */
export function parseAllowedTikTokUrl(raw: string): URL | null {
  return parseAllowedHttpsUrl(raw, TIKTOK_HOSTS);
}

/** Boolean form of {@link parseAllowedTikTokUrl}. */
export function isAllowedTikTokUrl(raw: string): boolean {
  return parseAllowedTikTokUrl(raw) !== null;
}

/**
 * A short link: any path on vm./vt.tiktok.com, or `/t/<code>` on the other
 * hosts. The route resolves these itself (gated hop by hop) and never hands one
 * to yt-dlp, whose `vm.tiktok` extractor would re-follow the chain ungated.
 */
export function isShortLink(u: URL): boolean {
  if (u.hostname === "vm.tiktok.com" || u.hostname === "vt.tiktok.com") return true;
  return /^\/t\/\w+/.test(u.pathname);
}

/**
 * The URL yt-dlp is handed for a gated TikTok video URL — one its `TikTok`
 * extractor matches, so the vertical's allowlist is `tiktok` alone. That
 * extractor matches only `www.`; the bare and `m.` hosts used to reach it
 * through `[generic]`'s redirect, which this rewrite reproduces: same path and
 * query on `www.`. `/v/<id>.html` (the `m.` share shape) becomes the id-only
 * video path. A short link throws: resolve it with
 * {@link resolveTikTokShortLink} first.
 */
export function tiktokDownloadUrl(u: URL): string {
  if (isShortLink(u)) throw new Error(`short link must be resolved before download: ${u.href}`);
  const share = u.pathname.match(/^\/v\/(\d+)(?:\.html)?\/?$/);
  if (share) return `https://www.tiktok.com/@/video/${share[1]}`;
  if (u.hostname === "www.tiktok.com") return u.href;
  return `https://www.tiktok.com${u.pathname}${u.search}`;
}

/** Redirects a short link may take before the resolver gives up. */
export const SHORT_LINK_MAX_HOPS = 5;

/** The statuses that redirect; any other status (300 and 304 included) ends the chain. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type ShortLinkResolution =
  | { kind: "resolved"; url: string }
  /** A hop left TikTok, or the chain ran past {@link SHORT_LINK_MAX_HOPS}. */
  | { kind: "refused"; reason: string }
  /** Network error, timeout, or a redirect without a `Location`. */
  | { kind: "failed"; reason: string };

// A browser-like UA so the short-link HEAD isn't met with TikTok's anti-bot wall.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/**
 * Follow a short link's redirects one hop at a time, judging each `Location`
 * through the TikTok host gate BEFORE requesting it. `redirect: "follow"` would
 * request every hop first and let the caller judge only where it ended.
 */
export async function resolveTikTokShortLink(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<ShortLinkResolution> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      const res = await fetchImpl(current, {
        method: "HEAD",
        redirect: "manual",
        headers: { "User-Agent": BROWSER_UA },
        signal: controller.signal,
      });
      if (!REDIRECT_STATUSES.has(res.status)) return { kind: "resolved", url: current };
      const location = res.headers.get("location");
      if (!location) return { kind: "failed", reason: `HTTP ${res.status} without a Location` };
      if (hop >= SHORT_LINK_MAX_HOPS) {
        return { kind: "refused", reason: `more than ${SHORT_LINK_MAX_HOPS} redirects` };
      }
      let next: URL | null;
      try {
        next = parseAllowedTikTokUrl(new URL(location, current).href);
      } catch {
        next = null;
      }
      if (!next) return { kind: "refused", reason: `redirect off TikTok to ${location}` };
      current = next.href;
    }
  } catch (err) {
    return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}
