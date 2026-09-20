/**
 * The Connections panel's `Related work` block — pure string building, so
 * `bun test` can load it.
 *
 * It lived in `wiki-browser.ts`, which touches `document` at import time and is
 * therefore unloadable outside a browser: anything shaped there is provable only
 * through Playwright, and the guard below is exactly the shape a spec cannot
 * reach (a block that renders NOTHING has no element to assert on).
 *
 * The RULE is server-side (`src/wiki/related.ts`) and answers which pages and
 * why; this module renders what it is handed and decides nothing.
 */

import { escHtml as esc } from "./escape.ts";
import { displayTitleOf, type WikiListing } from "./wiki-filter.ts";

/** One `Related work` row: an ordinary listing row plus the one line saying why
 *  it is there (`cites this page · shares RuneLind/muninn#550, …`). */
export interface RelatedListing extends WikiListing {
  why: string;
}

/**
 * The `Related work` block, or `""` when the page has no neighbours — an empty
 * block would be a row saying nothing, in a panel whose other sections already
 * render `None` for the mechanism they name. The server's `related[]` is `[]`
 * there, and on an older server the key is absent; both land here as no block.
 *
 * Rows are the panel's own `.wiki-conn-item` (so the delegated `[data-page]`
 * handler opens them, with no second click path) plus a second line carrying the
 * why. The reasons are split on ` · ` and wrapped in `<em>` — the separator is
 * punctuation and the reasons are the text, which is the distinction the CSS
 * paints. No `⋯ add to series` control: the series editor is a later PR, and a
 * visible control that cannot act is the dead control F2 rejected.
 */
export function relatedSectionHtml(items: RelatedListing[]): string {
  if (!items.length) return "";
  let html =
    `<div class="wiki-conn-section"><div class="wiki-conn-title">Related work (${items.length})</div>`;
  items.forEach((p) => {
    const why = p.why
      .split(" · ")
      .map((r) => `<em>${esc(r)}</em>`)
      .join(" · ");
    html +=
      `<div class="wiki-conn-item wiki-conn-related" data-page="${esc(p.name)}" data-relpath="${esc(p.relPath)}">` +
      `<div class="wiki-type-dot type-${esc(p.type)}"></div>` +
      `<div class="wiki-conn-text"><span>${esc(displayTitleOf(p))}</span>` +
      `<div class="wiki-conn-why" title="${esc(p.why)}">${why}</div></div>` +
      `</div>`;
  });
  return html + "</div>";
}
