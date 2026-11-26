/// <reference lib="dom" />
/**
 * The key peek and the Trace view (Discuss v2 PR 6, mimir plan
 * muninn-wiki-discuss-v2, D4 and D5). The markup is `wiki-key-trace-model.ts`.
 *
 * - **Peek (D5):** hovering a key the page render underlined
 *   (`span.wiki-key[data-wiki-key]`, `src/wiki/live-facts.ts` `planKeyMarks`)
 *   or a key's fact chip (a `data-live-fact` id with no `#`) shows what the
 *   mentions route says of it, with no model call. A mark whose chip shows is
 *   chipped (`wiki-live-facts.ts`): the chip is then that key's one target.
 *   A key the page defines (a CaseBoard row the reference linker links
 *   inside the mark) gets this peek alone, with the row and «Go to ↓»; the
 *   linker opens no peek of its own there (fix round 1 J1, J2). Answers are cached per key
 *   (`wiki-mentions-fetch.ts`). Not while a mouse button is down or text is
 *   selected, so it never covers a selection's bar.
 * - **Trace (D4):** an inline card, placed as the selection menu's cards are,
 *   from the peek's «Trace» or a selection's key chip. Mentions and the
 *   timeline show at once. «Summarize» starts the key's trace thread on the
 *   Discuss engine (`POST /api/wiki/discuss` with `traceKey`); follow-ups
 *   continue it, and an open card reads it back first
 *   (`GET /api/wiki/discuss/thread?traceKey=`). No Apply: a trace turn has no
 *   page. «Continue in Claude Code» copies a prompt with no page path.
 */

import { copyText } from "./copy-path.ts";
import { makeSseFrameParser } from "./client-runtime.ts";
import { renderStreamingBody } from "./wiki-ask-render.ts";
import { discussAgentOn, discussSendBlocked, discussUserFor } from "./wiki-discuss-tab.ts";
import { fetchMentions } from "./wiki-mentions-fetch.ts";
import { inlineCardHtml } from "./wiki-selection-menu-model.ts";
import { KEY_PEEK_ID, TRACE_SUMMARY_QUESTION, keyPeekHtml, traceBodyHtml, traceTurnHtml } from "./wiki-key-trace-model.ts";
import { escHtml as esc } from "./escape.ts";
import { KEY_PEEK_MARK_SELECTOR } from "../../../wiki/core/live-facts-chip.ts";

const DISCUSS_PATH = "/api/wiki/discuss";
const THREAD_PATH = "/api/wiki/discuss/thread";
const CONTINUE_PATH = "/api/wiki/discuss/continue";
const PEEK_DELAY_MS = 300;
const PEEK_HIDE_MS = 200;

export interface KeyTraceDeps {
  wiki(): string;
  relPath(): string | null;
  hrefFor(relPath: string): string;
  /** The mentions route answers this viewer (the reader payload's `mentions`). */
  mentionsOn(): boolean;
  /** Puts an inline card at `range` (the selection menu's `placeInlineCard`). */
  place(range: Range | null, html: string): HTMLElement | null;
}

let deps: KeyTraceDeps | null = null;

// ── Trace ─────────────────────────────────────────────────────────────────

interface TraceTurn {
  question: string;
  text: string;
  state: "running" | "done" | "error";
  status?: string;
  turnId: string | null;
}

interface TraceState {
  key: string;
  wiki: string;
  card: HTMLElement;
  turns: TraceTurn[];
  discussionId: string | null;
  busy: boolean;
}

const traces = new WeakMap<HTMLElement, TraceState>();

function turnsEl(st: TraceState): HTMLElement | null {
  return st.card.querySelector<HTMLElement>(".wiki-trace-turns");
}

function paintTurns(st: TraceState): void {
  const el = turnsEl(st);
  if (!el) return;
  el.innerHTML = st.turns
    .map((t) => traceTurnHtml({ question: t.question, answerHtml: t.state === "error" ? esc(t.text) : t.text ? renderStreamingBody(t.text) : "", state: t.state, status: t.status, turnId: t.turnId }))
    .join("");
  const started = st.turns.length > 0;
  const sum = st.card.querySelector<HTMLElement>("[data-trace-summarize]");
  if (sum) sum.hidden = started;
  const follow = st.card.querySelector<HTMLFormElement>(".wiki-trace-follow");
  if (follow) follow.hidden = !started;
  for (const b of Array.from(st.card.querySelectorAll<HTMLButtonElement>("[data-trace-summarize], .wiki-trace-follow button"))) b.disabled = st.busy;
}

