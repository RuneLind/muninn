/// <reference lib="dom" />
/**
 * «Ask Claude Code» — Discuss's handoff, the reader's half (mimir plan
 * muninn-wiki-discuss, P1; the route is `routes/wiki-discuss-handoff.ts`).
 *
 * On a wiki whose `.wiki-reader.json` sets `discuss.handoff` (the page
 * payload's `reader.discussHandoff`, admin viewers only), a selection reveals
 * «Ask Claude Code» beside Explain and Fact check, and the breadcrumb row has
 * the same control for the whole page. It opens a small panel — not a dialog,
 * so the reader's single-key shortcuts keep working outside its question box —
 * with the passage quoted and a question box. Copy asks the server for the
 * prompt and copies it through `copyText`, whose `execCommand` fallback is the
 * one that works on the plain-HTTP tailnet reader. No model is called.
 *
 * The selection's text, its occurrence number and the heading above it are
 * captured when the selection is made (`captureSelection`), before any click
 * can collapse it. The ids stay out of the read-only egress and blocked
 * selectors (no model call, no write, like Copy path) and are in
 * `WIKI_READ_SLICE_HIDDEN_SELECTOR`: the pod drops the route.
 */

import { copyText } from "./copy-path.ts";
import { readerSelectionText } from "./wiki-lens.ts";
import { discussHeading, selectionOccurrence } from "./wiki-discuss-text.ts";

export const DISCUSS_HANDOFF_SEL_BTN_ID = "wikiDiscussHandoffBtn";
export const DISCUSS_HANDOFF_PAGE_BTN_ID = "wikiDiscussHandoffPageBtn";
export const DISCUSS_HANDOFF_PANEL_ID = "wikiDiscussHandoffPanel";
const HANDOFF_PATH = "/api/wiki/discuss/handoff";
/** On the root for one read: fact chips out of the selection's text. */
const READING_CLASS = "discuss-reading";

export interface DiscussHandoffDeps {
  /** The served wiki's registry name (`FIND_SELF_WIKI || WIKI`). */
  wiki(): string;
  /** The open page's relPath, or null off a page. */
  relPath(): string | null;
}

interface Captured {
  selection: string;
  occurrence: number | null;
  total: number;
  heading: string;
}

let deps: DiscussHandoffDeps | null = null;
let enabled = false;
let captured: Captured | null = null;
/** What the open panel asks about: a passage, or the whole page (null). */
let asking: { relPath: string; passage: Captured | null } | null = null;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The selection-gated control, rendered hidden by the breadcrumb. */
export function discussHandoffSelBtnHtml(): string {
  return `<button class="wiki-bc-handoff" id="${DISCUSS_HANDOFF_SEL_BTN_ID}" type="button" style="display:none" title="Copy a prompt for Claude Code about this passage">⌘ Ask Claude Code</button>`;
}

/** The whole-page control, rendered hidden; shown by {@link setDiscussHandoffEnabled}. */
export function discussHandoffPageBtnHtml(): string {
  return `<button class="wiki-bc-handoff wiki-bc-handoff-page" id="${DISCUSS_HANDOFF_PAGE_BTN_ID}" type="button" style="display:none" title="Copy a prompt for Claude Code about this page">⌘ Ask Claude Code</button>`;
}

/** Per page render: whether the page's wiki offers the handoff. Closes a panel
 *  left open on the previous page. */
export function setDiscussHandoffEnabled(on: boolean): void {
  enabled = on;
  captured = null;
  closePanel();
  const page = document.getElementById(DISCUSS_HANDOFF_PAGE_BTN_ID);
  if (page) page.style.display = on ? "" : "none";
}

/** Read the selection while it exists: its text without the reader's own
 *  additions or fact chips, its occurrence number and its heading. */
export function captureDiscussSelection(sel: Selection): void {
  captured = null;
  if (!enabled || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const start = range.startContainer;
  const article = (start.nodeType === 1 ? (start as Element) : start.parentElement)?.closest(".wiki-article");
  if (!article) return;
  const root = document.documentElement;
  root.classList.add(READING_CLASS);
  let selection: string;
  try {
    selection = readerSelectionText(sel).trim();
  } finally {
    root.classList.remove(READING_CLASS);
  }
  if (!selection) return;
  const { occurrence, total } = selectionOccurrence(article, range, selection);
  captured = { selection, occurrence, total, heading: discussHeading(article, range) };
}

export function showDiscussSelBtn(show: boolean): void {
  const btn = document.getElementById(DISCUSS_HANDOFF_SEL_BTN_ID);
  if (btn) btn.style.display = show && enabled && captured ? "" : "none";
}

function panel(): HTMLElement {
  let el = document.getElementById(DISCUSS_HANDOFF_PANEL_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = DISCUSS_HANDOFF_PANEL_ID;
  el.className = "wiki-handoff-panel";
  el.hidden = true;
  el.setAttribute("aria-label", "Ask Claude Code");
  document.body.appendChild(el);
  el.addEventListener("click", onPanelClick);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePanel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void copyPrompt();
    }
  });
  return el;
}

function closePanel(): void {
  asking = null;
  const el = document.getElementById(DISCUSS_HANDOFF_PANEL_ID);
  if (el) el.hidden = true;
}

