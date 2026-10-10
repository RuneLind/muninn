/// <reference lib="dom" />
/**
 * The reader's lens switch (D1–D3, D5): Overview, All, and Agent where the
 * server offers it. A lens is one class on `.wiki-article`; CSS hides by block
 * class, so the served HTML is the same in every lens and Ask, Explain,
 * fact-check, find and the peek cards see the whole page.
 *
 * - **Overview hides** line-ref groups, `<Historic>`, prose-level fenced code,
 *   each `<Query>` card's body, result table and SQL (the card shows its id,
 *   question and answer), CaseBoard rows with status `none` (the board states
 *   how many), and every fold marked `for="dev"`/`for="agent"` or titled with
 *   an agent-context name (D22).
 * - **Choice.** A click on Overview or All is stored per viewer
 *   (`muninn.wiki.lens.v1`); Agent never is. `?lens=` applies to the view it
 *   opens and is then removed from the URL by the caller.
 * - **Reveal.** A `REVEAL_EVENT` from an element Overview hides switches this
 *   view to All without storing it, so the next page opens in the stored lens.
 * - **Compact lists (D6, D41, D42, D45).** Every lens shows a `<DecisionLog>`
 *   newest first with five decisions and «Vis alle», each item's first sentence
 *   with «mer» for the rest, and a `<CaseBoard>` row as its compact line with
 *   «mer» and the `ok` group behind «+ N til». The lenses differ only in what
 *   they hide. A reveal of anything the compact view folds away (a `#d7` hash,
 *   an id link, a pill) opens it in the lens on screen.
 *
 * Also here, because both read the rendered folds: each fold summary's size and
 * reading time; and the selection text Explain and fact-check send, without
 * the text the reader adds to the page.
 */

import { REVEAL_EVENT } from "./wiki-hash-target.ts";
import { CODE_REF_GROUP_CLASS } from "../../../wiki/code-refs.ts";
import {
  CB_EXPANDED_CLASS,
  CB_LINE_CLASS,
  CB_MORE_CLASS,
  CB_OKMORE_CLASS,
  COMPACT_WORDS,
  DL_ALL_CLASS,
  DL_COMPACT_SHOWN,
  DL_DECISION_CLASS,
  DL_EXPANDED_CLASS,
  DL_ORDER_ATTR,
  DL_MORE_CLASS,
  DL_QSTATE_CLASS,
  DL_TAIL_CLASS,
  DL_WHEN_CLASS,
  LENS_CLASS_PREFIX,
  LENSES,
  LENS_LABELS,
  MORE_WORDS,
  READER_ONLY_ATTR,
  readStoredLens,
  writeStoredLens,
  type Lens,
} from "../../../format/reader-lens.ts";
import type { QuestionLanguage } from "../../../format/question-labels.ts";
import { fmtTokens } from "../../../utils/fmt-tokens.ts";
import { localStore } from "./wiki-local-store.ts";
import { LINE_REFS_TOGGLE_CLASS } from "./wiki-report-blocks.ts";
import { PEEK_CLASS } from "./wiki-ref-links.ts";

export const LENS_SWITCH_CLASS = "wiki-lens-switch";
export { LENS_CLASS_PREFIX };
export const FOLD_SIZE_CLASS = "fold-size";
export const CASEBOARD_LENS_NOTE_CLASS = "cb-lens-note";

/** What Overview hides, as selectors an element or one of its ancestors
 *  matches. One list for the CSS and for {@link isHiddenByOverview}. */
export const OVERVIEW_HIDDEN: readonly string[] = [
  `.${CODE_REF_GROUP_CLASS}`,
  "section.historic",
  // A fence written in the prose, not one inside another block. A mermaid
  // fence the diagram renderer has not replaced stays.
  ":is(.wiki-article, .fold-body) > :is(pre:not(:has(> code.language-mermaid)), .fence)",
  "section.query > :not(.query-head)",
  "section.query .query-meta",
  '.cb-group[data-status="none"]',
  "details.fold.fold-for-dev",
  "details.fold.fold-for-agent",
  "details.fold.fold-agent-context",
];

const HIDDEN_SELECTOR = OVERVIEW_HIDDEN.join(", ");

/** Whether Overview hides `el`, an article element: it or an ancestor matches
 *  a hidden block. (A peek card shows its target whole in every lens through
 *  the CSS, D3.) */
export function isHiddenByOverview(el: Element): boolean {
  return el.closest(HIDDEN_SELECTOR) !== null;
}

type Lang = QuestionLanguage;

const NOTE_WORDS: Record<Lang, { chars: string; min: string }> = {
  en: { chars: "chars", min: "min" },
  no: { chars: "tegn", min: "min" },
};

