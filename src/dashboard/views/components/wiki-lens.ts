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
 * - **Decisions (D6).** Overview shows a `<DecisionLog>` item's first sentence
 *   and a «mer» toggle; the rest and anything nested under the item open
 *   behind it. A reveal of an item, or of anything in one (a `#d7` hash, an id
 *   link, a pill), opens that whole item and stays in Overview.
 *
 * Also here, because both read the rendered folds: each fold summary's size and
 * reading time; and the selection text Explain and fact-check send, without
 * the text the reader adds to the page.
 */

import { REVEAL_EVENT } from "./wiki-hash-target.ts";
import { CODE_REF_GROUP_CLASS } from "../../../wiki/code-refs.ts";
import {
  CB_MORE_CLASS,
  CB_OKMORE_CLASS,
  COMPACT_WORDS,
  DL_ALL_CLASS,
  DL_COMPACT_SHOWN,
  DL_EXPANDED_CLASS,
  DL_MORE_CLASS,
  DL_QSTATE_CLASS,
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
export const LENS_CLASS_PREFIX = "lens-";
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

const NOTE_WORDS: Record<Lang, { cases: (n: number) => string; chars: string; min: string }> = {
  en: { cases: (n) => `${n} ${n === 1 ? "case" : "cases"} with status none not shown`, chars: "chars", min: "min" },
  no: { cases: (n) => `${n} ${n === 1 ? "sak" : "saker"} med status none vises ikke`, chars: "tegn", min: "min" },
};

const SWITCH_TITLE: Record<Lang, string> = {
  en: "Overview hides the working detail: line refs, history, queries' SQL and tables, developer and handoff folds, and the rest of each decision after its first sentence",
  no: "Oversikt skjuler arbeidsdetaljene: linjereferanser, historikk, spørringenes SQL og tabeller, utvikler- og overleveringsfold, og resten av hver beslutning etter første setning",
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
 *  rendered text with white space collapsed. Idempotent. */
export function decorateFoldSizes(article: Element, lang: Lang): void {
  article.querySelectorAll(`.${FOLD_SIZE_CLASS}`).forEach((el) => el.remove());
  article.querySelectorAll<HTMLDetailsElement>("details.fold").forEach((fold) => {
    const summary = fold.querySelector(":scope > summary");
    const body = fold.querySelector(":scope > .fold-body");
    if (!summary || !body) return;
    const chars = (body.textContent ?? "").replace(/\s+/g, " ").trim().length;
    if (chars === 0) return;
    const span = document.createElement("span");
    span.className = FOLD_SIZE_CLASS;
    span.setAttribute(READER_ONLY_ATTR, "");
    span.textContent = foldSizeLabel(chars, lang);
    summary.append(span);
  });
}

/** What Overview folds away in an id-led DecisionLog item: the rest of its
 *  text and whatever is nested under it. */
const DL_REST = ":scope > .dl-text > .dl-rest, :scope > .dl-text ~ *";

function setExpanded(item: Element, open: boolean, lang: Lang): void {
  item.classList.toggle(DL_EXPANDED_CLASS, open);
  const b = item.querySelector<HTMLButtonElement>(`:scope > .dl-text > .${DL_MORE_CLASS}`);
  if (!b) return;
  b.textContent = open ? MORE_WORDS[lang].less : MORE_WORDS[lang].more;
  b.setAttribute("aria-expanded", open ? "true" : "false");
}

/** A «mer» toggle in each id-led DecisionLog item that holds more than its
 *  first sentence, right after the first sentence, named for its item and
 *  pointing at what it opens. Shown in Overview only; reader-only, so a
 *  selection leaves it out. An item whose hidden part holds a fact-check mark
 *  starts open, so a ❌ is never folded away (K). A closed question gets a
 *  «lukket» badge after its first sentence, also Overview only (J).
 *  Idempotent. */
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
    if (rests.some((el) => el.querySelector(".fc-mark, .fc-chip"))) item.classList.add(DL_EXPANDED_CLASS);
    setExpanded(item, item.classList.contains(DL_EXPANDED_CLASS), lang);
  });
}

/** Under each CaseBoard with `none` rows, the line Overview shows in their
 *  place, naming the status by the board's own label. Idempotent. */
function noteHiddenCases(article: Element, lang: Lang): void {
  article.querySelectorAll(`.${CASEBOARD_LENS_NOTE_CLASS}`).forEach((el) => el.remove());
  article.querySelectorAll("section.caseboard").forEach((board) => {
    const n = board.querySelectorAll('.cb-group[data-status="none"] .cb-row').length;
    if (n === 0) return;
    const label = board.querySelector('.cb-group[data-status="none"] .cb-pill')?.textContent?.trim() || "none";
    const p = document.createElement("p");
    p.className = CASEBOARD_LENS_NOTE_CLASS;
    p.textContent = COMPACT_WORDS[lang].hidden(n, label);
    board.append(p);
  });
}

