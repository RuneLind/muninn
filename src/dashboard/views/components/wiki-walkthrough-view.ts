/**
 * «Walk me through» — the pure half of the reader's panel: heading identity,
 * the state the panel renders from, its markup and its styles. The DOM half is
 * `wiki-walkthrough.ts`; the wire contract is `src/wiki/walkthrough-wire.ts`.
 *
 * **The panel is temporary** (owner decision O2 = A): nothing is cached or
 * written, so closing it and reopening a section makes a fresh call.
 *
 * **A quiz answer is final.** The first choice locks the question and reveals
 * whether it was right plus the passage that shows the answer; re-choosing is
 * not offered, because the reveal already gives the answer away.
 */

import {
  normalizeHeadingText,
  WALKTHROUGH_ALL_DROPPED,
  WALKTHROUGH_PARSE_FAILED,
  type WalkthroughDonePayload,
} from "../../../wiki/walkthrough-wire.ts";
import { escHtml } from "./escape.ts";

export const WALKTHROUGH_PANEL_ID = "wikiWalkthrough";
export const WALKTHROUGH_CLOSE_ID = "wikiWalkthroughClose";
/** The heading button's marker attribute (also the read-only backstop selector). */
export const WALKTHROUGH_BTN_ATTR = "data-walkthrough-btn";
export const WALKTHROUGH_CHOICE_ATTR = "data-wt-choice";

/** What the client sends to name a section. */
export interface HeadingIdentity {
  heading: string;
  ordinal: number;
  count: number;
}

/**
 * Identities for a list of heading texts in document order: each heading's
 * ordinal among the headings with the same normalized text, and that count.
 * Empty texts get `null` — a heading with no text cannot be named.
 */
export function headingIdentities(texts: readonly string[]): (HeadingIdentity | null)[] {
  const norm = texts.map(normalizeHeadingText);
  const totals = new Map<string, number>();
  for (const t of norm) if (t) totals.set(t, (totals.get(t) ?? 0) + 1);
  const seen = new Map<string, number>();
  return norm.map((t) => {
    if (!t) return null;
    const ordinal = seen.get(t) ?? 0;
    seen.set(t, ordinal + 1);
    return { heading: t, ordinal, count: totals.get(t)! };
  });
}

export type WalkthroughErrorKind = "all_dropped" | "parse" | "model" | "request" | "transport";

export interface WalkthroughPanelState {
  /** `relPath` + identity: what a repeat click is compared against. */
  key: string;
  relPath: string;
  identity: HeadingIdentity;
  phase: "loading" | "ready" | "error";
  error?: string;
  errorKind?: WalkthroughErrorKind;
  result?: WalkthroughDonePayload;
  /** Question index → the choice the reader picked (locked). */
  chosen: Record<number, number>;
}

export function walkthroughKey(relPath: string, id: HeadingIdentity): string {
  return `${relPath}\u0000${id.heading}\u0000${id.ordinal}\u0000${id.count}`;
}

export function initialPanelState(relPath: string, identity: HeadingIdentity): WalkthroughPanelState {
  return { key: walkthroughKey(relPath, identity), relPath, identity, phase: "loading", chosen: {} };
}

/** Classify an `app_error` payload's code. */
export function errorKindOf(code: unknown): WalkthroughErrorKind {
  if (code === WALKTHROUGH_ALL_DROPPED) return "all_dropped";
  if (code === WALKTHROUGH_PARSE_FAILED) return "parse";
  return "model";
}

/** Shape-check a `done` payload. `null` ⇒ the panel reports an error and shows
 *  nothing partial. */
export function parseDonePayload(d: unknown): WalkthroughDonePayload | null {
  if (!d || typeof d !== "object") return null;
  const o = d as Partial<WalkthroughDonePayload>;
  const str = (v: unknown) => typeof v === "string";
  if (!str(o.heading) || !Array.isArray(o.steps) || !Array.isArray(o.quiz)) return null;
  if (o.steps.length === 0) return null;
  if (!o.steps.every((s) => s && str(s.title) && str(s.text) && str(s.quote))) return null;
  const quizOk = o.quiz.every(
    (q) =>
      q && str(q.question) && str(q.quote) && Array.isArray(q.choices) && q.choices.every(str) &&
      Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.choices.length,
  );
  if (!quizOk) return null;
  return { heading: o.heading!, steps: o.steps, quiz: o.quiz, dropped: Array.isArray(o.dropped) ? o.dropped : [] };
}