const SWITCH_TITLE: Record<Lang, string> = {
  en: "Overview hides the working detail: line refs, history, queries' SQL and tables, cases with status none («ikke kandidat»), and developer and handoff folds",
  no: "Oversikt skjuler arbeidsdetaljene: linjereferanser, historikk, spørringenes SQL og tabeller, saker med status none («ikke kandidat»), og utvikler- og overleveringsfold",
};

/** A nominal reading rate for the fold size line, not a measured one. */
const READING_CHARS_PER_MIN = 1200;

/** `12 345` chars as `12.3k` (`12,3k` in Norwegian); under a thousand, the number. */
export function formatChars(n: number, lang: Lang = "en"): string {
  const s = fmtTokens(n);
  return lang === "no" ? s.replace(".", ",") : s;
}

/** Minutes at {@link READING_CHARS_PER_MIN}; `<1` under half a minute. */
export function readingMinutes(chars: number): string {
  const m = Math.round(chars / READING_CHARS_PER_MIN);
  return m < 1 ? "<1" : String(m);
}

/** A fold's size line, e.g. `5.9k chars · 5 min`. */
export function foldSizeLabel(chars: number, lang: Lang): string {
  const w = NOTE_WORDS[lang];
  return `${formatChars(chars, lang)} ${w.chars} · ${readingMinutes(chars)} ${w.min}`;
}

/** Each fold summary gets its body's size and reading time, measured on the
 *  rendered text with white space collapsed and without the text the reader
 *  adds (an id's noun, a date cell, a compact line). Idempotent. */
export function decorateFoldSizes(article: Element, lang: Lang): void {
  article.querySelectorAll(`.${FOLD_SIZE_CLASS}`).forEach((el) => el.remove());
  article.querySelectorAll<HTMLDetailsElement>("details.fold").forEach((fold) => {
    const summary = fold.querySelector(":scope > summary");
    const body = fold.querySelector(":scope > .fold-body");
    if (!summary || !body) return;
    const page = body.cloneNode(true) as Element;
    page.querySelectorAll(`[${READER_ONLY_ATTR}]`).forEach((el) => el.remove());
    const chars = (page.textContent ?? "").replace(/\s+/g, " ").trim().length;
    if (chars === 0) return;
    const span = document.createElement("span");
    span.className = FOLD_SIZE_CLASS;
    span.setAttribute(READER_ONLY_ATTR, "");
    span.textContent = foldSizeLabel(chars, lang);
    summary.append(span);
  });
}

/** What every lens folds away in an id-led DecisionLog item (D6, D45): the
 *  rest of its text and whatever is nested under it. */
const DL_REST = `:scope > .dl-text > .dl-rest, :scope > .dl-text ~ :not(.${DL_WHEN_CLASS})`;

/** A fact-check mark or chip: what the compact view never folds away (K). */
const FC_MARK = ".fc-mark, .fc-chip";

function setExpanded(item: Element, open: boolean, lang: Lang): void {
  item.classList.toggle(DL_EXPANDED_CLASS, open);
  const b = item.querySelector<HTMLButtonElement>(`:scope > .dl-text > .${DL_MORE_CLASS}`);
  if (!b) return;
  b.textContent = open ? MORE_WORDS[lang].less : MORE_WORDS[lang].more;
  b.setAttribute("aria-expanded", open ? "true" : "false");
}

/** A «mer» toggle in each id-led DecisionLog item that holds more than its
 *  first sentence, right after the first sentence, named for its item and
 *  pointing at what it opens. Shown in every lens (D45); reader-only, so a
 *  selection leaves it out. An item whose hidden part holds a fact-check mark
 *  starts open, so a ❌ is never folded away (K). A closed question gets a
 *  «lukket» badge after its first sentence (J). Idempotent. */
