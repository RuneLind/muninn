/**
 * The culled (retired, `signal: none`) page in the reader: its per-wiki labels,
 * the markups built from them, and the rail's hide rule. Pure string building,
 * so `bun test` loads it — `wiki-browser.ts` touches `document` at import time.
 *
 * The labels are per wiki (`.wiki-reader.json` `cullLabels`, parsed by
 * {@link parseCullLabels} on the server and shipped RESOLVED on the listing).
 * A bundle serves one wiki, so the client sets them once per listing through
 * {@link setCullLabels} and every marker site reads {@link cullLabels}.
 */

import { escHtml as esc } from "./escape.ts";
import type { WikiListing } from "./wiki-filter.ts";

/** What a wiki may rename. Every field is always present once resolved. */
export interface CullLabels {
  /** The rail toggle. `{n}` is replaced with the count of hidden pages. */
  toggle: string;
  /** The banner's prefix — the banner reads `<banner>: <reason>`. */
  banner: string;
  /** The short marker on Connections rows, graph hints and cards, the board,
   *  and a culled rail row's hover. */
  marker: string;
  /** The banner's successor lead-in — `<successor> <link>`. */
  successor: string;
}

export const CULL_COUNT_PLACEHOLDER = "{n}";

export const DEFAULT_CULL_LABELS: Readonly<CullLabels> = Object.freeze({
  toggle: `Show retired (${CULL_COUNT_PLACEHOLDER})`,
  banner: "Retired",
  marker: "Retired",
  successor: "Superseded by",
});

/** The rail toggle's key in the folds store — a `toggle:` MODE key, so the
 *  store exempts it from the fold cap exactly as it does `toggle:families`. */
export const RETIRED_TOGGLE_KEY = "toggle:retired";

/** The banner's successor link carries its target relPath here; the reader's
 *  body delegate opens it in place (a modified click keeps the href). */
export const CULL_GO_ATTR = "data-cull-go";

export interface CullLabelWarning {
  key: string;
  reason: string;
}

/**
 * Merge a wiki's `cullLabels` block over the defaults — the validate-warn-degrade
 * shape of `.wiki-reader.json`'s other keys, per field: a wrong-typed or blank
 * field warns and drops ITSELF, the rest of the block stands. A `toggle` without
 * the `{n}` placeholder is dropped too, since the count is the toggle's promise.
 */
export function parseCullLabels(raw: unknown): { labels: CullLabels; warnings: CullLabelWarning[] } {
  const labels: CullLabels = { ...DEFAULT_CULL_LABELS };
  const warnings: CullLabelWarning[] = [];
  if (raw === undefined || raw === null) return { labels, warnings };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push({ key: "cullLabels", reason: "is not an object — ignoring it" });
    return { labels, warnings };
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_CULL_LABELS) as (keyof CullLabels)[];
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || !v.trim()) {
      warnings.push({ key: `cullLabels.${key}`, reason: "is not a non-empty string — ignoring it" });
      continue;
    }
    if (key === "toggle" && !v.includes(CULL_COUNT_PLACEHOLDER)) {
      warnings.push({ key: "cullLabels.toggle", reason: `has no ${CULL_COUNT_PLACEHOLDER} count placeholder — ignoring it` });
      continue;
    }
    labels[key] = v.trim();
  }
  for (const key of Object.keys(obj)) {
    if (!(keys as string[]).includes(key)) warnings.push({ key: `cullLabels.${key}`, reason: "is not a known label — ignoring it" });
  }
  return { labels, warnings };
}

let active: CullLabels = { ...DEFAULT_CULL_LABELS };

/** Adopt a wiki's resolved labels. Anything malformed falls back per field, so
 *  a payload from an older server (no `cullLabels`) leaves the defaults. */
export function setCullLabels(raw: unknown): void {
  active = parseCullLabels(raw).labels;
}

/** The labels in force for this bundle's wiki. */
export function cullLabels(): CullLabels {
  return active;
}

/** The toggle's text for `n` hidden pages. */
export function cullToggleText(n: number, labels: CullLabels = active): string {
  return labels.toggle.split(CULL_COUNT_PLACEHOLDER).join(String(n));
}

/**
 * The rail's pool: every page when retired pages are shown or a search is typed
 * (search still reaches a retired page), else the live pages only. Facets,
 * families, `#wikiCount` and the attachment chips all count from this pool, so
 * a hidden page is in none of them; the series census does not (it reads the
 * whole listing — see `groupSeries`).
 */
export function railPool<T extends Pick<WikiListing, "culled">>(pages: T[], showRetired: boolean, q: string): T[] {
  if (showRetired || q.trim()) return pages;
  return pages.filter((p) => !p.culled);
}

/** The reveal control carries this; the reader's delegate turns the toggle on. */
export const RETIRED_REVEAL_ATTR = "data-retired-reveal";

/**
 * A one-click "show them" control for an empty surface that is empty only
 * because retired pages are held back: the rail's empty state, the Hubs tab.
 * Worded with the toggle's own text, so it speaks the wiki's language and
 * names the same N. `""` when nothing is held back.
 */
export function retiredRevealHtml(n: number): string {
  if (n <= 0) return "";
  return `<button type="button" class="wiki-retired-reveal" ${RETIRED_REVEAL_ATTR}>${esc(cullToggleText(n))}</button>`;
}

/** The marker as its own element. */
export function cullMarkHtml(): string {
  const { marker } = active;
  return `<em class="wiki-cull-mark" title="${esc(marker)}">${esc(marker)}</em>`;
}

/**
 * The open page's banner: `<banner>: <reason>` and, when the page names a
 * resolvable successor, a link to it. `successor` is the successor's relPath and
 * display title (the caller looks the title up in its listing); `href` is its
 * reader URL.
 */
export function cullBannerHtml(
  m: Pick<WikiListing, "culled" | "cullReason">,
  successor?: { relPath: string; title: string; href: string },
): string {
  if (!m.culled) return "";
  const { banner, successor: lead } = active;
  const reason = m.cullReason ? `: ${esc(m.cullReason)}` : "";
  const next = successor
    ? `<span class="wiki-cull-next">${esc(lead)} <a class="wiki-cull-successor" href="${esc(successor.href)}" ${CULL_GO_ATTR}="${esc(successor.relPath)}">${esc(successor.title)}</a></span>`
    : "";
  return `<div class="wiki-cull-banner" role="note"><strong class="wiki-cull-banner-label">${esc(banner)}</strong><span class="wiki-cull-reason">${reason}</span>${next}</div>`;
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
    `<title>${esc(p.culled ? `${at.title} — ${active.marker}` : at.title)}</title>` +
    `<circle class="mini-hit" cx="${x}" cy="${y}" r="14" fill="transparent"></circle>` +
    `<circle class="mini-dot t-${esc(p.type)}" cx="${x}" cy="${y}" r="5"></circle>` +
    `<text x="${x}" y="${at.labelY.toFixed(1)}" text-anchor="middle">${esc(at.label)}</text></g>`
  );
}
