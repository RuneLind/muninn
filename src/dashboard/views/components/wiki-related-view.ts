/**
 * The Connections panel's `Related work` block — pure string building, so
 * `bun test` can load it.
 *
 * It lived in `wiki-browser.ts`, which touches `document` at import time and is
 * therefore unloadable outside a browser: anything shaped there is provable only
 * through Playwright, and the guard below is exactly the shape a spec cannot
 * reach (a block that renders NOTHING has no element to assert on).
 *
 * The RULE is server-side (`src/wiki/related.ts`) and answers which pages, why
 * and how strongly; this module renders what it is handed and decides nothing
 * but the `Newest` re-sort, which orders on the age the row itself shows.
 */

import { escHtml as esc } from "./escape.ts";
import {
  displayTitleOf,
  pageDateSignal,
  pageWorkedMs,
  workedChip,
  workedSourceOf,
  type WikiListing,
} from "./wiki-filter.ts";
import { formatRailAge } from "./wiki-activity-rank.ts";
import { canEditSeriesPage, seriesMenuBtnHtml } from "./wiki-series-menu.ts";
import {
  REASON_SESSION_PREFIX,
  RELATED_SHARED_PRS_SHOWN,
  STRENGTH_MAX,
  strengthParts,
} from "../../../wiki/related-constants.ts";

/** Which signals tie a row to the open page — `RelatedSignals` in
 *  `src/wiki/related.ts`, restated here because this module ships in the
 *  browser bundle and must not import the server rule. */
export interface RelatedRowSignals {
  link: "out" | "in" | "both" | null;
  prs: string[];
  sessions: string[];
}

/** One `Related work` row: an ordinary listing row plus the one line saying why
 *  it is there (`cites this page · shares RuneLind/muninn#550, …`), its strength
 *  and its signals. The last two are optional: an older server sends neither. */
export interface RelatedListing extends WikiListing {
  why: string;
  strength?: number;
  signals?: RelatedRowSignals;
}

/** The block's two orders. `strongest` is the server's; `newest` re-sorts on
 *  the worked-on axis the row's age shows. */
export type RelatedOrder = "strongest" | "newest";

/** Parse a stored order; anything else is the default. */
export function parseRelatedOrder(raw: string | null | undefined): RelatedOrder {
  return raw === "newest" ? "newest" : "strongest";
}

/** Data attributes the browser's click delegate keys on. */
export const RELATED_ORDER_ATTR = "data-rel-order";
export const RELATED_HOP_ATTR = "data-rel-hop";
export const RELATED_HOP_BODY_ATTR = "data-rel-hop-for";

export interface RelatedViewOptions {
  /** The wiki's worked-on ledger covers pages (`workedAxisOn`): the age chip
   *  then marks where its date came from, as the rail's does. */
  workedAxis?: boolean;
  /** ONE server-anchored instant for the whole block (`recencyNow()`). */
  now?: number;
  order?: RelatedOrder;
  /** Render the ▸ second-hop opener on each row. */
  hops?: boolean;
  /** A series key → its display label (the rail's `seriesLabels`). Absent ⇒ the
   *  row's own `seriesLabel`, else the key. */
  seriesLabelOf?: (p: WikiListing) => string;
}

/**
 * One reason, escaped and wrapped in `<em>`. A `shares session …` reason wraps
 * each ref in a `<span class="wiki-why-sess">` so CSS can shorten a session
 * ref (a bare uuid is 36 characters, `claude-code:<uuid>` 48) on screen while
 * the text stays whole for copying. The refs come from `signals.sessions` when
 * the row carries them, and are parsed back out of the reason text only for an
 * older server that sends none.
 */
function reasonHtml(reason: string, sessions: string[] | undefined): string {
  if (!reason.startsWith(REASON_SESSION_PREFIX)) return `<em>${esc(reason)}</em>`;
  const refs = (sessions ? sessions.slice(0, RELATED_SHARED_PRS_SHOWN) : reason.slice(REASON_SESSION_PREFIX.length).split(", "))
    .map((ref) => `<span class="wiki-why-sess" title="${esc(ref)}">${esc(ref)}</span>`);
  return `<em>${esc(REASON_SESSION_PREFIX)}${refs.join(", ")}</em>`;
}

/** A width on the fixed `STRENGTH_MAX` scale, so bars compare across pages. */
function pct(v: number): string {
  return `${Math.round((v / STRENGTH_MAX) * 1000) / 10}%`;
}

/**
 * The strength bar: one segment per signal (link, PRs, sessions), each as wide
 * as what that signal adds to the score (`strengthParts`, the weights
 * `strengthOf` sums), on the fixed scale of `STRENGTH_MAX`. A signal that does
 * not count draws no segment — a digest page's shared PRs included. `""` for a
 * row with no signals (an older server).
 */