/** On a section, a list, or an `ok` group: everything is shown. */
const SHOW_ALL_CLASS = "lens-show-all";
/** On a DecisionLog list Overview reorders: newest decision first. */
const DL_COMPACT_LIST_CLASS = "dl-compact";
/** On a decision past the newest {@link DL_COMPACT_SHOWN}. */
const DL_OLDER_CLASS = "dl-older";

function readerButton(cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.setAttribute(READER_ONLY_ATTR, "");
  return b;
}

function setAllShown(section: Element, open: boolean, lang: Lang): void {
  section.classList.toggle(SHOW_ALL_CLASS, open);
  const b = section.querySelector<HTMLButtonElement>(`:scope > .${DL_ALL_CLASS}`);
  if (!b) return;
  const n = section.querySelectorAll(".dl-item.dl-decision").length;
  b.textContent = open ? COMPACT_WORDS[lang].showNewest(DL_COMPACT_SHOWN) : COMPACT_WORDS[lang].showAll(n);
  b.setAttribute("aria-expanded", open ? "true" : "false");
}

/**
 * D41: in each DecisionLog, the decision items (`dl-decision`, marked by the
 * renderer) newest first and the newest five shown. Authored order is kept in
 * the DOM; Overview reorders through `order` on a flex list, so All, a
 * selection and the ref links see the page as written. Items in a second list
 * of the same log reorder within their list. Idempotent.
 */
export function decorateDecisionOrder(article: Element, lang: Lang): void {
  article.querySelectorAll(`.${DL_ALL_CLASS}`).forEach((el) => el.remove());
  article.querySelectorAll("section.decision-log").forEach((section) => {
    const items = Array.from(section.querySelectorAll<HTMLElement>(":scope > .dl-list > .dl-item.dl-decision"));
    items.forEach((item, k) => {
      const rank = items.length - 1 - k;
      item.style.setProperty("--dl-order", String(-(k + 1)));
      item.classList.toggle(DL_OLDER_CLASS, rank >= DL_COMPACT_SHOWN);
      item.parentElement?.classList.add(DL_COMPACT_LIST_CLASS);
    });
    if (items.length <= DL_COMPACT_SHOWN) return;
    const b = readerButton(DL_ALL_CLASS);
    b.addEventListener("click", () => setAllShown(section, !section.classList.contains(SHOW_ALL_CLASS), lang));
    items[0]!.parentElement!.after(b);
    setAllShown(section, section.classList.contains(SHOW_ALL_CLASS), lang);
  });
}

function setCaseExpanded(row: Element, open: boolean, lang: Lang): void {
  row.classList.toggle(DL_EXPANDED_CLASS, open);
  const b = row.querySelector<HTMLButtonElement>(`.${CB_MORE_CLASS}`);
  if (!b) return;
  b.textContent = open ? MORE_WORDS[lang].less : MORE_WORDS[lang].more;
  b.setAttribute("aria-expanded", open ? "true" : "false");
}

function setOkShown(group: Element, open: boolean, lang: Lang): void {
  group.classList.toggle(SHOW_ALL_CLASS, open);
  const b = group.querySelector<HTMLButtonElement>(`:scope > .${CB_OKMORE_CLASS}`);
  if (!b) return;
  const n = group.querySelectorAll(":scope > .cb-row").length - 1;
  b.textContent = open ? COMPACT_WORDS[lang].okFewer : COMPACT_WORDS[lang].okMore(n);
  b.setAttribute("aria-expanded", open ? "true" : "false");
}

/**
 * D42: each CaseBoard row's compact line gets a «mer» that shows the full
 * note and the refs, and an `ok` group of more than one row a «+ N til»
 * after its first row. Shown in Overview only. Idempotent.
 */
