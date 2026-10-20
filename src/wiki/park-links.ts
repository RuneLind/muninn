import { lineCodeSpanRanges } from "../format/code-spans.ts";
import { WIKILINK_WITH_LABEL_RE } from "./decision-text.ts";

/**
 * `text` parked the way `renderWikiHtml` parks it: every `[[…]]` whole first,
 * as `link(i)`, then, when `span` is a string, each code span paired by the
 * exact-N rule over the parked text, as `span`. With `span` null, code spans
 * stay. Returns the parked text and the links it parked, in order.
 */
export function parkLinksThenCodeSpans(
  text: string,
  link: (i: number) => string,
  span: string | null,
): { text: string; links: string[] } {
  const links: string[] = [];
  const parked = text.replace(WIKILINK_WITH_LABEL_RE, (whole: string) => link(links.push(whole) - 1));
  if (span === null) return { text: parked, links };
  let out = "";
  let cursor = 0;
  for (const r of lineCodeSpanRanges(parked)) {
    out += parked.slice(cursor, r.start) + span;
    cursor = r.end;
  }
  return { text: out + parked.slice(cursor), links };
}