/** Record a quiz choice. A question already answered keeps its first choice. */
export function chooseAnswer(state: WalkthroughPanelState, question: number, choice: number): boolean {
  const q = state.result?.quiz[question];
  if (!q || choice < 0 || choice >= q.choices.length) return false;
  if (state.chosen[question] !== undefined) return false;
  state.chosen[question] = choice;
  return true;
}

const esc = escHtml;

/** The heading button. It has NO text node: the 🧭 is CSS generated content
 *  (`walkthroughStyles`), so the heading's `textContent` stays exactly its text
 *  for every other reader of it (ref-link slugs, Explain's and Fact-check's
 *  `ctx`, specs). `data-reader-only` keeps it out of a peek copy. */
export function walkthroughBtnHtml(id: HeadingIdentity): string {
  return (
    `<button type="button" class="wiki-wt-btn" ${WALKTHROUGH_BTN_ATTR} data-reader-only ` +
    `data-wt-heading="${esc(id.heading)}" data-wt-ordinal="${id.ordinal}" data-wt-count="${id.count}" ` +
    `title="Walk me through this section" aria-label="Walk me through: ${esc(id.heading)}"></button>`
  );
}

function droppedNote(r: WalkthroughDonePayload): string {
  const n = r.dropped.length;
  if (n === 0) return "";
  return (
    `<p class="wiki-wt-dropped">${n} ${n === 1 ? "item was" : "items were"} left out: ` +
    "its quote was not in this section.</p>"
  );
}

function quizHtml(state: WalkthroughPanelState, r: WalkthroughDonePayload): string {
  if (r.quiz.length === 0) return "";
  const items = r.quiz.map((q, qi) => {
    const picked = state.chosen[qi];
    const answered = picked !== undefined;
    const choices = q.choices
      .map((c, ci) => {
        const cls = !answered ? "" : ci === q.answer ? " is-right" : ci === picked ? " is-wrong" : "";
        return (
          `<li><button type="button" class="wiki-wt-choice${cls}" ${WALKTHROUGH_CHOICE_ATTR}="${qi}:${ci}"` +
          `${answered ? " disabled" : ""}${answered && ci === picked ? ' aria-pressed="true"' : ""}>${esc(c)}</button></li>`
        );
      })
      .join("");
    const verdict = !answered
      ? ""
      : `<div class="wiki-wt-verdict ${picked === q.answer ? "is-right" : "is-wrong"}" role="status">` +
        (picked === q.answer ? "Right." : `Not quite — the answer is “${esc(q.choices[q.answer]!)}”.`) +
        `<blockquote class="wiki-wt-quote">${esc(q.quote)}</blockquote></div>`;
    return `<li class="wiki-wt-q"><p>${esc(q.question)}</p><ul class="wiki-wt-choices">${choices}</ul>${verdict}</li>`;
  });
  return `<h3 class="wiki-wt-sub">Check yourself</h3><ol class="wiki-wt-quiz">${items.join("")}</ol>`;
}

/** The panel's inner markup for a state. */
export function walkthroughPanelHtml(state: WalkthroughPanelState): string {
  const head =
    `<div class="wiki-wt-head"><span id="wikiWalkthroughTitle">🧭 ${esc(state.identity.heading)}</span>` +
    `<button type="button" class="wiki-wt-x" id="${WALKTHROUGH_CLOSE_ID}" aria-label="Close the walkthrough">✕</button></div>`;
  if (state.phase === "loading") {
    return head + '<p class="wiki-wt-status" role="status">Writing a walkthrough of this section…</p>';
  }
  if (state.phase === "error" || !state.result) {
    const cls = state.errorKind === "all_dropped" ? "wiki-wt-error is-dropped" : "wiki-wt-error";
    return head + `<p class="${cls}" role="alert">${esc(state.error ?? "The walkthrough failed.")}</p>`;
  }
  const r = state.result;
  const steps = r.steps
    .map(
      (s) =>
        `<li class="wiki-wt-step"><strong>${esc(s.title)}</strong><p>${esc(s.text)}</p>` +
        `<blockquote class="wiki-wt-quote">${esc(s.quote)}</blockquote></li>`,
    )
    .join("");
  return head + `<ol class="wiki-wt-steps">${steps}</ol>` + droppedNote(r) + quizHtml(state, r);
}

