/**
 * The zone inventory: every same-origin URL the COMPOSED chat page references,
 * derived from the rendered page rather than remembered.
 *
 * The user zone is an allowlist, so the failure mode it introduces is a page
 * that silently stops working: someone adds a fetch to the chat client, role
 * `user` gets a 403 on a route nobody thought about, and the symptom is a panel
 * that no longer fills. `claimed-id-inventory.ts` is the precedent — this is
 * the same discipline pointed at the other direction, and it is why the check
 * runs over `renderChatPage()`'s output (bundles included) instead of a grep.
 *
 * ⚠️ **A `fetch(` grep is too narrow, deliberately.** It misses
 * `<link rel="icon" href="/favicon.svg">`, an `EventSource`, a
 * `new WebSocket`, and every call site that builds its URL out of a variable.
 * So the extractor takes EVERY quoted literal on the page (plus unquoted
 * `href=`/`src=` attribute values) and keeps the ones shaped like a path. The
 * cost is that it also yields path FRAGMENTS — `'/chat/threads/' + id +
 * '/auto-respond'` yields both halves — and those are dispositioned as such
 * rather than filtered away, because a filter is where a real route would hide.
 */
import { renderChatPage } from "../chat/views/page.ts";

/** What a row may say about itself. A row with anything else, or none, fails. */
export const ZONE_DISPOSITIONS = [
  /** In `OPEN_ZONE_PATHS`: no role required. */
  "open",
  /** In `USER_ZONE_PATHS`: role `user` may call it. */
  "user-zone",
  /** Denied to role `user` — by the deny list or by default-deny. */
  "admin-zone",
  /** A path SUFFIX produced by string concatenation, not a URL of its own. */
  "fragment",
  /** Matched the path shape but is not a URL (a lone `/`, a regex flag that
   *  survived, a protocol-relative stub). */
  "not-a-url",
] as const;
export type ZoneDisposition = (typeof ZONE_DISPOSITIONS)[number];

export interface ZoneInventoryRow {
  readonly url: string;
  readonly disposition: ZoneDisposition;
  /**
   * The concrete path the zone assertion is made against. Absent means "the url
   * itself". A prefix row needs one — `/chat/bot-preferences/` is in the user
   * zone by prefix, while the route that actually lives there,
   * `/chat/bot-preferences/<bot>/default-user`, is on the deny list, and a row
   * that could not name the second would claim the wrong thing.
   */
  readonly probe?: string;
}

/**
 * Path-shaped literals in the page: an opening quote, a run of path characters,
 * and a TERMINATOR that says the run really ended there.
 *
 * The terminator is the load-bearing half. "A quote followed by a slash" alone
 * reports `/g` as a URL, because `.replace(/"/g, "&quot;")` puts a `"`
 * immediately before a regex flag — measured, twice, on this very page. A real
 * path literal ends at the matching quote, at a `$` (a template interpolation:
 * `` `/api/jira/draft/${id}/save` `` contributes the prefix, which is what a
 * zone entry is written against anyway), or at a `?`/`#`. `/g,` ends at a
 * comma, so it is not one.
 *
 * Pairing whole literals across the document was tried first and is WORSE: one
 * apostrophe in one comment shifts every pairing after it, and the extractor
 * silently reported 4 URLs instead of 60.
 */
export function extractSameOriginUrls(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/(['"`])(\/[A-Za-z0-9_\-./]*)([^\n]|$)/g)) {
    const [, quote, path, next] = m;
    if (next === quote || next === "$" || next === "?" || next === "#" || next === "") found.add(path!);
  }
  // Unquoted attribute values, which carry no quote to terminate on.
  for (const m of html.matchAll(/(?:href|src|action)=(\/[A-Za-z0-9_\-./]*)/g)) found.add(m[1]!);
  return [...found].sort();
}

/** Every path-shaped literal the composed chat page carries. */
export async function chatPageUrls(): Promise<string[]> {
  return extractSameOriginUrls(await renderChatPage());
}

/** `<url> | <disposition>[ | <probe>]`, one per line, `#` comments ignored. */
export function parseZoneInventory(text: string): ZoneInventoryRow[] {
  const rows: ZoneInventoryRow[] = [];
  for (const line of text.split("\n")) {
    const body = line.split("#")[0]!.trim();
    if (body === "") continue;
    const parts = body.split("|").map((p) => p.trim());
    rows.push({
      url: parts[0]!,
      disposition: parts[1] as ZoneDisposition,
      probe: parts[2] === "" ? undefined : parts[2],
    });
  }
  return rows;
}