export function strengthBarHtml(p: RelatedListing): string {
  if (!p.signals || typeof p.strength !== "number") return "";
  const parts = strengthParts(p.signals.link, p.signals.prs.length, p.signals.sessions.length);
  const segs: string[] = [];
  const label: string[] = [];
  if (parts.link > 0) {
    segs.push(`<i class="wiki-rel-seg seg-link" style="width:${pct(parts.link)}"></i>`);
    label.push(`link ${p.signals.link === "both" ? "both ways" : "one way"} ${parts.link.toFixed(1)}`);
  }
  if (parts.prs > 0) {
    segs.push(`<i class="wiki-rel-seg seg-pr" style="width:${pct(parts.prs)}"></i>`);
    label.push(`${p.signals.prs.length} shared PRs ${parts.prs.toFixed(1)}`);
  }
  if (parts.sessions > 0) {
    segs.push(`<i class="wiki-rel-seg seg-sess" style="width:${pct(parts.sessions)}"></i>`);
    label.push(`${p.signals.sessions.length} shared session${p.signals.sessions.length === 1 ? "" : "s"} ${parts.sessions.toFixed(1)}`);
  }
  const title = `${label.join(" + ")} = ${p.strength.toFixed(1)} of ${STRENGTH_MAX.toFixed(1)}`;
  return (
    `<span class="wiki-rel-bar" title="${esc(title)}">${segs.join("")}</span>` +
    `<span class="wiki-rel-score" title="${esc(title)}">${esc(p.strength.toFixed(1))}</span>`
  );
}

/**
 * The neighbour's age (a proxy: a link carries no timestamp, so the row says
 * how recently the OTHER page was worked on). The worked-on signal, falling back
 * to the update signal per page, rendered as the rail renders it
 * (`formatRailAge`) — and, only where the ledger covers the wiki, with the
 * rail's source marking (`workedSourceOf` + `workedChip`).
 */
export function relatedAgeHtml(p: WikiListing, now: number, workedAxis: boolean): string {
  const signal = pageDateSignal(p, "worked", now);
  if (!signal) return "";
  const source = workedAxis
    ? signal.kind === "worked"
      ? workedSourceOf(p, now, signal)
      : ({ kind: "fallback" } as const)
    : null;
  const chip = workedChip(source, signal.label, signal.kind === "added" ? "added" : "updated");
  return `<span class="wiki-rel-age${chip.cls}" title="${esc(chip.title)}">${esc(formatRailAge(signal.ms, now, signal.label))}</span>`;
}

/** The series pill, or `""` for a page in no series. */
function seriesPillHtml(p: WikiListing, labelOf?: (p: WikiListing) => string): string {
  if (!p.series) return "";
  const label = labelOf?.(p) || p.seriesLabel || p.series;
  return `<span class="wiki-rel-series" title="In the ${esc(label)} series">${esc(label)}</span>`;
}

/** The rows in the chosen order. `strongest` is the server's order, unchanged;
 *  `newest` sorts on `pageWorkedMs` at ONE instant — the date the age column
 *  shows, so the shown ages always read in order — strength breaking a tie. */
export function orderRelated(items: RelatedListing[], order: RelatedOrder, now: number): RelatedListing[] {
  if (order !== "newest") return items;
  return items
    .map((p, i) => ({ p, i, ms: pageWorkedMs(p, now) }))
    .sort((a, b) => b.ms - a.ms || (b.p.strength ?? 0) - (a.p.strength ?? 0) || a.i - b.i)
    .map(({ p }) => p);
}

/** The second line under a title: the bar, the score, the age, the series. */
function metaHtml(p: RelatedListing, opts: RelatedViewOptions, now: number): string {
  const inner = strengthBarHtml(p) + relatedAgeHtml(p, now, !!opts.workedAxis) + seriesPillHtml(p, opts.seriesLabelOf);
  return inner ? `<div class="wiki-rel-meta">${inner}</div>` : "";
}

function whyHtml(p: RelatedListing): string {
  const why = p.why.split(" · ").map((r) => reasonHtml(r, p.signals?.sessions)).join(" · ");
  return `<div class="wiki-conn-why" title="${esc(p.why)}">${why}</div>`;
}

