/**
 * The SERIES EDITOR's pure half — the model behind the `⋯` popover and the
 * markup it paints.
 *
 * Its own module for `wiki-related-view.ts`'s reason: `wiki-browser.ts` touches
 * `document` at import time, so anything shaped there is provable only through
 * Playwright. Everything here is a function of the page listing the rail already
 * holds, so the menu's contents, the head rule and the write PLAN are unit-
 * testable and the browser file keeps only the DOM.
 *
 * One popover serves three openers — a rail row, a `Related work` row and the
 * reader's series header — because they ask the same two questions ("which
 * series is this page in" and "which series does this wiki have") off the same
 * listing. The header opener differs only in offering the edit verbs, which need
 * a series to act on.
 *
 * Membership, the head and the label are {@link seriesMembersOf}'s, never
 * re-derived: a menu that disagreed with the fold about who is in a series would
 * offer to move a head the rail does not recognise.
 */

import { escHtml as esc } from "./escape.ts";
import { displayTitleOf, type WikiListing } from "./wiki-filter.ts";
import {
  seriesCensusKey,
  seriesDateMs,
  seriesHead,
  seriesKeyOf,
  seriesMembersByFoldKey,
  seriesMembersOf,
} from "./wiki-groups.ts";
import { normalizeRel } from "./wiki-nav.ts";

/**
 * How many existing series the menu offers before it stops listing them.
 *
 * Ordered by the series' own newest member, so the twelve offered are the twelve
 * most recently worked on — which is what a reader adding a page to a series is
 * reaching for. Past that the `New series…` field takes any key, including one
 * the list did not show, and {@link normalizeSeriesKey} folds it onto the
 * existing spelling, so nothing is unreachable — only unlisted.
 */
export const SERIES_MENU_MAX = 12;

/** One series the menu offers to join. */
export interface SeriesMenuOption {
  /** The key as it is written on disk (the head's spelling). */
  key: string;
  /** What the fold calls it — `series_label:` where a member carries one. */
  label: string;
  /** Members in the whole listing. */
  count: number;
  /** Is the page this menu was opened on already in it? */
  current: boolean;
}

/** One member row in the edit view. */
export interface SeriesMemberRow {
  relPath: string;
  title: string;
  /** Does this member carry the `series_label:` the fold reads? */
  head: boolean;
  /** Is it the page the menu was opened on? */
  open: boolean;
}

/** Everything the popover paints, for one target page. */
export interface SeriesMenuModel {
  /** The page every write in this menu targets. */
  relPath: string;
  /** Its title, for the popover's own heading. */
  title: string;
  /** Its series key as written on disk, `""` when it is in none. */
  current: string;
  /** The current series' label (the head's, else the key), `""` when in none. */
  label: string;
  /** relPath of the member carrying the label, `""` when there is none. */
  headRel: string;
  options: SeriesMenuOption[];
  /** The current series' members, newest first. Empty when the page is in none. */
  members: SeriesMemberRow[];
}

/**
 * Build the model for the page at `relPath` out of the whole listing.
 *
 * `undefined` when the listing has no such page — a rail row whose page was
 * deleted between the render and the click, which the caller reports rather than
 * painting an empty menu.
 */
