/**
 * The host gate for a caller-supplied URL that a route hands to a fetcher
 * (yt-dlp for the TikTok and X-video captures).
 *
 * Parse ONCE and hand the returned `href` downstream, never the raw string. The
 * sink is Python and parses differently from WHATWG: `https://x.com\@127.0.0.1/p`
 * is x.com to `new URL` (backslash becomes `/`, so `@127.0.0.1` lands in the
 * path) and loopback to yt-dlp (backslash is an ordinary userinfo character, so
 * the host is `127.0.0.1`) — measured 2026-09-26. Judging the parsed URL and
 * sending the raw string would judge one URL and fetch another.
 *
 * The raw-form checks are belt and braces on top of that: a string WHATWG would
 * have to normalise is refused rather than normalised — a backslash, control or
 * whitespace character anywhere, surrounding whitespace, anything but a literal
 * `https://` prefix (so `http://`, `https:/` and `https:///` fail), and any
 * authority that is not byte-for-byte the parsed hostname (`%`-escapes,
 * userinfo, an explicit port even `:443`, a trailing dot, fullwidth forms).
 */
export function parseAllowedHttpsUrl(raw: string, hosts: ReadonlySet<string>): URL | null {
  if (raw !== raw.trim() || /[\\\x00-\x20\x7f]|\s/.test(raw)) return null;
  if (raw.slice(0, 8).toLowerCase() !== "https://") return null;
  const authority = raw.slice(8).split(/[/?#]/, 1)[0]!;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const ok =
    u.protocol === "https:" &&
    hosts.has(u.hostname) &&
    u.port === "" &&
    u.username === "" &&
    u.password === "" &&
    authority.toLowerCase() === u.hostname;
  return ok ? u : null;
}
