/**
 * Connections' *Moved with* section (D10, stale check PR 1): the pages
 * committed together with the open page in non-sweep commits over 28 days,
 * as `/api/wiki/page` answers them (`stale.ts`'s `movedWith`). Pure and
 * DOM-free so a test can load it (`wiki-browser.ts` touches `document` at
 * import time).
 */
import { escHtml as esc } from "./escape.ts";
import type { WikiListing } from "./wiki-filter.ts";

/** A row of the page payload's `movedWith`: a listing plus its commit count. */
export type MovedWithListing = WikiListing & { movedN: number };

export const MOVED_WITH_HINT = "Committed together with this page in the last 28 days (sweeps of 10+ files left out)";

/** The section, or "" when there is nothing to show (no git, an older server,
 *  or no shared commit). Each row carries `data-relpath`, so the pane's
 *  delegated click opens it like any Connections row. */
export function movedWithSectionHtml(items: readonly MovedWithListing[] | undefined, titleOf: (p: WikiListing) => string): string {
  if (!items?.length) return "";
  let html = `<div class="wiki-conn-section wiki-moved-with"><div class="wiki-conn-title" title="${esc(MOVED_WITH_HINT)}">Moved with (${items.length})</div>`;
  for (const p of items) {
    const n = p.movedN;
    html +=
      `<div class="wiki-conn-item" data-page="${esc(p.name)}" data-relpath="${esc(p.relPath)}">` +
      `<div class="wiki-type-dot type-${esc(p.type)}"></div><span class="wiki-conn-name">${esc(titleOf(p))}</span>` +
      `<span class="wiki-moved-n" title="${n} shared commit${n === 1 ? "" : "s"}">×${n}</span></div>`;
  }
  return html + "</div>";
}
