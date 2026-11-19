/// <reference lib="dom" />
/**
 * «Ask Claude Code» — Discuss's handoff, the reader's half (mimir plan
 * muninn-wiki-discuss, P1; the route is `routes/wiki-discuss-handoff.ts`).
 *
 * On a wiki whose `.wiki-reader.json` sets `discuss.handoff` (the page
 * payload's `reader.discussHandoff`: admin viewers, tool half registered), a
 * selection reveals «Ask Claude Code» beside Explain and Fact check, and the
 * breadcrumb row has the same control for the whole page. It opens a small
 * panel — a group, not a dialog, so the reader's single-key shortcuts keep
 * working outside its question box — with the passage quoted and a question
 * box. Copy asks the server for the prompt and copies it through `copyText`,
 * whose `execCommand` fallback is the one that works on the plain-HTTP tailnet
 * reader. No model is called.
 *
 * This module owns its controls and listeners: the shell only says per page
 * whether the wiki offers it ({@link setDiscussHandoffEnabled}) and calls
 * {@link initDiscussHandoff} once. The selection is read when the control is
 * activated, always the live one, from any device; activating it again with
 * the panel open reads the new selection. A settled `selectionchange` (after
 * {@link SETTLE_MS}) only decides whether the control shows, with a cheap check
 * that reads no context and adds no class to the root: on a long page the full
 * read is a style recalculation and a walk of every text node. Closing the
 * panel puts the passage's range back unless the live selection is itself a
 * passage on the page (a newer selection outside the article is replaced).
 * The ids stay out of the read-only egress and blocked selectors
 * (no model call, no write, like Copy path) and are in
 * `WIKI_READ_SLICE_HIDDEN_SELECTOR`: the pod drops the route.
 *
 * On a wiki with a wiki agent (P3, the payload's `reader.discussAgent`) the
 * same controls and panel show whether or not the wiki sets `discuss.handoff`,
 * and the panel has «Ask here», which sends the passage and the question to
 * Discuss's tab (`wiki-discuss-tab.ts`). Copy prompt shows only with the
 * handoff; ⌘/Ctrl+Enter copies where it shows and asks here otherwise. «Ask
 * here» calls the agent, so it is in the read-only egress selector.
 */

import { copyText } from "./copy-path.ts";
import { readerSelectionText } from "./wiki-lens.ts";
import { DISCUSS_TEXT_HIDDEN, discussContext, touchesPeek, type DiscussContext } from "./wiki-discuss-text.ts";
import { HANDOFF_QUESTION_MAX, HANDOFF_SELECTION_MAX, HANDOFF_SELECTION_MIN } from "../../../wiki/discuss-bounds.ts";
import { askInDiscuss, discussAgentOn, discussSendBlocked, setDiscussAgentEnabled } from "./wiki-discuss-tab.ts";

export const DISCUSS_HANDOFF_SEL_BTN_ID = "wikiDiscussHandoffBtn";
export const DISCUSS_HANDOFF_PAGE_BTN_ID = "wikiDiscussHandoffPageBtn";
export const DISCUSS_HANDOFF_PANEL_ID = "wikiDiscussHandoffPanel";
const HANDOFF_PATH = "/api/wiki/discuss/handoff";
/** On the root for one read: fact chips and code-fence bars out of the selection's text. */
const READING_CLASS = "discuss-reading";
/** The quote the panel shows is cut here; the request carries the whole selection. */
const PANEL_QUOTE_MAX = 400;
/** A drag or a held Shift+arrow fires `selectionchange` many times: check once it rests. */
const SETTLE_MS = 50;

export interface DiscussHandoffDeps {
  /** The served wiki's registry name (`FIND_SELF_WIKI || WIKI`). */
  wiki(): string;
  /** The open page's relPath, or null off a page. */
  relPath(): string | null;
}

interface Captured extends DiscussContext {
  selection: string;
  /** The selection's range, put back when the panel closes. */
  range: Range;
}

let deps: DiscussHandoffDeps | null = null;
/** The panel and its controls show: the handoff, the agent, or both. */
let enabled = false;
/** Copy prompt: the wiki sets `discuss.handoff` (P1). */
let handoffOn = false;
/** What the open panel asks about: a passage, or the whole page (null). */
let asking: { relPath: string; passage: Captured | null; opener: HTMLElement | null } | null = null;
let inFlight = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The selection-gated control, rendered hidden. Without the handoff (an
 *  agent-only wiki) it asks the wiki agent. */