export function decorateDecisionRests(article: Element, lang: Lang): void {
  article.querySelectorAll(`.${DL_MORE_CLASS}, .${DL_QSTATE_CLASS}`).forEach((el) => el.remove());
  article.querySelectorAll(".dl-item[id]").forEach((item) => {
    const text = item.querySelector(":scope > .dl-text");
    if (!text) return;
    const first = text.querySelector(":scope > .dl-first");
    const id = item.querySelector(":scope > .dl-id")?.textContent?.trim() ?? item.id;
    const state = item.getAttribute("data-q-state");
    let badge: HTMLElement | null = null;
    if (state && state !== "open" && !/^D/i.test(id)) {
      badge = document.createElement("span");
      badge.className = DL_QSTATE_CLASS;
      badge.setAttribute(READER_ONLY_ATTR, "");
      badge.textContent = MORE_WORDS[lang].closed;
      if (first) first.after(badge);
      else text.append(badge);
    }
    const rests = Array.from(item.querySelectorAll(DL_REST));
    if (rests.length === 0) return;
    rests.forEach((el, k) => {
      if (!el.id) el.id = `${item.id}-rest${k ? `-${k + 1}` : ""}`;
    });
    const b = document.createElement("button");
    b.type = "button";
    b.className = DL_MORE_CLASS;
    b.setAttribute(READER_ONLY_ATTR, "");
    b.setAttribute("aria-label", MORE_WORDS[lang].about(id));
    b.setAttribute("aria-controls", rests.map((el) => el.id).join(" "));
    b.addEventListener("click", () => setExpanded(item, !item.classList.contains(DL_EXPANDED_CLASS), lang));
    const before = badge ?? first;
    if (before) before.after(b);
    else text.append(b);
    if (rests.some((el) => el.querySelector(FC_MARK))) item.classList.add(DL_EXPANDED_CLASS);
    setExpanded(item, item.classList.contains(DL_EXPANDED_CLASS), lang);
  });
}

/** Under each CaseBoard with `none` rows, the line Overview shows in their
 *  place, naming the status by the board's own label (the group's
 *  `data-label`). Idempotent. */
function noteHiddenCases(article: Element, lang: Lang): void {
  article.querySelectorAll(`.${CASEBOARD_LENS_NOTE_CLASS}`).forEach((el) => el.remove());
  article.querySelectorAll("section.caseboard").forEach((board) => {
    const group = board.querySelector('.cb-group[data-status="none"]');
    const n = group?.querySelectorAll(".cb-row").length ?? 0;
    if (n === 0) return;
    const p = document.createElement("p");
    p.className = CASEBOARD_LENS_NOTE_CLASS;
    p.textContent = COMPACT_WORDS[lang].hidden(n, group!.getAttribute("data-label") || "none");
    board.append(p);
  });
}

/** On a section, a list, or an `ok` group: everything is shown. */
const SHOW_ALL_CLASS = "lens-show-all";
/** On a decision past the newest {@link DL_COMPACT_SHOWN}. */
const DL_OLDER_CLASS = "dl-older";
/** On an `ok` row past the group's first, which «+ N til» shows. */
const CB_FOLDED_CLASS = "cb-folded";

function readerButton(cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.setAttribute(READER_ONLY_ATTR, "");
  return b;
}

/** Ids for `els` (made from `base` where an element has none), for a
 *  toggle's `aria-controls`. */
function controlIds(els: Element[], base: string): string {
  return els
    .map((el, k) => {
      if (!el.id && base) el.id = `${base}-${k + 1}`;
      return el.id;
    })
    .filter(Boolean)
    .join(" ");
}

function setAllShown(section: Element, open: boolean, lang: Lang): void {
  section.classList.toggle(SHOW_ALL_CLASS, open);
  const b = section.querySelector<HTMLButtonElement>(`:scope > .${DL_ALL_CLASS}`);
  if (!b) return;
  const n = section.querySelectorAll(`.dl-item.${DL_DECISION_CLASS}`).length;
  b.textContent = open ? COMPACT_WORDS[lang].showNewest(DL_COMPACT_SHOWN) : COMPACT_WORDS[lang].showAll(n);
  b.setAttribute("aria-expanded", open ? "true" : "false");
}

/** A list's items in authored order, whatever order the DOM holds now. */
function authoredItems(list: Element): Element[] {
  return Array.from(list.children).sort(
    (x, y) => Number(x.getAttribute(DL_ORDER_ATTR)) - Number(y.getAttribute(DL_ORDER_ATTR)),
  );
}

/**
 * D41/D45: in each DecisionLog, which decisions (`dl-decision`, marked by the
 * renderer) every lens folds away: all but the newest five, except one holding
 * a fact-check mark (K: a ❌ is never folded away). Each item keeps its
 * authored position in `data-dl-order` for {@link orderDecisions}, and a log
 * with folded decisions gets «Vis alle» after its last list. Idempotent.
 */
