/**
 * Shared footer-link parsing for x-feed docs.
 *
 * An x-feed doc carries TWO distinct footer lines that must NOT be confused
 * (huginn `x_fetcher.py`):
 *   - `**Link:**  <url>`  (SINGULAR) — on EVERY tweet, the tweet's OWN x.com
 *     permalink. Never a destination; ignored here.
 *   - `**Links:** <url> <url> …` (PLURAL) — only when the tweet carries external
 *     destinations, the t.co-expanded URLs space-joined on ONE line.
 * So the "has an external link" predicate parses ONLY the plural `**Links:**`
 * line and token-splits it on whitespace, then filters out x.com/twitter.com/t.co
 * hosts so only true external destinations remain.
 *
 * This lives in `src/summaries/` (not `src/anthropic/`) because BOTH the X watcher
 * (`src/watchers/x.ts`, link-tweet eligibility) and the anthropic summarizer's X
 * enrichment path (`src/anthropic/link-enrichment.ts`, re-exported) parse it — a
 * single definition so the two can't drift on the load-bearing singular/plural
 * distinction.
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