export function walkthroughStyles(): string {
  return `
    .wiki-article > :is(h1,h2,h3,h4,h5,h6) > .wiki-wt-btn {
      margin-left: 0.45em; padding: 0 0.35em; font-size: 0.6em; line-height: 1.5;
      vertical-align: middle; cursor: pointer; border-radius: 6px;
      border: 1px solid var(--border-secondary); background: var(--bg-inset);
      color: var(--text-secondary); opacity: 0.55;
    }
    .wiki-article > :is(h1,h2,h3,h4,h5,h6) > .wiki-wt-btn::before { content: "\\1F9ED"; }
    .wiki-article > :is(h1,h2,h3,h4,h5,h6):hover > .wiki-wt-btn,
    .wiki-article > :is(h1,h2,h3,h4,h5,h6) > .wiki-wt-btn:focus-visible { opacity: 1; }
    .wiki-wt {
      position: fixed; z-index: 55; right: 16px; bottom: 16px;
      width: min(440px, calc(100vw - 32px)); max-height: 72vh; overflow-y: auto;
      display: flex; flex-direction: column; gap: 8px; padding: 12px 14px;
      border-radius: 12px; border: 1px solid var(--border-secondary);
      background: var(--bg-surface); color: var(--text-primary);
      box-shadow: 0 18px 48px rgba(0,0,0,0.45); font-size: 13px; line-height: 1.5;
    }
    .wiki-wt-head { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; font-size: 14px; }
    .wiki-wt-x { background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 14px; }
    .wiki-wt-status { color: var(--text-secondary); margin: 0; }
    /* Status colour on the BORDER, body text in --text-primary: the saturated
       status tokens fall under 4.5:1 as text on --bg-surface in the light theme. */
    .wiki-wt-error {
      margin: 0; padding: 6px 10px; border-radius: 8px; color: var(--text-primary);
      border-left: 3px solid var(--status-error); background: var(--tint-error);
    }
    .wiki-wt-error.is-dropped { border-left-color: var(--status-warning); background: var(--tint-warning); }
    .wiki-wt-steps, .wiki-wt-quiz { margin: 0; padding-left: 1.3em; display: flex; flex-direction: column; gap: 10px; }
    .wiki-wt-step p, .wiki-wt-q p { margin: 2px 0; }
    .wiki-wt-quote {
      margin: 4px 0 0; padding: 4px 10px; border-left: 3px solid var(--accent);
      background: var(--bg-inset); color: var(--text-secondary); font-style: italic;
    }
    .wiki-wt-dropped { margin: 0; font-size: 12px; color: var(--text-secondary); }
    .wiki-wt-sub { margin: 6px 0 0; font-size: 13px; }
    .wiki-wt-choices { list-style: none; margin: 4px 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .wiki-wt-choice {
      width: 100%; text-align: left; padding: 5px 9px; border-radius: 8px; cursor: pointer; font-size: 12.5px;
      border: 1px solid var(--border-secondary); background: var(--bg-inset); color: var(--text-primary);
    }
    .wiki-wt-choice[disabled] { cursor: default; }
    .wiki-wt-choice.is-right { border-color: var(--status-success); background: var(--tint-success); }
    .wiki-wt-choice.is-wrong { border-color: var(--status-error); background: var(--tint-error); }
    .wiki-wt-verdict { color: var(--text-primary); padding-left: 8px; border-left: 3px solid; }
    .wiki-wt-verdict.is-right { border-left-color: var(--status-success); }
    .wiki-wt-verdict.is-wrong { border-left-color: var(--status-error); }`;
}
