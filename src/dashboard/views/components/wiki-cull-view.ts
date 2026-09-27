/**
 * The culled (retired, `signal: none`) marker: ONE label every surface shows,
 * and the two reader markups built from it that live in `wiki-browser.ts`'s
 * bundle. Pure string building, so `bun test` loads it — `wiki-browser.ts`
 * touches `document` at import time.
 *
 * `CULL_LABEL` is the one hook a per-wiki label (`cullLabels`, next PR) replaces.
 */

import { escHtml as esc } from "./escape.ts";
import type { WikiListing } from "./wiki-filter.ts";

/** The marker's visible word — the plan's default wording. */
export const CULL_LABEL = "Retired";
/** Its hover. Neutral: a page is culled by `signal: none`, by an `.html` meta,
 *  or through its parent, so the hover names none of them. */
export const CULL_TITLE = "Retired page";

/** The marker as its own element. */
export function cullMarkHtml(): string {
  return `<em class="wiki-cull-mark" title="${esc(CULL_TITLE)}">${esc(CULL_LABEL)}</em>`;
}

/**
 * One Connections row (Linked from / Links to). The title span clips with an
 * ellipsis, so the marker is its SIBLING — a non-shrinking flex item — rather
 * than text inside it, where a long title clipped it away.
 */
export function connItemHtml(p: WikiListing, title: string): string {
  return (
    `<div class="wiki-conn-item" data-page="${esc(p.name)}" data-relpath="${esc(p.relPath)}">` +
    `<div class="wiki-type-dot type-${esc(p.type)}"></div><span class="wiki-conn-name">${esc(title)}</span>` +
    (p.culled ? cullMarkHtml() : "") +
    `</div>`
  );
}

/** One page node of the Connections mini-graph. A culled neighbour is muted
 *  (`.culled`) and its tooltip carries the label. */
export function miniNodeHtml(
  p: WikiListing,
  at: { x: number; y: number; labelY: number; label: string; title: string },
): string {
  const x = at.x.toFixed(1);
  const y = at.y.toFixed(1);
  return (
    `<g class="mini-node${p.culled ? " culled" : ""}" data-page="${esc(p.name)}" data-relpath="${esc(p.relPath)}">` +
    `<title>${esc(p.culled ? `${at.title} — ${CULL_LABEL}` : at.title)}</title>` +
    `<circle class="mini-hit" cx="${x}" cy="${y}" r="14" fill="transparent"></circle>` +
    `<circle class="mini-dot t-${esc(p.type)}" cx="${x}" cy="${y}" r="5"></circle>` +
    `<text x="${x}" y="${at.labelY.toFixed(1)}" text-anchor="middle">${esc(at.label)}</text></g>`
  );
}