/** Open the panel on the captured passage (`passage: true`) or the whole page. */
export function openDiscussHandoff(passage: boolean): void {
  const relPath = deps?.relPath();
  if (!enabled || !relPath) return;
  if (passage && !captured) return;
  asking = { relPath, passage: passage ? captured : null };
  const el = panel();
  const quote = asking.passage
    ? `<blockquote class="wiki-handoff-quote">${esc(asking.passage.selection.length > 400 ? asking.passage.selection.slice(0, 399) + "…" : asking.passage.selection)}</blockquote>`
    : `<p class="wiki-handoff-quote wiki-handoff-whole">About the whole page</p>`;
  el.innerHTML =
    `<div class="wiki-handoff-head"><span>Ask Claude Code</span><button type="button" class="wiki-handoff-close" data-handoff="close" aria-label="Close">×</button></div>` +
    quote +
    `<textarea class="wiki-handoff-q" rows="3" placeholder="Your question" aria-label="Your question"></textarea>` +
    `<div class="wiki-handoff-row"><button type="button" class="wiki-handoff-copy" data-handoff="copy">Copy prompt</button>` +
    `<span class="wiki-handoff-status" role="status" aria-live="polite"></span></div>` +
    `<textarea class="wiki-handoff-out" readonly hidden aria-label="The prompt"></textarea>`;
  el.hidden = false;
  el.querySelector<HTMLTextAreaElement>(".wiki-handoff-q")?.focus();
}

function onPanelClick(e: Event): void {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-handoff]");
  if (!t) return;
  if (t.dataset.handoff === "close") closePanel();
  else if (t.dataset.handoff === "copy") void copyPrompt();
}

async function copyPrompt(): Promise<void> {
  const el = document.getElementById(DISCUSS_HANDOFF_PANEL_ID);
  const now = asking;
  if (!el || !now || !deps) return;
  const status = el.querySelector<HTMLElement>(".wiki-handoff-status")!;
  const out = el.querySelector<HTMLTextAreaElement>(".wiki-handoff-out")!;
  const question = el.querySelector<HTMLTextAreaElement>(".wiki-handoff-q")!.value.trim();
  if (!question) {
    status.textContent = "Type a question first.";
    return;
  }
  status.textContent = "Building the prompt…";
  const body: Record<string, unknown> = { wiki: deps.wiki(), relPath: now.relPath, question };
  if (now.passage) {
    body.selection = now.passage.selection;
    body.total = now.passage.total;
    body.heading = now.passage.heading;
    if (now.passage.occurrence !== null) body.occurrence = now.passage.occurrence;
  }
  let prompt: string;
  try {
    const res = await fetch(HANDOFF_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json()) as { prompt?: string; error?: string };
    if (!res.ok || typeof data.prompt !== "string") {
      status.textContent = data.error ?? `The prompt could not be built (${res.status}).`;
      return;
    }
    prompt = data.prompt;
  } catch {
    status.textContent = "The prompt could not be built: the server did not answer.";
    return;
  }
  if (asking !== now) return; // closed or moved on meanwhile
  out.value = prompt;
  const ok = await copyText(prompt);
  if (ok) {
    out.hidden = true;
    status.textContent = `Copied, ${prompt.length} characters. Paste it into Claude Code.`;
  } else {
    // The prompt stays here, selected, for ⌘C.
    out.hidden = false;
    out.focus();
    out.select();
    status.textContent = "Copy failed. The prompt is selected below: copy it by hand.";
  }
}

export function initDiscussHandoff(d: DiscussHandoffDeps): void {
  deps = d;
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest?.(`#${DISCUSS_HANDOFF_PAGE_BTN_ID}`)) openDiscussHandoff(false);
  });
}

export function discussHandoffStyles(): string {
  return `
    .wiki-bc-handoff {
      flex-shrink: 0; padding: 4px 11px; border-radius: 999px;
      background: transparent; color: var(--text-secondary);
      border: 1px solid var(--border-primary);
      font-size: 12px; font-weight: 600; line-height: 1; cursor: pointer; font-family: inherit;
    }
    .wiki-bc-handoff:hover { background: var(--tint-neutral); color: var(--text-primary); }
    .${READING_CLASS} .fc-chip, .${READING_CLASS} .fact-chip { display: none !important; }
    .wiki-handoff-panel {
      position: fixed; right: 24px; top: 112px; z-index: 40;
      width: min(440px, calc(100vw - 32px)); box-sizing: border-box;
      padding: 12px; border-radius: 10px;
      background: var(--bg-surface); color: var(--text-primary);
      border: 1px solid var(--border-secondary); box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25);
      font-size: 13px;
    }
    .wiki-handoff-panel[hidden] { display: none; }
    .wiki-handoff-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; margin-bottom: 8px; }
    .wiki-handoff-close { background: transparent; border: 0; color: var(--text-secondary); font-size: 18px; cursor: pointer; line-height: 1; }
    .wiki-handoff-quote {
      margin: 0 0 8px; padding: 6px 10px; max-height: 8em; overflow: auto;
      border-left: 3px solid var(--border-primary); color: var(--text-secondary); white-space: pre-wrap;
    }
    .wiki-handoff-whole { font-style: italic; }
    .wiki-handoff-q, .wiki-handoff-out {
      width: 100%; box-sizing: border-box; font: inherit; padding: 6px 8px; border-radius: 6px;
      border: 1px solid var(--border-secondary); background: var(--bg-inset); color: var(--text-primary); resize: vertical;
    }
    .wiki-handoff-out { margin-top: 8px; min-height: 8em; font-family: var(--font-mono, monospace); font-size: 12px; }
    .wiki-handoff-out[hidden] { display: none; }
    .wiki-handoff-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
    .wiki-handoff-copy {
      padding: 5px 12px; border-radius: 999px; cursor: pointer; font: inherit; font-weight: 600;
      background: var(--accent); color: var(--on-accent); border: 1px solid var(--accent);
    }
    .wiki-handoff-status { color: var(--text-secondary); font-size: 12px; }
  `;
}