/**
 * The `Related work` block, or `""` when the page has no neighbours — an empty
 * block would be a row saying nothing, in a panel whose other sections already
 * render `None` for the mechanism they name. The server's `related[]` is `[]`
 * there, and on an older server the key is absent; both land here as no block.
 *
 * Rows are the panel's own `.wiki-conn-item` (so the delegated `[data-page]`
 * handler opens them, with no second click path) plus a why line and a meta
 * line (strength bar, score, age, series). The reasons are split on ` · ` and
 * wrapped in `<em>` — the separator is punctuation and the reasons are the text,
 * which is the distinction the CSS paints.
 *
 * The header carries the `Strongest | Newest` toggle once there are two rows to
 * order. `hops` renders a ▸ on each row that opens THAT page's own related work
 * beneath it (`relatedHopHtml`) — an explicit second request, never a
 * transitive block.
 *
 * `editable` renders the series editor's `⋯` opener on each row — the second of
 * its three sites, and the one that answers the question this block raises ("so
 * are these one piece of work?"). It is a parameter rather than a flag read
 * here, because this module must stay pure: the caller owns the two read-only
 * flags. FALSE renders nothing at all rather than a dimmed control — a visible
 * control that cannot act is the dead control #557's F2 decision rejected, and
 * so is an opener on a row `canEditSeriesPage` says no series may claim (an
 * `.html` explainer or attachment — mimir carries 94 of them — or an
 * `index.md`), which is why it is tested PER ROW and not once for the block.
 */
export function relatedSectionHtml(
  items: RelatedListing[],
  editable = false,
  opts: RelatedViewOptions = {},
): string {
  if (!items.length) return "";
  const now = opts.now ?? Date.now();
  const order = opts.order ?? "strongest";
  const toggle =
    items.length > 1
      ? `<span class="wiki-rel-order" role="group" aria-label="Order related work">` +
        (["strongest", "newest"] as const)
          .map(
            (o) =>
              `<button type="button" ${RELATED_ORDER_ATTR}="${o}" aria-pressed="${o === order}">` +
              `${o === "strongest" ? "Strongest" : "Newest"}</button>`,
          )
          .join("") +
        `</span>`
      : "";
  let html =
    `<div class="wiki-conn-section wiki-related">` +
    `<div class="wiki-conn-title wiki-rel-head"><span class="wiki-rel-count">Related work (${items.length})</span>${toggle}</div>`;
  for (const p of orderRelated(items, order, now)) {
    html +=
      `<div class="wiki-conn-item wiki-conn-related" data-page="${esc(p.name)}" data-relpath="${esc(p.relPath)}">` +
      (opts.hops
        ? `<button type="button" class="wiki-rel-hop" ${RELATED_HOP_ATTR}="${esc(p.relPath)}" aria-expanded="false" ` +
          `aria-label="Show what ${esc(displayTitleOf(p))} is related to" title="Its related work">▸</button>`
        : "") +
      `<div class="wiki-type-dot type-${esc(p.type)}"></div>` +
      `<div class="wiki-conn-text"><span>${esc(displayTitleOf(p))}</span>` +
      whyHtml(p) +
      metaHtml(p, opts, now) +
      `</div>` +
      (editable && canEditSeriesPage(p.relPath) ? seriesMenuBtnHtml(p.relPath, !!p.series) : "") +
      `</div>`;
    if (opts.hops) html += `<div class="wiki-rel-hop-body" ${RELATED_HOP_BODY_ATTR}="${esc(p.relPath)}" hidden></div>`;
  }
  return html + "</div>";
}

/** `GET /api/wiki/related`'s answer. */
export interface RelatedHopResponse {
  related: RelatedListing[];
  total: number;
  error?: string;
}

/**
 * The second hop under a row: the rows `/api/wiki/related` answered for that
 * page, minus the open page and its attachments (the server's cut). Each row
 * opens its page through the same delegated handler; it carries no ▸ and no
 * `⋯`, so the walk stops here. The why line is in the HOP page's terms ("cites
 * this page" = cites the page the ▸ sits on), which the head line names.
 */
export function relatedHopHtml(
  via: string,
  body: RelatedHopResponse | null,
  opts: RelatedViewOptions = {},
): string {
  if (!body) return `<div class="wiki-rel-hop-note">Loading…</div>`;
  if (body.error) return `<div class="wiki-rel-hop-note">Related work unavailable.</div>`;
  const now = opts.now ?? Date.now();
  if (!body.related.length) return `<div class="wiki-rel-hop-note">Nothing else is related to ${esc(via)}.</div>`;
  const more = body.total > body.related.length ? ` · ${body.related.length} of ${body.total}` : "";
  let html = `<div class="wiki-rel-hop-head">Related to ${esc(via)}${esc(more)}</div>`;
  for (const p of body.related) {
    html +=
      `<div class="wiki-conn-item wiki-rel-hop-row" data-page="${esc(p.name)}" data-relpath="${esc(p.relPath)}">` +
      `<div class="wiki-type-dot type-${esc(p.type)}"></div>` +
      `<div class="wiki-conn-text"><span>${esc(displayTitleOf(p))}</span>` +
      whyHtml(p) +
      metaHtml(p, opts, now) +
      `</div></div>`;
  }
  return html;
}