export function buildSeriesMenu(
  all: readonly WikiListing[],
  relPath: string,
): SeriesMenuModel | undefined {
  const key = normalizeRel(relPath);
  const page = all.find((p) => normalizeRel(p.relPath) === key);
  if (!page) return undefined;

  const current = seriesKeyOf(page);
  const byFold = seriesMembersByFoldKey(all);
  const currentFold = seriesCensusKey(current);
  const ranked: Array<{ opt: SeriesMenuOption; newest: number }> = [];
  for (const [fold, members] of byFold) {
    const head = seriesHead(members);
    const optKey = head ? seriesKeyOf(head) : "";
    if (!optKey) continue;
    ranked.push({
      opt: {
        key: optKey,
        label: head!.seriesLabel || optKey,
        count: members.length,
        // Compared on the page's OWN key rather than on membership: a retired
        // page whose successor left the series carries the key and counts
        // nowhere, and offering it `join` would write the line it already has.
        current: !!currentFold && fold === currentFold,
      },
      newest: Math.max(0, ...members.map((m) => seriesDateMs(m))),
    });
  }
  ranked.sort((a, b) => b.newest - a.newest || a.opt.label.localeCompare(b.opt.label));
  const options = ranked.map((r) => r.opt);

  const { members, head } = current
    ? seriesMembersOf(all, current)
    : { members: [] as WikiListing[], head: undefined };
  // The RAW relPath, never `normalizeRel`'s lower-cased form: this is a WRITE
  // target that goes back over the wire as `relPath`.
  const headRel = head?.seriesLabel ? head.relPath : "";
  return {
    relPath: page.relPath,
    title: displayTitleOf(page),
    current,
    label: current ? head?.seriesLabel || seriesKeyOf(head ?? page) || current : "",
    headRel,
    // The current series is always offered, however old it is — it is the one
    // the edit verbs act on.
    options: capOptions(options),
    members: members.map((m) => ({
      relPath: m.relPath,
      title: displayTitleOf(m),
      head: !!m.seriesLabel,
      open: normalizeRel(m.relPath) === key,
    })),
  };
}

/** The first {@link SERIES_MENU_MAX}, with the page's own series kept whatever
 *  its position — a menu that dropped the series the edit verbs act on would
 *  offer `remove` beside no way back. */
function capOptions(options: SeriesMenuOption[]): SeriesMenuOption[] {
  const kept = options.slice(0, SERIES_MENU_MAX);
  const currentOpt = options.find((o) => o.current);
  if (currentOpt && !kept.includes(currentOpt)) kept[kept.length - 1] = currentOpt;
  return kept.map(({ key, label, count, current }) => ({ key, label, count, current }));
}

/** One page write the editor asks for — exactly the `POST /api/wiki/series`
 *  body, minus the `baseHash` the caller reads fresh per page. */
export interface SeriesWrite {
  relPath: string;
  series: string | null;
  /** Absent leaves the `series_label:` line alone. */
  seriesLabel?: string | null;
}

/**
 * Moving the label from one member to another, as the TWO writes it is.
 *
 * There is no two-page write: `writeWikiPage` is one file per call, and a
 * transaction across two would need a notion of rollback the wiki has none of.
 * So the old head is cleared FIRST and the new head set second — that order on
 * purpose. A failure between them leaves a series with no labelled member, which
 * renders under its bare key and which the lint's 8.3 reports; the other order
 * leaves TWO labelled members, where the rail silently picks the newer and the
 * reader is told nothing.
 *
 * The clear is omitted when the old head IS the new one, and when no member
 * carries a label at all.
 */
export function headMoveWrites(
  model: SeriesMenuModel,
  toRelPath: string,
  label: string,
): SeriesWrite[] {
  const writes: SeriesWrite[] = [];
  const to = normalizeRel(toRelPath);
  if (model.headRel && normalizeRel(model.headRel) !== to) {
    writes.push({ relPath: model.headRel, series: model.current, seriesLabel: null });
  }
  writes.push({ relPath: toRelPath, series: model.current, seriesLabel: label });
  return writes;
}

/** The popover's root id — one node, so only one menu can be open. */
export const SERIES_MENU_ID = "wikiSeriesMenu";
/** The attribute every opener carries, holding the target page's relPath. */
export const SERIES_MENU_ATTR = "data-series-menu";
/** The reader header's opener — a separate attribute so the edit verbs render
 *  only there, and so the read-only selector list can name the two apart. */
export const SERIES_EDIT_ATTR = "data-series-edit";