export function decorateDecisionOrder(article: Element, lang: Lang): void {
  article.querySelectorAll(`.${DL_ALL_CLASS}`).forEach((el) => el.remove());
  article.querySelectorAll("section.decision-log").forEach((section) => {
    const lists = Array.from(section.querySelectorAll(":scope > .dl-list"));
    for (const list of lists) {
      Array.from(list.children).forEach((li, k) => {
        if (!li.hasAttribute(DL_ORDER_ATTR)) li.setAttribute(DL_ORDER_ATTR, String(k));
      });
    }
    const items = lists.flatMap((list) => authoredItems(list).filter((li) => li.classList.contains(DL_DECISION_CLASS)));
    const older = items.filter((item, k) => {
      const fold = items.length - 1 - k >= DL_COMPACT_SHOWN && !item.querySelector(FC_MARK);
      item.classList.toggle(DL_OLDER_CLASS, fold);
      return fold;
    });
    if (older.length === 0) return;
    const b = readerButton(DL_ALL_CLASS);
    b.setAttribute("aria-controls", controlIds(older, ""));
    b.addEventListener("click", () => setAllShown(section, !section.classList.contains(SHOW_ALL_CLASS), lang));
    lists[lists.length - 1]!.after(b);
    setAllShown(section, section.classList.contains(SHOW_ALL_CLASS), lang);
  });
}

/** The newest-first order of a list whose items are decisions where
 *  `isDecision` says so: the decisions' slots get the decisions reversed, and
 *  every other item keeps its slot. Returns authored indexes in display order. */
export function newestFirstOrder(isDecision: readonly boolean[]): number[] {
  const slots = isDecision.flatMap((d, k) => (d ? [k] : []));
  const want = isDecision.map((_, k) => k);
  slots.forEach((k, j) => (want[k] = slots[slots.length - 1 - j]!));
  return want;
}

/**
 * D41/D45: a DecisionLog reads newest first in every lens. The decision items
 * are moved in the DOM — within each list, into the slots decisions hold, so a
 * question or an item without an id keeps its place — so a selection, Tab and
 * a screen reader follow the order on screen. The order is computed from the
 * authored positions (`data-dl-order`), so running it again moves nothing. A
 * log in a peek card is left alone: the peek shows its target as written.
 */
function orderDecisions(article: Element): void {
  article.querySelectorAll(`section.decision-log > .dl-list:not(.${PEEK_CLASS} *)`).forEach((list) => {
    const authored = authoredItems(list);
    const want = newestFirstOrder(authored.map((li) => li.classList.contains(DL_DECISION_CLASS))).map((k) => authored[k]!);
    const now = Array.from(list.children);
    if (want.every((li, k) => now[k] === li)) return;
    for (const li of want) list.append(li);
  });
}

function setCaseExpanded(row: Element, open: boolean, lang: Lang): void {
  row.classList.toggle(CB_EXPANDED_CLASS, open);
  const b = row.querySelector<HTMLButtonElement>(`.${CB_MORE_CLASS}`);
  if (!b) return;
  b.textContent = open ? MORE_WORDS[lang].less : MORE_WORDS[lang].more;
  b.setAttribute("aria-expanded", open ? "true" : "false");
}

function setOkShown(group: Element, open: boolean, lang: Lang): void {
  group.classList.toggle(SHOW_ALL_CLASS, open);
  const b = group.querySelector<HTMLButtonElement>(`:scope > .${CB_OKMORE_CLASS}`);
  if (!b) return;
  const n = group.querySelectorAll(`:scope > .cb-row.${CB_FOLDED_CLASS}`).length;
  b.textContent = open ? COMPACT_WORDS[lang].okFewer : COMPACT_WORDS[lang].okMore(n);
  b.setAttribute("aria-expanded", open ? "true" : "false");
}

/**
 * D42/D45: each CaseBoard row's compact line gets a «mer» that shows the full
 * note and the refs, and an `ok` group of more than one row a «+ N til»
 * after its last row. Shown in every lens. As for a decision (K), a row whose
 * note holds a fact-check mark starts open, and the `ok` group never folds
 * away a row holding one. Idempotent.
 */
export function decorateCaseRows(article: Element, lang: Lang): void {
  article.querySelectorAll(`.${CB_MORE_CLASS}, .${CB_OKMORE_CLASS}`).forEach((el) => el.remove());
  article.querySelectorAll(".cb-row").forEach((row) => {
    const line = row.querySelector(`:scope > .${CB_LINE_CLASS}`);
    const rest = Array.from(row.querySelectorAll(":scope > :is(.cb-owner, .cb-note, .cb-refs)"));
    if (!line || rest.length === 0) return;
    const id = row.querySelector(":scope > .cb-id")?.textContent?.trim() ?? row.id;
    const b = readerButton(CB_MORE_CLASS);
    b.setAttribute("aria-label", MORE_WORDS[lang].about(id));
    b.setAttribute("aria-controls", controlIds(rest, row.id ? `${row.id}-more` : ""));
    b.addEventListener("click", () => setCaseExpanded(row, !row.classList.contains(CB_EXPANDED_CLASS), lang));
    line.append(b);
    if (rest.some((el) => el.querySelector(FC_MARK))) row.classList.add(CB_EXPANDED_CLASS);
    setCaseExpanded(row, row.classList.contains(CB_EXPANDED_CLASS), lang);
  });
  article.querySelectorAll('.cb-group[data-status="ok"]').forEach((group) => {
    const rows = Array.from(group.querySelectorAll(":scope > .cb-row"));
    const folded = rows.filter((row, k) => {
      const fold = k > 0 && !row.querySelector(FC_MARK);
      row.classList.toggle(CB_FOLDED_CLASS, fold);
      return fold;
    });
    if (folded.length === 0) return;
    const b = readerButton(CB_OKMORE_CLASS);
    b.setAttribute("aria-controls", controlIds(folded, ""));
    b.addEventListener("click", () => setOkShown(group, !group.classList.contains(SHOW_ALL_CLASS), lang));
    rows[rows.length - 1]!.after(b);
    setOkShown(group, group.classList.contains(SHOW_ALL_CLASS), lang);
  });
}