export function decorateCaseRows(article: Element, lang: Lang): void {
  article.querySelectorAll(`.${CB_MORE_CLASS}, .${CB_OKMORE_CLASS}`).forEach((el) => el.remove());
  article.querySelectorAll(".cb-row").forEach((row) => {
    const line = row.querySelector(":scope > .cb-line");
    if (!line || !row.querySelector(":scope > :is(.cb-note, .cb-refs, .cb-owner)")) return;
    const id = row.querySelector(":scope > .cb-id")?.textContent?.trim() ?? row.id;
    const b = readerButton(CB_MORE_CLASS);
    b.setAttribute("aria-label", MORE_WORDS[lang].about(id));
    b.addEventListener("click", () => setCaseExpanded(row, !row.classList.contains(DL_EXPANDED_CLASS), lang));
    line.append(b);
    setCaseExpanded(row, row.classList.contains(DL_EXPANDED_CLASS), lang);
  });
  article.querySelectorAll('.cb-group[data-status="ok"]').forEach((group) => {
    const rows = group.querySelectorAll(":scope > .cb-row");
    if (rows.length < 2 || !rows[0]!.querySelector(":scope > .cb-line")) return;
    const b = readerButton(CB_OKMORE_CLASS);
    b.addEventListener("click", () => setOkShown(group, !group.classList.contains(SHOW_ALL_CLASS), lang));
    rows[0]!.after(b);
    setOkShown(group, group.classList.contains(SHOW_ALL_CLASS), lang);
  });
}

/** The folds Overview opens: a `<Fold>` holding a DecisionLog or a CaseBoard
 *  that Overview itself does not hide. */
function compactFolds(article: Element): HTMLDetailsElement[] {
  return Array.from(article.querySelectorAll<HTMLDetailsElement>("details.fold")).filter(
    (f) => f.querySelector(":scope > .fold-body :is(section.decision-log, section.caseboard)") && !isHiddenByOverview(f),
  );
}

/** Entering Overview opens those folds. Nothing is stored, and leaving
 *  Overview leaves them as they are: a reader who picks All from an open
 *  fold is reading it. */
function openCompactFolds(article: Element, lens: Lens): void {
  if (lens !== "overview") return;
  for (const f of compactFolds(article)) f.open = true;
}

export interface LensOptions {
  language: Lang;
  /** The lens D2's precedence picked for this view. */
  initial: Lens;
  /** The server's flag: the Agent button renders only when true. */
  agentAvailable: boolean;
}

/** The lens `article` shows, read off its class; null before `enhanceLens`. */
export function lensOf(article: Element | null): Lens | null {
  return LENSES.find((l) => article?.classList.contains(`${LENS_CLASS_PREFIX}${l}`)) ?? null;
}