/** The `⋯` opener rendered on a rail row and on a `Related work` row. */
export function seriesMenuBtnHtml(relPath: string, inSeries: boolean): string {
  const label = inSeries ? "Edit this page's series" : "Add this page to a series";
  return (
    `<button type="button" class="wiki-series-menu-btn" ${SERIES_MENU_ATTR}="${esc(relPath)}"` +
    ` tabindex="-1" title="${esc(label)}" aria-label="${esc(label)}" aria-haspopup="menu">⋯</button>`
  );
}

/** The reader header's `edit series` opener. */
export function seriesEditBtnHtml(relPath: string): string {
  return (
    `<button type="button" class="wiki-series-edit" ${SERIES_EDIT_ATTR}="${esc(relPath)}"` +
    ` title="Edit this series" aria-haspopup="menu">edit series</button>`
  );
}

/**
 * The popover body.
 *
 * `edit` adds the header's two series-wide verbs — rename the label, move the
 * head — to the join list every opener shows. `Remove from series` renders in
 * both views when the page is in one, because that is the verb a reader reaches
 * for from either place.
 *
 * Both text fields are rendered INLINE rather than behind a "…" row that swaps
 * the body: a popover with a second state is a popover that can be left in it,
 * and the whole editor is four verbs.
 */
export function seriesMenuHtml(model: SeriesMenuModel, edit: boolean): string {
  const rows: string[] = [];
  rows.push(
    `<div class="wiki-series-menu-head" title="${esc(model.title)}">${esc(model.title)}</div>`,
  );

  if (edit && model.current) {
    rows.push(
      `<div class="wiki-series-menu-sec">Series · ${esc(model.label)}</div>`,
      formHtml("label", "Series label", model.label, "Rename"),
    );
    for (const m of model.members) {
      // The OPEN page is offered too, and is the common case: a reader on the
      // newest plan of a series is exactly who wants the label to name it.
      if (m.head) continue;
      rows.push(cmdRow("head", m.relPath, `Make head: ${m.title}`, m.open ? "this page" : ""));
    }
  }

  if (model.options.length) {
    rows.push(`<div class="wiki-series-menu-sec">Add to series</div>`);
    for (const o of model.options) {
      rows.push(
        cmdRow("join", o.key, o.label, `${o.count} page${o.count === 1 ? "" : "s"}`, o.current),
      );
    }
  }
  rows.push(formHtml("new", "New series key", "", "Add"));
  if (model.current) rows.push(cmdRow("remove", "", "Remove from series"));
  return rows.join("");
}

/** One inline text field + its verb. `kind` is what the submit handler switches
 *  on, and it is the only thing that distinguishes the two. */
function formHtml(kind: string, label: string, value: string, verb: string): string {
  return (
    `<form class="wiki-series-menu-form" data-series-form="${esc(kind)}">` +
    `<input type="text" class="wiki-series-menu-input" data-series-input="1"` +
    ` placeholder="${esc(label)}…" aria-label="${esc(label)}" maxlength="200"` +
    ` value="${esc(value)}">` +
    `<button type="submit" class="wiki-series-menu-go">${esc(verb)}</button>` +
    `</form>`
  );
}

/** One command row. `current` renders it inert — the page is already there, and
 *  a live control whose click writes the line it already has is a dead control
 *  wearing a verb. */
function cmdRow(
  cmd: string,
  arg: string,
  label: string,
  note = "",
  current = false,
): string {
  const noteHtml = note ? `<span class="wiki-series-menu-note">${esc(note)}</span>` : "";
  if (current) {
    return (
      `<div class="wiki-series-menu-row is-current" aria-disabled="true">` +
      `<span>${esc(label)}</span><span class="wiki-series-menu-note">in this series</span></div>`
    );
  }
  return (
    `<button type="button" class="wiki-series-menu-row" data-series-cmd="${esc(cmd)}"` +
    ` data-series-arg="${esc(arg)}"><span>${esc(label)}</span>${noteHtml}</button>`
  );
}