export function discussHandoffSelBtnHtml(handoff = true): string {
  return handoff
    ? `<button class="wiki-bc-handoff" id="${DISCUSS_HANDOFF_SEL_BTN_ID}" type="button" style="display:none" title="Copy a prompt for Claude Code about this passage">⌘ Ask Claude Code</button>`
    : `<button class="wiki-bc-handoff" id="${DISCUSS_HANDOFF_SEL_BTN_ID}" type="button" style="display:none" title="Ask the wiki agent about this passage">💬 Ask about this</button>`;
}

/** The whole-page control: only with the handoff (the agent's whole-page
 *  question is the Discuss tab's own box). */
export function discussHandoffPageBtnHtml(): string {
  return `<button class="wiki-bc-handoff wiki-bc-handoff-page" id="${DISCUSS_HANDOFF_PAGE_BTN_ID}" type="button" title="Copy a prompt for Claude Code about this page">⌘ Ask Claude Code</button>`;
}

/** Put the two controls into the breadcrumb the shell just rendered: the
 *  selection one after the selection-gated Fact check, the page one after the
 *  whole-page Fact check (else at the row's end). */
function mountControls(): void {
  const bc = document.getElementById("wikiBreadcrumb");
  if (!bc) return;
  if (!document.getElementById(DISCUSS_HANDOFF_SEL_BTN_ID)) {
    const at = document.getElementById("wikiFactcheckBtn");
    if (at) at.insertAdjacentHTML("afterend", discussHandoffSelBtnHtml(handoffOn));
  }
  if (handoffOn && !document.getElementById(DISCUSS_HANDOFF_PAGE_BTN_ID)) {
    const at = document.getElementById("wikiFactcheckArticleBtn");
    if (at) at.insertAdjacentHTML("afterend", discussHandoffPageBtnHtml());
    else bc.insertAdjacentHTML("beforeend", discussHandoffPageBtnHtml());
  }
}

/** Per page render: whether the page's wiki offers the handoff (`on`) and
 *  the wiki agent (`agent`, P3: passed on to the Discuss tab, which keeps it
 *  off on a read-only wiki). Closes a panel left open on the previous page. */
export function setDiscussHandoffEnabled(on: boolean, agent = false): void {
  setDiscussAgentEnabled(agent);
  handoffOn = on;
  enabled = on || discussAgentOn();
  closePanel(false);
  // Rebuilt per page: the controls' words follow which half the wiki offers.
  document.getElementById(DISCUSS_HANDOFF_SEL_BTN_ID)?.remove();
  document.getElementById(DISCUSS_HANDOFF_PAGE_BTN_ID)?.remove();
  if (enabled) {
    mountControls();
    showSelBtn();
  }
}

/** The selection's range and its article when it starts and ends in one
 *  `.wiki-article` and touches no peek card. */
function inArticle(sel: Selection | null): { range: Range; article: Element } | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const start = range.startContainer;
  const article = (start.nodeType === 1 ? (start as Element) : start.parentElement)?.closest(".wiki-article");
  if (!article || !article.contains(range.endContainer) || touchesPeek(article, range)) return null;
  return { range, article };
}

/** The cheap check: could the selection be a passage? Its raw text, which can
 *  hold what the reader added, stands in for the reading; no class on the root,
 *  no context, no walk of the article. */
function mayBePassage(sel: Selection | null): boolean {
  if (!inArticle(sel)) return false;
  const n = sel!.toString().trim().length;
  return n >= HANDOFF_SELECTION_MIN && n <= HANDOFF_SELECTION_MAX;
}

/** The full read of the live selection: its text without the reader's own
 *  additions, fact chips or fence bars, and the context around it. Null when
 *  it is no passage. */
function readDiscussSelection(sel: Selection | null): Captured | null {
  if (!enabled) return null;
  const at = inArticle(sel);
  if (!at) return null;
  const { range, article } = at;
  const root = document.documentElement;
  root.classList.add(READING_CLASS);
  let selection: string;
  try {
    selection = readerSelectionText(sel!).trim();
  } finally {
    root.classList.remove(READING_CLASS);
  }
  if (selection.length < HANDOFF_SELECTION_MIN || selection.length > HANDOFF_SELECTION_MAX) return null;
  const context = discussContext(article, range);
  if (!context) return null;
  return { selection, ...context, range: range.cloneRange() };
}

/** The selection has rested: show or hide the control. */
function settleSelection(): void {
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = null;
  showSelBtn();
}

/** The control shows while the selection may be a passage, and while the panel
 *  is open on a passage (the control opened it; focus in the question box
 *  collapses the page's selection). */
function showSelBtn(): void {
  const btn = document.getElementById(DISCUSS_HANDOFF_SEL_BTN_ID);
  if (btn) btn.style.display = enabled && (!!asking?.passage || mayBePassage(window.getSelection())) ? "" : "none";
}

