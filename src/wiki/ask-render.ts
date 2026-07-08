/**
 * Renders a wiki Ask answer (research synthesis markdown) to reader HTML for the
 * /wiki reader's article pane.
 *
 * The Ask tab's answer is plain markdown with inline `[n]` citation markers. The
 * reader used to dump it as raw text in the narrow right column; instead we now
 * render it as a formatted article in the main pane. This reuses the web chat's
 * markdown pipeline (`formatWebHtml`, same as `renderWikiHtml`), then turns each
 * in-range `[n]` marker whose citation resolved to a wiki page into a clickable
 * `<sup data-page>` (the reader's global delegated click opens it in-place) —
 * mirroring the client's former `linkifyAskCites`. Markers that are out of range
 * or whose citation didn't match a page stay literal text.
 *
 * The `[n]` markers are swapped for `\x00`-sentinel tokens *before* rendering (so
 * the markdown pipeline's HTML-escaping can't mangle them) and restored after —
 * the same technique `renderWikiHtml` uses for wikilinks.
 */

import { formatWebHtml } from "../web/web-format.ts";
import { escapeHtml } from "../format/markdown-core.ts";
import type { Citation } from "../research/answer.ts";

const CITE_MARKER_RE = /\[(\d+)\]/g;

/**
 * Render one Ask answer's markdown to reader HTML, linkifying `[n]` markers to
 * their matched wiki pages. `citations` is the enriched list (index = `n - 1`);
 * only citations carrying a `pageName` become links.
 */
export function renderAskAnswerHtml(answer: string, citations: Citation[]): string {
  const maxN = citations.length;
  const tokens: string[] = [];
  const withTokens = (answer ?? "").replace(CITE_MARKER_RE, (whole, num: string) => {
    const n = parseInt(num, 10);
    const c = citations[n - 1];
    // Only linkify in-range markers whose citation matched a wiki page — mirrors
    // the client's old linkifyAskCites (unmatched/out-of-range stay literal so a
    // stray "[3]" in prose never becomes a dead link).
    if (n < 1 || n > maxN || !c || !c.pageName) return whole;
    const idx = tokens.length;
    tokens.push(
      `<sup class="wiki-ask-cite" data-page="${escapeHtml(c.pageName)}" title="${escapeHtml(c.title || "")}">[${n}]</sup>`,
    );
    return `\x00ASKCITE${idx}\x00`;
  });
  return formatWebHtml(withTokens).replace(
    /\x00ASKCITE(\d+)\x00/g,
    (_m, idx: string) => tokens[parseInt(idx, 10)] ?? "",
  );
}