/** The key's live trace thread, read back into the card (its turns from the message pairs). */
async function loadThread(st: TraceState): Promise<void> {
  const q = new URLSearchParams({ wiki: st.wiki, traceKey: st.key });
  const user = discussUserFor(st.wiki);
  if (user) q.set("userId", user);
  try {
    const res = await fetch(`${THREAD_PATH}?${q.toString()}`, { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const data = (await res.json()) as { thread?: { id: string } | null; messages?: { role: string; content: string; turn: { id: string; question: string; endState: string } | null }[] };
    if (!data.thread || st.turns.length) return;
    st.discussionId = data.thread.id;
    let question = "";
    for (const m of data.messages ?? []) {
      if (m.role === "user") question = m.turn?.question ?? m.content;
      else if (m.role === "assistant") st.turns.push({ question, text: m.content, state: "done", turnId: m.turn?.id ?? null });
    }
    // A turn whose two messages carried its row on the user message only: its id from there.
    const ids = (data.messages ?? []).filter((m) => m.turn).map((m) => m.turn!.id);
    st.turns.forEach((t, i) => (t.turnId ??= ids[i] ?? null));
    paintTurns(st);
  } catch {
    /* the card still shows the mentions; a send starts or continues the thread */
  }
}

async function send(st: TraceState, question: string): Promise<void> {
  if (st.busy || !question.trim() || discussSendBlocked()) return;
  const turn: TraceTurn = { question: question.trim(), text: "", state: "running", turnId: null };
  st.turns.push(turn);
  st.busy = true;
  paintTurns(st);
  const body: Record<string, unknown> = { wiki: st.wiki, traceKey: st.key, question: turn.question, mode: "explore" };
  if (st.discussionId) body.discussionId = st.discussionId;
  const user = discussUserFor(st.wiki);
  if (user) body.userId = user;
  const fail = (msg: string) => {
    turn.state = "error";
    turn.text = msg;
  };
  try {
    const res = await fetch(DISCUSS_PATH, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) {
      const err = (await res.json().catch(() => null)) as { error?: unknown } | null;
      fail(typeof err?.error === "string" ? `${err.error} (${res.status})` : `The turn was refused (${res.status}).`);
    } else {
      const parser = makeSseFrameParser((f) => {
        let m: Record<string, unknown> = {};
        try {
          m = JSON.parse(f.data) as Record<string, unknown>;
        } catch {
          return;
        }
        if (f.event === "turn") {
          if (typeof m.discussionId === "string") st.discussionId = m.discussionId;
          if (typeof m.turnId === "string") turn.turnId = m.turnId;
        } else if (f.event === "status") turn.status = typeof m.text === "string" ? m.text : typeof m.phase === "string" ? `Working: ${m.phase}` : turn.status;
        else if (f.event === "delta" && typeof m.text === "string") turn.text += m.text;
        else if (f.event === "done") {
          turn.state = "done";
          if (typeof m.answer === "string") turn.text = m.answer;
        } else if (f.event === "app_error") fail(typeof m.message === "string" ? m.message : "The turn failed.");
        else return;
        paintTurns(st);
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (let r = await reader.read(); !r.done; r = await reader.read()) parser.push(dec.decode(r.value, { stream: true }));
      parser.end();
      if (turn.state === "running") fail("The turn ended before its answer.");
    }
  } catch {
    fail("The turn failed: the server did not answer.");
  }
  st.busy = false;
  paintTurns(st);
}

async function continueInClaudeCode(st: TraceState, btn: HTMLElement): Promise<void> {
  const last = [...st.turns].reverse().find((t) => t.turnId && t.state !== "running");
  if (!last?.turnId) return;
  const note = (text: string) => {
    let el = st.card.querySelector<HTMLElement>(".wiki-trace-note");
    if (!el) {
      el = document.createElement("div");
      el.className = "wiki-discuss-hint wiki-trace-note";
      el.setAttribute("role", "status");
      btn.closest(".wiki-trace-follow")?.after(el);
    }
    el.textContent = text;
  };
  try {
    const res = await fetch(CONTINUE_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turnId: last.turnId }) });
    const data = (await res.json().catch(() => null)) as { prompt?: unknown; error?: unknown } | null;
    if (!res.ok || typeof data?.prompt !== "string") return note(typeof data?.error === "string" ? `${data.error} (${res.status})` : `The prompt could not be built (${res.status}).`);
    note((await copyText(data.prompt)) ? `Copied, ${data.prompt.length} characters. Paste it into Claude Code.` : "Copy failed.");
  } catch {
    note("The prompt could not be built: the server did not answer.");
  }
}

/** Open the Trace view for `key` at `range` (before an explainer's frame when null). */
export function openTrace(key: string, range: Range | null): HTMLElement | null {
  const d = deps;
  if (!d) return null;
  const card = d.place(range, inlineCardHtml("trace", key, `<div class="wiki-discuss-status"><span class="spinner"></span><span>Searching the wiki…</span></div>`, null));
  if (!card) return null;
  card.setAttribute("data-trace-key", key);
  const st: TraceState = { key, wiki: d.wiki(), card, turns: [], discussionId: null, busy: false };
  traces.set(card, st);
  void (async () => {
    const r = await fetchMentions(st.wiki, key);
    const body = card.querySelector(".wiki-sel-card-body");
    if (!card.isConnected || !body) return;
    if (!r.ok) {
      body.innerHTML = `<div class="wiki-discuss-error" role="alert">${esc(r.message)}</div>`;
      return;
    }
    const agent = discussAgentOn();
    body.innerHTML = traceBodyHtml(r.body, { currentRelPath: d.relPath(), hrefFor: d.hrefFor, agent });
    paintTurns(st);
    if (agent) await loadThread(st);
  })();
  return card;
}

// ── Peek ──────────────────────────────────────────────────────────────────

let peekFor: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let buttonDown = false;

function peekEl(): HTMLElement {
  let el = document.getElementById(KEY_PEEK_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = KEY_PEEK_ID;
  el.setAttribute("role", "tooltip");
  el.style.display = "none";
  document.body.appendChild(el);
  return el;
}

/** The key an element offers a peek for: a key mark (not one whose chip
 *  shows), or a key's fact chip. */
export function peekKeyOf(el: Element | null): { el: HTMLElement; key: string } | null {
  const hit = el?.closest?.<HTMLElement>(`.wiki-article ${KEY_PEEK_MARK_SELECTOR}, .wiki-article span.fact-chip[data-live-fact]`);
  if (!hit) return null;
  const key = hit.getAttribute("data-wiki-key") ?? hit.getAttribute("data-live-fact") ?? "";
  // A PR chip's id holds `#`: the peek is for keys.
  return key && !key.includes("#") ? { el: hit, key } : null;
}

export function hideKeyPeek(): void {
  if (showTimer) clearTimeout(showTimer);
  if (hideTimer) clearTimeout(hideTimer);
  showTimer = hideTimer = null;
  const el = document.getElementById(KEY_PEEK_ID);
  if (el) el.style.display = "none";
  if (peekFor?.dataset.peekTitle !== undefined) {
    peekFor.title = peekFor.dataset.peekTitle;
    delete peekFor.dataset.peekTitle;
  }
  peekFor = null;
}

function selectionLive(): boolean {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed;
}

async function showPeek(target: HTMLElement, key: string): Promise<void> {
  const d = deps;
  if (!d || buttonDown || selectionLive()) return;
  const r = await fetchMentions(d.wiki(), key);
  if (peekFor !== target || !target.isConnected || buttonDown || selectionLive()) return;
  const el = peekEl();
  const chipTitle = target.classList.contains("fact-chip") ? target.title : "";
  const ref = inPageRef(target);
  const here = ref ? (document.getElementById(ref.dataset.ref ?? "")?.textContent ?? "").replace(key, "").replace(/\s+/g, " ").trim() || key : undefined;
  el.innerHTML =
    (chipTitle ? `<div class="wiki-key-peek-meta">${esc(chipTitle)}</div>` : "") +
    (r.ok ? keyPeekHtml(r.body, { trace: true, here }) : `<div class="wiki-discuss-error">${esc(r.message)}</div>`);
  // The chip's own tooltip would cover the peek: its text is in the peek, back on hide.
  if (chipTitle) {
    target.dataset.peekTitle = chipTitle;
    target.removeAttribute("title");
  }
  el.setAttribute("data-peek-key", key);
  el.style.display = "block";
  const box = target.getBoundingClientRect();
  const w = el.offsetWidth || 300;
  const h = el.offsetHeight || 120;
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  const top = box.bottom + 6 + h > vh - 4 && box.top - h - 6 > 4 ? box.top - h - 6 : box.bottom + 6;
  el.style.left = `${Math.max(4, Math.min(box.left, vw - w - 4))}px`;
  el.style.top = `${Math.max(4, top)}px`;
}

/** The reference link the linker put inside a key mark (a key the page
 *  defines): its target is what «Go to ↓» jumps to. */
function inPageRef(mark: Element | null): HTMLAnchorElement | null {
  return mark?.querySelector<HTMLAnchorElement>("a.wiki-ref[data-ref]") ?? null;
}

function rangeAround(el: Element): Range {
  const r = document.createRange();
  r.selectNodeContents(el);
  return r;
}

/** Wire the peek once, at boot; `openTrace` needs it too. */
export function initKeyTrace(d: KeyTraceDeps): void {
  deps = d;
  document.addEventListener("mouseover", (e) => {
    const t = e.target as Element | null;
    if (t?.closest?.(`#${KEY_PEEK_ID}`)) {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = null;
      return;
    }
    const hit = deps?.mentionsOn() ? peekKeyOf(t) : null;
    if (!hit) {
      if (peekFor && !hideTimer) hideTimer = setTimeout(hideKeyPeek, PEEK_HIDE_MS);
      return;
    }
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    if (peekFor === hit.el) return;
    hideKeyPeek();
    peekFor = hit.el;
    showTimer = setTimeout(() => void showPeek(hit.el, hit.key), PEEK_DELAY_MS);
  });
  document.addEventListener("mousedown", (e) => {
    buttonDown = true;
    const t = e.target as Element | null;
    const trace = t?.closest?.<HTMLElement>(`#${KEY_PEEK_ID} [data-key-trace]`);
    if (trace) {
      e.preventDefault();
      const at = peekFor;
      const key = trace.getAttribute("data-key-trace") ?? "";
      hideKeyPeek();
      if (key) openTrace(key, at?.isConnected ? rangeAround(at) : null);
      return;
    }
    if (t?.closest?.(`#${KEY_PEEK_ID} [data-key-goto]`)) {
      e.preventDefault();
      const link = inPageRef(peekFor);
      hideKeyPeek();
      // The linker's own click: its jump, its Back pill.
      link?.click();
      return;
    }
    if (!t?.closest?.(`#${KEY_PEEK_ID}`)) hideKeyPeek();
  });
  document.addEventListener("mouseup", () => (buttonDown = false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideKeyPeek();
  });
  document.addEventListener("scroll", (e) => {
    if (!(e.target as Element | null)?.closest?.(`#${KEY_PEEK_ID}`)) hideKeyPeek();
  }, true);
  // The Trace card's own controls.
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const card = t.closest?.<HTMLElement>(".wiki-sel-card[data-trace-key]");
    const st = card ? traces.get(card) : undefined;
    if (!st) return;
    if (t.closest("[data-trace-summarize]")) void send(st, TRACE_SUMMARY_QUESTION);
    else if (t.closest("[data-trace-continue]")) void continueInClaudeCode(st, t);
  });
  document.addEventListener("submit", (e) => {
    const form = (e.target as HTMLElement).closest?.<HTMLFormElement>(".wiki-sel-card[data-trace-key] .wiki-trace-follow");
    const card = form?.closest<HTMLElement>(".wiki-sel-card");
    const st = card ? traces.get(card) : undefined;
    if (!form || !st) return;
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>(".wiki-trace-input");
    const q = input?.value ?? "";
    if (input) input.value = "";
    void send(st, q);
  });
}