function applyLens(article: HTMLElement, row: HTMLElement | null, sw: HTMLElement | null, lens: Lens): void {
  for (const l of LENSES) {
    article.classList.toggle(`${LENS_CLASS_PREFIX}${l}`, l === lens);
  }
  openCompactFolds(article, lens);
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
 * shown when the page has something Overview hides or the Agent lens is
 * offered; the class is applied either way. Idempotent per render: the
 * article element is new on every page, so its reveal listener goes with it.
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

  let sw: HTMLElement | null = null;
  const compact = article.querySelector(`.${DL_MORE_CLASS}, .dl-decision, .cb-line`);
  if (row && (article.querySelector(HIDDEN_SELECTOR) || compact || opts.agentAvailable)) {
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
  applyLens(article, row, sw, opts.initial);

  // D3: a reveal of something this lens hides shows All for this view only.
  article.addEventListener(REVEAL_EVENT, (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    // D3 + D6: a reveal of a DecisionLog item, or of anything in its rest,
    // shows the whole item. Nothing else is hidden there, so the lens stays.
    const item = target.closest(".dl-item[id]");
    if (item?.querySelector(`:scope > .dl-text > .${DL_MORE_CLASS}`)) setExpanded(item, true, opts.language);
    // D41/D42: an older decision or a folded `ok` row shows its whole list.
    if (target.closest(`.${DL_OLDER_CLASS}`)) {
      const section = target.closest("section.decision-log");
      if (section) setAllShown(section, true, opts.language);
    }
    const okGroup = target.closest('.cb-group[data-status="ok"]');
    if (okGroup && target.closest(".cb-row") !== okGroup.querySelector(":scope > .cb-row")) setOkShown(okGroup, true, opts.language);
    if (lensOf(article) !== "overview") return;
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
 * paints in between.
 */
export function readerSelectionText(sel: Selection): string {
  const root = document.documentElement;
  root.classList.add(READER_ONLY_OFF_CLASS);
  try {
    return sel.toString();
  } finally {
    root.classList.remove(READER_ONLY_OFF_CLASS);
  }
}


/** The reader's CSS for the switch, the hidden blocks and the fold sizes. A
 *  peek card sits inside the article and shows its target whole in any lens. */
export function lensCss(): string {
  return `
    .wiki-article.${LENS_CLASS_PREFIX}overview :is(${HIDDEN_SELECTOR}):not(.${PEEK_CLASS} *) { display: none !important; }
    .${READER_ONLY_OFF_CLASS} [${READER_ONLY_ATTR}] { display: none !important; }
    .wiki-article.${LENS_CLASS_PREFIX}overview .dl-item:not(.${DL_EXPANDED_CLASS}) > .dl-text > .dl-rest:not(.${PEEK_CLASS} *),
    .wiki-article.${LENS_CLASS_PREFIX}overview .dl-item:not(.${DL_EXPANDED_CLASS}) > .dl-text ~ *:not(.${PEEK_CLASS} *) { display: none; }
    .wiki-article:not(.${LENS_CLASS_PREFIX}overview) :is(.${DL_MORE_CLASS}, .${DL_QSTATE_CLASS}) { display: none; }
    .wiki-article .${DL_MORE_CLASS} {
      font: inherit; font-size: 0.85em; margin-left: 0.4em; padding: 0 0.2em; border: none; background: none;
      color: var(--accent-light); cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
      user-select: none;
    }
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

/** D41/D42: Overview's compact DecisionLog and CaseBoard rows. Everything is
 *  scoped to Overview and kept out of a peek card, so All renders as before. */
function compactCss(): string {
  const ov = `.wiki-article.${LENS_CLASS_PREFIX}overview`;
  const notPeek = `:not(.${PEEK_CLASS} *)`;
  const dec = `${ov} .dl-item.dl-decision${notPeek}`;
  const toggle = `font: inherit; font-size: 0.85em; padding: 0 0.2em; border: none; background: none;
      color: var(--accent-light); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; user-select: none;`;
  return `
    .wiki-article:not(.${LENS_CLASS_PREFIX}overview) :is(.dl-when, .${DL_ALL_CLASS}, .cb-line, .${CB_OKMORE_CLASS}) { display: none; }
    .wiki-article .dl-when { display: none; }
    ${ov} .dl-list.${DL_COMPACT_LIST_CLASS}${notPeek} { display: flex; flex-direction: column; }
    ${ov} .dl-list.${DL_COMPACT_LIST_CLASS} > .dl-item${notPeek} { order: var(--dl-order, 0); }
    ${ov} .decision-log:not(.${SHOW_ALL_CLASS}) .dl-item.${DL_OLDER_CLASS}${notPeek} { display: none; }
    ${dec} {
      display: grid; grid-template-columns: auto minmax(0, 1fr) auto; column-gap: 0.7rem; align-items: baseline;
      padding: 0.45rem 0; border-bottom: 1px solid var(--border-secondary);
    }
    ${dec} > .dl-id { grid-row: 1; grid-column: 1; margin-right: 0; }
    ${dec} > .dl-text { grid-row: 1; grid-column: 2; }
    ${dec} > .dl-when {
      display: block; grid-row: 1; grid-column: 3; font-size: 0.8em; color: var(--text-soft);
      white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    ${dec} > .dl-text ~ * { grid-column: 2 / -1; }
    ${dec} > .id-noun, ${ov} .dl-decision .dl-tail${notPeek} { display: none; }
    @media (max-width: 640px) {
      ${dec} { grid-template-columns: auto minmax(0, 1fr); }
      ${dec} > .dl-when { grid-row: 2; grid-column: 2; }
    }
    .wiki-article .${DL_ALL_CLASS} { ${toggle} display: block; margin: 0.3rem 0 0.8rem; }
    ${ov} .caseboard .cb-row:not(.${DL_EXPANDED_CLASS}) > :is(.cb-owner, .cb-note, .cb-refs)${notPeek} { display: none; }
    ${ov} .caseboard .cb-row > .cb-line${notPeek} { order: 1; flex: 1 1 16rem; min-width: 0; }
    ${ov} .caseboard .cb-row > :is(.cb-owner, .cb-note)${notPeek} { order: 2; flex-basis: 100%; }
    ${ov} .caseboard .cb-row > .cb-refs${notPeek} { order: 3; }
    ${ov} .caseboard .cb-head { color: var(--text-soft); }
    ${ov} .cb-group[data-status="ok"]:not(.${SHOW_ALL_CLASS}) > .cb-row ~ .cb-row${notPeek} { display: none; }
    .wiki-article .${CB_MORE_CLASS} { ${toggle} margin-left: 0.4em; }
    .wiki-article:not(.${LENS_CLASS_PREFIX}overview) .${CB_MORE_CLASS} { display: none; }
    .wiki-article .${CB_OKMORE_CLASS} { ${toggle} display: block; margin: 0.1rem 0 0.3rem; }
  `;
}
