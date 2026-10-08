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
 *
 * Also here, because both read the rendered folds: each fold summary's size and
 * reading time (≈1,200 chars a minute).
 */

import { REVEAL_EVENT } from "./wiki-hash-target.ts";
import { CODE_REF_GROUP_CLASS } from "../../../wiki/code-refs.ts";
import { LENS_LABELS, readStoredLens, writeStoredLens, type Lens } from "../../../format/reader-lens.ts";

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

/** Whether Overview hides `el`: it or an ancestor matches a hidden block. */
export function isHiddenByOverview(el: Element): boolean {
  return el.closest(HIDDEN_SELECTOR) !== null;
}

type Lang = "en" | "no";

const NOTE_WORDS: Record<Lang, { cases: (n: number) => string; chars: string; min: string }> = {
  en: { cases: (n) => `${n} ${n === 1 ? "case" : "cases"} with status none not shown`, chars: "chars", min: "min" },
  no: { cases: (n) => `${n} ${n === 1 ? "sak" : "saker"} med status none vises ikke`, chars: "tegn", min: "min" },
};

const SWITCH_TITLE: Record<Lang, string> = {
  en: "Overview hides the working detail: line refs, history, queries' SQL and tables, developer and handoff folds",
  no: "Oversikt skjuler arbeidsdetaljene: linjereferanser, historikk, spørringenes SQL og tabeller, utvikler- og overleveringsfold",
};

function localStore(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** `12 345` chars as `12.3k`; under a thousand, the number. */
export function formatChars(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/** Minutes at ≈1,200 chars a minute; `<1` under half a minute. */
export function readingMinutes(chars: number): string {
  const m = Math.round(chars / 1200);
  return m < 1 ? "<1" : String(m);
}

/** A fold's size line, e.g. `5.9k chars · 5 min`. */
export function foldSizeLabel(chars: number, lang: Lang): string {
  const w = NOTE_WORDS[lang];
  return `${formatChars(chars)} ${w.chars} · ${readingMinutes(chars)} ${w.min}`;
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
    span.textContent = foldSizeLabel(chars, lang);
    summary.append(span);
  });
}

/** Under each CaseBoard with `none` rows, the line Overview shows in their
 *  place. Idempotent. */
function noteHiddenCases(article: Element, lang: Lang): void {
  article.querySelectorAll(`.${CASEBOARD_LENS_NOTE_CLASS}`).forEach((el) => el.remove());
  article.querySelectorAll("section.caseboard").forEach((board) => {
    const n = board.querySelectorAll('.cb-group[data-status="none"] .cb-row').length;
    if (n === 0) return;
    const p = document.createElement("p");
    p.className = CASEBOARD_LENS_NOTE_CLASS;
    p.textContent = NOTE_WORDS[lang].cases(n);
    board.append(p);
  });
}

export interface LensOptions {
  language: Lang;
  /** The lens D2's precedence picked for this view. */
  initial: Lens;
  /** The server's flag: the Agent button renders only when true. */
  agentAvailable: boolean;
}

/** The lens this view shows. */
let current: Lens = "all";

function applyLens(article: HTMLElement, sw: HTMLElement | null, lens: Lens): void {
  current = lens;
  for (const l of ["overview", "all", "agent"] as const) {
    article.classList.toggle(`${LENS_CLASS_PREFIX}${l}`, l === lens);
  }
  sw?.querySelectorAll<HTMLButtonElement>("button[data-lens]").forEach((b) => {
    const on = b.dataset.lens === lens;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
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

  const initial = opts.initial === "agent" && !opts.agentAvailable ? "all" : opts.initial;
  let sw: HTMLElement | null = null;
  if (row && (article.querySelector(HIDDEN_SELECTOR) || opts.agentAvailable)) {
    sw = document.createElement("div");
    sw.className = LENS_SWITCH_CLASS;
    sw.setAttribute("role", "group");
    sw.setAttribute("aria-label", opts.language === "no" ? "Visning" : "Lens");
    sw.title = SWITCH_TITLE[opts.language];
    const labels = LENS_LABELS[opts.language];
    const lenses: Lens[] = opts.agentAvailable ? ["overview", "all", "agent"] : ["overview", "all"];
    for (const lens of lenses) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.lens = lens;
      b.textContent = labels[lens];
      b.addEventListener("click", () => {
        writeStoredLens(localStore(), lens);
        applyLens(article, sw, lens);
      });
      sw.append(b);
    }
    row.append(sw);
  }
  applyLens(article, sw, initial);

  // D3: a reveal of something this lens hides shows All for this view only.
  article.addEventListener(REVEAL_EVENT, (e) => {
    if (current !== "overview") return;
    const target = e.target;
    if (target instanceof Element && isHiddenByOverview(target)) applyLens(article, sw, "all");
  });
}

/** The stored lens, for the caller's precedence. */
export function storedLens(): string | null {
  return readStoredLens(localStore());
}

/** The reader's CSS for the switch, the hidden blocks and the fold sizes. */
export function lensCss(): string {
  return `
    .wiki-article.${LENS_CLASS_PREFIX}overview :is(${HIDDEN_SELECTOR}) { display: none !important; }
    .wiki-article:not(.${LENS_CLASS_PREFIX}overview) .${CASEBOARD_LENS_NOTE_CLASS} { display: none; }
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