/** Whether Overview shows a DecisionLog or CaseBoard: it is not inside a
 *  block Overview hides, and a board has a group other than `none`. */
function shownInOverview(block: Element): boolean {
  if (isHiddenByOverview(block)) return false;
  return !block.matches("section.caseboard") || !!block.querySelector('.cb-group:not([data-status="none"])');
}

/** The `<Fold>`s entering Overview opens (D41): each one holding a
 *  DecisionLog or a CaseBoard that Overview shows. */
function compactFolds(article: Element): HTMLDetailsElement[] {
  return Array.from(article.querySelectorAll<HTMLDetailsElement>("details.fold")).filter((f) => {
    if (isHiddenByOverview(f)) return false;
    const blocks = Array.from(f.querySelectorAll(":scope > .fold-body :is(section.decision-log, section.caseboard)"));
    return blocks.some(shownInOverview);
  });
}

/** Entering Overview opens the {@link compactFolds}. Nothing is stored, and
 *  leaving Overview leaves the folds as they are: a reader who picks All from
 *  an open fold is reading it. */
function openCompactFolds(article: Element): void {
  for (const f of compactFolds(article)) f.open = true;
}

export interface LensOptions {
  language: Lang;
  /** The lens D2's precedence picked for this view. */
  initial: Lens;
  /** The view replaces the same page in place (a fact-check append): its
   *  lens is kept, and it is not an entry into Overview, so no fold opens. */
  inPlace?: boolean;
  /** The server's flag: the Agent button renders only when true. */
  agentAvailable: boolean;
}

/** The lens `article` shows, read off its class; null before `enhanceLens`. */
export function lensOf(article: Element | null): Lens | null {
  return LENSES.find((l) => article?.classList.contains(`${LENS_CLASS_PREFIX}${l}`)) ?? null;
}

/** Show `lens`. `enter` says whether a switch INTO Overview opens the
 *  compact folds (D41): not for a view replaced in place. */