function panel(): HTMLElement {
  let el = document.getElementById(DISCUSS_HANDOFF_PANEL_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = DISCUSS_HANDOFF_PANEL_ID;
  el.className = "wiki-handoff-panel";
  el.hidden = true;
  // A group, not a dialog: `modalOpen()` reads every visible dialog as modal.
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", "Ask Claude Code");
  document.body.appendChild(el);
  el.addEventListener("click", onPanelClick);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (handoffOn) void copyPrompt();
      else askHere();
    }
  });
  return el;
}

function panelOpen(): boolean {
  const el = document.getElementById(DISCUSS_HANDOFF_PANEL_ID);
  return !!el && !el.hidden;
}

/** Close the panel; `restore` puts focus back on the control that opened it
 *  and, when the page holds no selection that may be a passage (focus in the
 *  question box collapsed it), the passage's range back on the page, so no
 *  late `selectionchange` hides the control that has focus. A selection the
 *  reader made while the panel was open stays. */
function closePanel(restore: boolean): void {
  const opener = asking?.opener ?? null;
  const range = asking?.passage?.range ?? null;
  asking = null;
  const el = document.getElementById(DISCUSS_HANDOFF_PANEL_ID);
  if (el) el.hidden = true;
  if (restore) {
    if (opener?.isConnected) opener.focus();
    const sel = window.getSelection();
    if (sel && range && !mayBePassage(sel) && range.startContainer.isConnected && range.endContainer.isConnected) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
  showSelBtn();
}

/** Open the panel on the live selection (`passage: true`) or the whole page.
 *  With the panel open, a passage is read again and the panel shows it; a
 *  selection that reads as no passage opens nothing and leaves an open panel. */
export function openDiscussHandoff(passage: boolean, opener: HTMLElement | null = null): void {
  const relPath = deps?.relPath();
  if (!enabled || !relPath) return;
  const read = passage ? readDiscussSelection(window.getSelection()) : null;
  if (passage && !read) {
    showSelBtn();
    return;
  }
  asking = { relPath, passage: read, opener };
  const el = panel();
  const sel = asking.passage?.selection ?? "";
  const quote = asking.passage
    ? `<blockquote class="wiki-handoff-quote">${esc(sel.length > PANEL_QUOTE_MAX ? sel.slice(0, PANEL_QUOTE_MAX - 1) + "…" : sel)}</blockquote>`
    : `<p class="wiki-handoff-quote wiki-handoff-whole">About the whole page</p>`;
  const agent = discussAgentOn();
  el.setAttribute("aria-label", handoffOn ? "Ask Claude Code" : "Ask the wiki agent");
  el.innerHTML =
    `<div class="wiki-handoff-head"><span>${handoffOn ? "Ask Claude Code" : "Ask the wiki agent"}</span><button type="button" class="wiki-handoff-close" data-handoff="close" aria-label="Close">×</button></div>` +
    quote +
    `<textarea class="wiki-handoff-q" rows="3" maxlength="${HANDOFF_QUESTION_MAX}" placeholder="Your question" aria-label="Your question"></textarea>` +
    `<div class="wiki-handoff-row">` +
    (agent ? `<button type="button" class="wiki-handoff-copy wiki-handoff-askhere" data-handoff="ask-here" title="Ask the wiki agent here, in the Discuss tab">Ask here</button>` : "") +
    (handoffOn ? `<button type="button" class="wiki-handoff-copy${agent ? " wiki-handoff-second" : ""}" data-handoff="copy">Copy prompt</button>` : "") +
    `<span class="wiki-handoff-status" role="status" aria-live="polite"></span></div>` +
    `<textarea class="wiki-handoff-out" readonly hidden aria-label="The prompt"></textarea>`;
  inFlight = false;
  el.hidden = false;
  el.querySelector<HTMLTextAreaElement>(".wiki-handoff-q")?.focus();
  showSelBtn();
}

function onPanelClick(e: Event): void {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-handoff]");
  if (!t) return;
  if (t.dataset.handoff === "close") closePanel(true);
  else if (t.dataset.handoff === "copy") void copyPrompt();
  else if (t.dataset.handoff === "ask-here") askHere();
}

/** «Ask here» (P3): the panel's passage and question go to the Discuss tab,
 *  and the panel closes. A turn of this page's discussion still running
 *  keeps the panel open with a note. */