function applyLens(article: HTMLElement, row: HTMLElement | null, sw: HTMLElement | null, lens: Lens, enter = true): void {
  const before = lensOf(article);
  for (const l of LENSES) {
    article.classList.toggle(`${LENS_CLASS_PREFIX}${l}`, l === lens);
  }
  if (lens === "overview" && before !== "overview" && enter) openCompactFolds(article);
  sw?.querySelectorAll<HTMLButtonElement>("button[data-lens]").forEach((b) => {
    const on = b.dataset.lens === lens;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  // Overview hides every line ref, so the «line refs» toggle has nothing to do.
  row?.querySelectorAll<HTMLElement>(`.${LINE_REFS_TOGGLE_CLASS}`).forEach((t) => {
    t.hidden = lens === "overview";
  });
}

/**
 * Put the switch in the article head and apply `opts.initial`. The switch is
 * shown when the lenses differ on this page: it has something Overview hides
 * (a `none` case row among them), a closed fold Overview opens, or the Agent
 * lens is offered. The compact lists alone do not count: every lens shows
 * them the same (D45). The class is applied either way. Idempotent per
 * render: the article element is new on every page, so its reveal listener
 * goes with it.
 */
export function enhanceLens(wrap: ParentNode, opts: LensOptions): void {
  const article = wrap.querySelector<HTMLElement>(".wiki-article");
  const row = wrap.querySelector<HTMLElement>(".wiki-article-head .wiki-meta-row");
  if (!article) return;
  row?.querySelectorAll(`.${LENS_SWITCH_CLASS}`).forEach((el) => el.remove());
  noteHiddenCases(article, opts.language);
  decorateFoldSizes(article, opts.language);
  decorateDecisionRests(article, opts.language);
  decorateDecisionOrder(article, opts.language);
  decorateCaseRows(article, opts.language);
  orderDecisions(article);

  let sw: HTMLElement | null = null;
  // Read before `applyLens` opens any fold: a fold the author left open is
  // the same in both lenses.
  const opensFold = compactFolds(article).some((f) => !f.open);
  if (row && (article.querySelector(HIDDEN_SELECTOR) || opensFold || opts.agentAvailable)) {
    sw = document.createElement("div");
    sw.className = LENS_SWITCH_CLASS;
    sw.setAttribute("role", "group");
    sw.setAttribute("aria-label", opts.language === "no" ? "Visning" : "Lens");
    sw.title = SWITCH_TITLE[opts.language];
    const labels = LENS_LABELS[opts.language];
    for (const lens of LENSES) {
      if (lens === "agent" && !opts.agentAvailable) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.lens = lens;
      b.textContent = labels[lens];
      b.addEventListener("click", () => {
        writeStoredLens(localStore(), lens);
        applyLens(article, row, sw, lens);
      });
      sw.append(b);
    }
    row.append(sw);
  }
  // `opts.initial` comes from `resolveLens`, which already turns an Agent the
  // server does not offer into All.
  applyLens(article, row, sw, opts.initial, !opts.inPlace);

  // D3: a reveal opens what the compact view folds away, in whichever lens is
  // on screen (D45), and a reveal of something Overview hides shows All for
  // this view only.
  article.addEventListener(REVEAL_EVENT, (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    // D6: a DecisionLog item, or anything in its rest, shows the whole item.
    const item = target.closest(".dl-item[id]");
    if (item?.querySelector(`:scope > .dl-text > .${DL_MORE_CLASS}`)) setExpanded(item, true, opts.language);
    // D41/D42: an older decision shows its whole log; a case row opens its
    // «mer», and a folded `ok` row shows its group.
    const section = target.closest(`.${DL_OLDER_CLASS}`)?.closest("section.decision-log");
    if (section) setAllShown(section, true, opts.language);
    const caseRow = target.closest(".cb-row");
    if (caseRow?.querySelector(`:scope > .${CB_LINE_CLASS} > .${CB_MORE_CLASS}`)) setCaseExpanded(caseRow, true, opts.language);
    const okGroup = target.closest('.cb-group[data-status="ok"]');
    if (okGroup && caseRow?.classList.contains(CB_FOLDED_CLASS)) setOkShown(okGroup, true, opts.language);
    if (isHiddenByOverview(target)) applyLens(article, row, sw, "all");
  });
}

/** The stored lens, for the caller's precedence. */
export function storedLens(): string | null {
  return readStoredLens(localStore());
}

/** On the root for one `toString()`: takes the reader's additions out of layout. */
const READER_ONLY_OFF_CLASS = "reader-only-off";

/**
 * The selection's text without the reader's own additions ({@link
 * READER_ONLY_ATTR}): what Explain and fact-check locate in the page source.
 * The marked nodes are taken out of layout for the one synchronous
 * `toString()`, which serializes the rendered text, then put back; nothing
 * paints in between. A selection that touches a DecisionLog item is read off
 * a copy of the article as written ({@link authoredSelectionText}).
 */
export function readerSelectionText(sel: Selection): string {
  const root = document.documentElement;
  root.classList.add(READER_ONLY_OFF_CLASS);
  try {
    return authoredSelectionText(sel) ?? sel.toString();
  } finally {
    root.classList.remove(READER_ONLY_OFF_CLASS);
  }
}

/** The child-index path from `root` down to `node`. */
function nodePath(root: Node, node: Node): number[] {
  const path: number[] = [];
  for (let n = node; n !== root; n = n.parentNode!) path.unshift(Array.prototype.indexOf.call(n.parentNode!.childNodes, n));
  return path;
}

function nodeAt(root: Node, path: readonly number[]): Node {
  return path.reduce<Node>((n, k) => n.childNodes[k]!, root);
}

/** Whether `range` holds any text of `item`, not only a boundary at its edge. */
function rangeHoldsText(range: Range, item: Element): boolean {
  if (!range.intersectsNode(item)) return false;
  const r = document.createRange();
  r.selectNodeContents(item);
  if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
  return r.toString().trim() !== "";
}

/**
 * A selection that holds text of a DecisionLog item, read in the page's
 * authored order: the reader shows decisions newest first (D41) and folds a
 * decision's rest and date tail away (D6, D45), so `toString()` of the
 * selection on screen is text the page source does not hold. On a copy of the
 * article, outside the lens (so nothing is folded, capped or reordered by
 * CSS), each list it touches is put back in authored order (`data-dl-order`),
 * a boundary that no longer sits in the first (or last) item it touches there
 * moves to that item's start (or end), and that copy is selected for one
 * `toString()`; the real selection is
 * then restored, direction included. Null when the selection touches no
 * DecisionLog item, so every other selection reads exactly as before.
 */
function authoredSelectionText(sel: Selection): string | null {
  if (sel.rangeCount !== 1) return null;
  const range = sel.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const article = (common instanceof Element ? common : common.parentElement)?.closest<HTMLElement>(".wiki-article");
  if (!article) return null;
  const items = Array.from(
    article.querySelectorAll(`section.decision-log > .dl-list:not(.${PEEK_CLASS} *) > li[${DL_ORDER_ATTR}]`),
  ).filter((li) => rangeHoldsText(range, li));
  if (items.length === 0) return null;

  const copy = article.cloneNode(true) as HTMLElement;
  const start = nodeAt(copy, nodePath(article, range.startContainer));
  const end = nodeAt(copy, nodePath(article, range.endContainer));
  const touched = items.map((li) => nodeAt(copy, nodePath(article, li)) as Element);
  // Reorder first, then set the range: moving a node collapses a live
  // range's boundary inside it.
  let from: Element | null = null;
  let to: Element | null = null;
  for (const list of new Set(touched.map((li) => li.parentElement!))) {
    for (const li of authoredItems(list)) list.append(li);
    // A boundary keeps its offset when it already sits in the item the
    // authored passage starts (or ends) with; otherwise that item is taken
    // whole, so the passage is one stretch of the source.
    const ordered = authoredItems(list).filter((li) => touched.includes(li));
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    if (list.contains(start) && !first.contains(start)) from = first;
    if (list.contains(end) && !last.contains(end)) to = last;
  }
  const r = document.createRange();
  if (from) r.setStartBefore(from);
  else r.setStart(start, range.startOffset);
  if (to) r.setEndAfter(to);
  else r.setEnd(end, range.endOffset);
  // Outside the lens: no compact rule applies, so a rest, a tail and an older
  // decision render as written. The date cell and the toggles are reader-only.
  for (const l of LENSES) copy.classList.remove(`${LENS_CLASS_PREFIX}${l}`);
  const host = document.createElement("div");
  host.style.cssText = `position: fixed; left: -100000px; top: 0; width: ${article.clientWidth || 800}px; pointer-events: none;`;
  host.append(copy);
  document.body.append(host);
  const anchor = [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset] as const;
  try {
    sel.removeAllRanges();
    sel.addRange(r);
    return sel.toString();
  } finally {
    sel.removeAllRanges();
    if (anchor[0] && anchor[2]) sel.setBaseAndExtent(anchor[0], anchor[1], anchor[2], anchor[3]);
    else sel.addRange(range);
    host.remove();
  }
}

/** The reader's CSS for the switch, the hidden blocks and the fold sizes. A
 *  peek card sits inside the article and shows its target whole in any lens. */
export function lensCss(): string {
  return `
    .wiki-article.${LENS_CLASS_PREFIX}overview :is(${HIDDEN_SELECTOR}):not(.${PEEK_CLASS} *) { display: none !important; }
    .${READER_ONLY_OFF_CLASS} [${READER_ONLY_ATTR}] { display: none !important; }
    ${LENSED} .dl-item:not(.${DL_EXPANDED_CLASS}) > .dl-text > .dl-rest:not(.${PEEK_CLASS} *),
    ${LENSED} .dl-item:not(.${DL_EXPANDED_CLASS}) > .dl-text ~ :not(.${DL_WHEN_CLASS}):not(.${PEEK_CLASS} *) { display: none; }
    /* The reader's toggles: «mer», «Vis alle», a case's «mer», «+ N til». */
    .wiki-article :is(${TOGGLES}) {
      font: inherit; font-size: 0.85em; padding: 0 0.2em; border: none; background: none;
      color: var(--accent-light); cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
      user-select: none;
    }
    .wiki-article :is(.${DL_MORE_CLASS}, .${CB_MORE_CLASS}) { margin-left: 0.4em; }
    .wiki-article .${DL_QSTATE_CLASS} {
      font-size: 0.8em; margin-left: 0.4em; padding: 0 0.45em; border-radius: 999px; white-space: nowrap;
      border: 1px solid var(--border-secondary); background: var(--tint-neutral); color: var(--text-soft); user-select: none;
    }
    .wiki-article:not(.${LENS_CLASS_PREFIX}overview) .${CASEBOARD_LENS_NOTE_CLASS} { display: none; }
${compactCss()}
    .wiki-article .${CASEBOARD_LENS_NOTE_CLASS} { margin: 6px 0 0; font-size: 12px; color: var(--text-soft); }
    .${LENS_SWITCH_CLASS} {
      display: inline-flex; margin-left: auto; border: 1px solid var(--border-secondary);
      border-radius: 999px; overflow: hidden; font-size: 11px;
    }
    .${LENS_SWITCH_CLASS} button {
      font: inherit; padding: 1px 10px; border: none; cursor: pointer;
      background: var(--bg-surface); color: var(--text-secondary);
    }
    .${LENS_SWITCH_CLASS} button + button { border-left: 1px solid var(--border-secondary); }
    .${LENS_SWITCH_CLASS} button:hover, .${LENS_SWITCH_CLASS} button:focus-visible { color: var(--text-primary); }
    .${LENS_SWITCH_CLASS} button.on { background: var(--accent); color: #fff; font-weight: 600; }
    .wiki-article details.fold > summary .${FOLD_SIZE_CLASS} {
      margin-left: 8px; font-size: 11px; font-weight: 400; color: var(--text-soft); white-space: nowrap;
    }
  `;
}

/** The reader's toggles, one selector for their shared style. */
const TOGGLES = `.${DL_MORE_CLASS}, .${DL_ALL_CLASS}, .${CB_MORE_CLASS}, .${CB_OKMORE_CLASS}`;

/** An article the lens has set up, in any lens: the compact view (D45) is
 *  scoped to it, so an article the lens never touched renders as written. */
const LENSED = `.wiki-article:is(${LENSES.map((l) => `.${LENS_CLASS_PREFIX}${l}`).join(", ")})`;

/** D41/D42/D45: the compact DecisionLog and CaseBoard rows, in every lens.
 *  Kept out of a peek card, which shows its target as written; the date cell
 *  and the compact line are hidden by default in the shared component CSS
 *  (`compactPartsHiddenCss`), so a surface without the lens (the gardener
 *  preview, chat) renders the blocks as written. A row's parts follow the DOM
 *  order, which is the reading order. */
function compactCss(): string {
  const art = LENSED;
  const notPeek = `:not(.${PEEK_CLASS} *)`;
  const dec = `${art} .dl-item.${DL_DECISION_CLASS}${notPeek}`;
  return `
    ${art} .decision-log${notPeek} { container: dl-log / inline-size; }
    ${art} .decision-log:not(.${SHOW_ALL_CLASS}) .dl-item.${DL_OLDER_CLASS}${notPeek} { display: none; }
    ${dec} {
      display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 0.5rem;
      padding: 0.45rem 0; border-bottom: 1px solid var(--border-secondary);
    }
    ${dec} > :is(.id-noun, .dl-id) { flex: none; }
    ${dec} > .dl-id { margin-right: 0.2rem; }
    ${dec} > .dl-text { flex: 1 1 0; min-width: 0; }
    ${dec} > .${DL_WHEN_CLASS} {
      display: block; flex: none; margin-left: auto; font-size: 0.8em; color: var(--text-soft);
      white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    ${dec} > .dl-text ~ :not(.${DL_WHEN_CLASS}) { flex-basis: 100%; }
    ${art} .${DL_DECISION_CLASS} .${DL_TAIL_CLASS}${notPeek} { display: none; }
    /* A narrow log: the date drops under the text, and at phone width the text
       under the chip too, so the text keeps the row (measured: the chip with its
       noun is ~117 px and the cell ~120 px at 14 px type). */
    @container dl-log (max-width: 28rem) {
      ${dec} > .${DL_WHEN_CLASS} { flex-basis: 100%; margin-left: 0; white-space: normal; }
    }
    @container dl-log (max-width: 18rem) {
      ${dec} > .dl-text { flex-basis: 100%; }
    }
    .wiki-article .${DL_ALL_CLASS} { display: block; margin: 0.3rem 0 0.8rem; }
    ${art} .caseboard .cb-row:has(> .${CB_LINE_CLASS}):not(.${CB_EXPANDED_CLASS}) > :is(.cb-owner, .cb-note, .cb-refs)${notPeek} { display: none; }
    ${art} .caseboard .cb-row > .${CB_LINE_CLASS}${notPeek} { display: inline; flex: 1 1 16rem; min-width: 0; }
    ${art} .caseboard .cb-row:has(> .${CB_LINE_CLASS}) > :is(.cb-owner, .cb-note)${notPeek} { flex-basis: 100%; }
    ${art} .caseboard .cb-head { color: var(--text-soft); }
    ${art} .cb-group[data-status="ok"]:not(.${SHOW_ALL_CLASS}) > .cb-row.${CB_FOLDED_CLASS}${notPeek} { display: none; }
    .wiki-article .${CB_OKMORE_CLASS} { display: block; margin: 0.1rem 0 0.3rem; }
  `;
}