function askHere(): void {
  const el = document.getElementById(DISCUSS_HANDOFF_PANEL_ID);
  const now = asking;
  if (!el || !now || !discussAgentOn()) return;
  const status = el.querySelector<HTMLElement>(".wiki-handoff-status")!;
  // ⌘/Ctrl+Enter reaches here from the question box, which no read-only
  // selector covers: check at the send, not only through the agent flag.
  if (discussSendBlocked()) {
    status.textContent = "This wiki is read-only: nothing on it is sent to a model.";
    return;
  }
  const question = el.querySelector<HTMLTextAreaElement>(".wiki-handoff-q")!.value.trim();
  if (!question) {
    status.textContent = "Type a question first.";
    return;
  }
  const p = now.passage;
  const passage = p ? { selection: p.selection, before: p.before, after: p.after, atStart: p.atStart, atEnd: p.atEnd, heading: p.heading, ...(p.edge ? { edge: p.edge } : {}) } : null;
  if (!askInDiscuss(question, passage, p?.range ?? null)) {
    status.textContent = "This page's discussion has a turn still running: ask when it has ended.";
    return;
  }
  closePanel(false);
}

async function copyPrompt(): Promise<void> {
  const el = document.getElementById(DISCUSS_HANDOFF_PANEL_ID);
  const now = asking;
  if (!el || !now || !deps || inFlight || !handoffOn) return;
  const status = el.querySelector<HTMLElement>(".wiki-handoff-status")!;
  const out = el.querySelector<HTMLTextAreaElement>(".wiki-handoff-out")!;
  // Its own button: «Ask here» shares the class and comes first.
  const copyBtn = el.querySelector<HTMLButtonElement>('[data-handoff="copy"]')!;
  const question = el.querySelector<HTMLTextAreaElement>(".wiki-handoff-q")!.value.trim();
  if (!question) {
    status.textContent = "Type a question first.";
    return;
  }
  const body: Record<string, unknown> = { wiki: deps.wiki(), relPath: now.relPath, question };
  const p = now.passage;
  if (p) {
    Object.assign(body, { selection: p.selection, before: p.before, after: p.after, atStart: p.atStart, atEnd: p.atEnd, heading: p.heading });
    if (p.edge) body.edge = p.edge;
  }
  inFlight = true;
  copyBtn.disabled = true;
  status.textContent = "Building the prompt…";
  let prompt: string | null = null;
  try {
    const res = await fetch(HANDOFF_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let data: { prompt?: string; error?: string } | null = null;
    try {
      data = (await res.json()) as { prompt?: string; error?: string };
    } catch {
      data = null;
    }
    if (!res.ok || typeof data?.prompt !== "string") {
      status.textContent = data?.error ? `${data.error} (${res.status})` : `The prompt could not be built (${res.status}).`;
    } else prompt = data.prompt;
  } catch {
    status.textContent = "The prompt could not be built: the server did not answer.";
  } finally {
    inFlight = false;
    copyBtn.disabled = false;
  }
  if (prompt === null || asking !== now) return; // failed, or closed or moved on meanwhile
  out.value = prompt;
  const ok = await copyText(prompt);
  if (asking !== now) return;
  if (ok) {
    out.hidden = true;
    status.textContent = `Copied, ${prompt.length} characters. Paste it into Claude Code.`;
    // The fallback copy leaves focus on <body>: bring it back into the panel.
    copyBtn.focus();
  } else {
    // The prompt stays here, selected, for ⌘C.
    out.hidden = false;
    out.focus();
    out.select();
    status.textContent = "Copy failed. The prompt is selected below: copy it by hand.";
  }
}

/** Wire the controls once, at boot. */
export function initDiscussHandoff(d: DiscussHandoffDeps): void {
  deps = d;
  // Mouse, keyboard or touch: every selection change ends here, the panel open or not.
  document.addEventListener("selectionchange", () => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(settleSelection, SETTLE_MS);
  });
  // A mouse press would collapse the selection the button acts on; keep it.
  document.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest?.(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`)) e.preventDefault();
  });
  // `click`, which the keyboard's Enter and Space fire too.
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const sel = t.closest?.<HTMLElement>(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`);
    if (sel) {
      e.preventDefault();
      openDiscussHandoff(true, sel);
      return;
    }
    const page = t.closest?.<HTMLElement>(`#${DISCUSS_HANDOFF_PAGE_BTN_ID}`);
    if (page) openDiscussHandoff(false, page);
  });
  // Escape closes the panel wherever focus is (the fallback copy leaves it on <body>).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !panelOpen()) return;
    e.stopPropagation();
    closePanel(true);
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
    ${DISCUSS_TEXT_HIDDEN.split(", ").map((sel) => `.${READING_CLASS} ${sel}`).join(", ")} { display: none !important; }
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
    .wiki-handoff-copy:disabled { opacity: 0.6; cursor: progress; }
    .wiki-handoff-second { background: transparent; color: var(--text-primary); border-color: var(--border-secondary); }
    .wiki-handoff-status { color: var(--text-secondary); font-size: 12px; }
  `;
}
