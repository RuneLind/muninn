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
 * - **Thread state (fix round 1 K1–K3):** the card is held like an Explain
 *   card, so a render of its page puts it back with its stream still
 *   feeding it; the stream aborts when the card leaves for good (closed,
 *   replaced, another page). The read-back builds turns from their ledger
 *   rows (`traceTurnsFromThread`): a turn still running on the server shows
 *   running, with no «Summarize» or follow-up box, and the card reads the
 *   thread again every `TRACE_POLL_MS` until it has ended; a send refused
 *   409 `busy` goes to that read.
 * - **Poll failures (fix round 2 batch 4, class check C):** a failed read is
 *   read again with a growing wait, a bounded number of times
 *   (`tracePollStep`), counted since the last read that worked or the last
 *   send; a thread that is gone clears the card back to «Summarize» with a
 *   note, and a permanent refusal (or reads failing past the bound) ends its
 *   running turns as errors with that message, or says it in the note when
 *   none runs, so the follow-up box or «Summarize» is there. Known gap
 *   (deferred): a held card whose due read or stream finds it not live (an
 *   Ask or start view took the pane) stops for good, and stays «Still
 *   running» when Back puts it on the page again.
 * - **Ordering (class check C):** one read at a time and one timer. A send,
 *   a newer read and the card's drop each stop the reads before them
 *   (`stopReads`: the timer cleared, the read in flight aborted), and a read
 *   applies nothing once aborted, so no answer older than a send lands
 *   after it.
 */

import { copyText } from "./copy-path.ts";
import { makeSseFrameParser } from "./client-runtime.ts";
import { renderStreamingBody } from "./wiki-ask-render.ts";
import { adoptDiscussUser, discussAgentOn, discussBotFor, discussSendBlocked, discussUserFor, registerDiscussUserViews } from "./wiki-discuss-tab.ts";
import { fetchMentions } from "./wiki-mentions-fetch.ts";
import { inlineCardHtml } from "./wiki-selection-menu-model.ts";
import {
  KEY_PEEK_ID,
  TRACE_SUMMARY_QUESTION,
  TRACE_THREAD_GONE,
  keyPeekHtml,
  traceBodyHtml,
  tracePollStep,
  traceReadOf,
  traceStatusFrom,
  traceTurnHtml,
  traceTurnsFromThread,
  type TraceThreadMessage,
  type TraceThreadRead,
} from "./wiki-key-trace-model.ts";
import { escHtml as esc } from "./escape.ts";
import { whenSlow } from "./wiki-discuss-state.ts";
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
  /** Puts an inline card at `range` (the selection menu's `placeInlineCard`);
   *  `onDrop` runs once when the card leaves for good. */
  place(range: Range | null, html: string, onDrop?: () => void): HTMLElement | null;
  /** The card is on the page, or out for a render of its page (`inlineCardLive`). */
  live(card: Element): boolean;
}

let deps: KeyTraceDeps | null = null;

// ── Trace ─────────────────────────────────────────────────────────────────

interface TraceTurn {
  question: string;
  text: string;
  state: "running" | "done" | "error";
  status?: string;
  turnId: string | null;
  /** The send's request has had no answer for {@link DISCUSS_WAITING_MS}. */
  waiting?: boolean;
}

interface TraceState {
  key: string;
  wiki: string;
  card: HTMLElement;
  turns: TraceTurn[];
  discussionId: string | null;
  /** The user of the read or turn that gave `discussionId`: a send naming the thread names this user. */
  userId: string | null;
  /** The route can take `userId` as a posted id (R2: it holds a thread, or the read listed it). */
  userListed: boolean;
  busy: boolean;
  /** The running send's stream, aborted when the card leaves for good. */
  ctl: AbortController | null;
  poll: ReturnType<typeof setTimeout> | null;
  /** The thread read in flight, aborted when the card leaves for good, a newer read starts or a send starts. */
  pollCtl: AbortController | null;
  /** Failed reads in a row since the last read that worked or the last send (`tracePollStep`). */
  pollFailures: number;
  dropped: boolean;
}

const traces = new WeakMap<HTMLElement, TraceState>();
/** Every card not dropped: the Discuss tab's user rules (R3) reach them. */
const openTraces = new Set<TraceState>();

function turnsEl(st: TraceState): HTMLElement | null {
  return st.card.querySelector<HTMLElement>(".wiki-trace-turns");
}

function live(st: TraceState): boolean {
  return !st.dropped && !!deps?.live(st.card);
}

/** No read of the card's thread goes on: the next one's timer cleared, the
 *  one in flight aborted (its answer is then never applied). */
function stopReads(st: TraceState): void {
  if (st.poll) clearTimeout(st.poll);
  st.poll = null;
  st.pollCtl?.abort();
  st.pollCtl = null;
}

function dropTrace(st: TraceState): void {
  st.dropped = true;
  openTraces.delete(st);
  st.ctl?.abort();
  stopReads(st);
}

/** The card's one note line, under the follow-up box. `end` marks a note
 *  about the thread's read (gone, or refused), which a send clears. */
function traceNote(st: TraceState, text: string, end = false): void {
  let el = st.card.querySelector<HTMLElement>(".wiki-trace-note");
  if (!el) {
    el = document.createElement("div");
    el.className = "wiki-discuss-hint wiki-trace-note";
    el.setAttribute("role", "status");
    st.card.querySelector(".wiki-trace-follow")?.after(el);
  }
  el.toggleAttribute("data-trace-end", end);
  el.textContent = text;
}

function paintTurns(st: TraceState): void {
  const el = turnsEl(st);
  if (!el) return;
  el.innerHTML = st.turns
    .map((t) => traceTurnHtml({ question: t.question, answerHtml: t.state === "error" ? esc(t.text) : t.text ? renderStreamingBody(t.text) : "", state: t.state, status: t.status, turnId: t.turnId, waiting: t.waiting }))
    .join("");
  const started = st.turns.length > 0;
  // A turn running (this card's or one read back): nothing to send until it ends.
  const running = st.turns.some((t) => t.state === "running");
  const sum = st.card.querySelector<HTMLElement>("[data-trace-summarize]");
  if (sum) sum.hidden = started;
  const follow = st.card.querySelector<HTMLFormElement>(".wiki-trace-follow");
  if (follow) follow.hidden = !started || running;
  for (const b of Array.from(st.card.querySelectorAll<HTMLButtonElement>("[data-trace-summarize], .wiki-trace-follow button"))) b.disabled = st.busy;
  syncTraceSend(st.card, st.busy);
}

/** «Send» is off while the follow-up box is empty (or a turn runs): on 27.11 an
 *  empty box read as plain text and a Send on it did nothing visible. */
function syncTraceSend(card: HTMLElement, busy: boolean): void {
  const input = card.querySelector<HTMLInputElement>(".wiki-trace-input");
  const btn = card.querySelector<HTMLButtonElement>(".wiki-trace-follow button[type=submit]");
  if (input && btn) btn.disabled = busy || !input.value.trim();
}

/** The key's live trace thread, read back into the card from its ledger
 *  rows; again while a turn of it is still running, and after a failed read
 *  ({@link tracePollStep}). */
async function loadThread(st: TraceState): Promise<void> {
  stopReads(st);
  if (!live(st)) return;
  const ctl = new AbortController();
  st.pollCtl = ctl;
  const q = new URLSearchParams({ wiki: st.wiki, traceKey: st.key });
  const user = st.discussionId && st.userId ? st.userId : discussUserFor(st.wiki); // R1
  if (user) q.set("userId", user);
  let read: TraceThreadRead;
  let thread: { id: string; messages: TraceThreadMessage[] } | null = null;
  let readUser: string | null = null;
  let readBot: string | null = null;
  let readListed = false;
  try {
    const res = await fetch(`${THREAD_PATH}?${q.toString()}`, { headers: { Accept: "application/json" }, signal: ctl.signal });
    if (res.ok) {
      // Not JSON, or JSON that is no thread: `malformed`, read again under the bound.
      const b = (await res.json().catch(() => undefined)) as { userId?: unknown; bot?: unknown; users?: unknown } | undefined;
      ({ read, thread } = traceReadOf(b));
      readUser = typeof b?.userId === "string" ? b.userId : null;
      if (readUser) readBot = typeof b?.bot === "string" ? b.bot : null;
      readListed = Array.isArray(b?.users) && (b.users as { id?: unknown }[]).some((u) => u?.id === readUser);
    } else {
      const err = (await res.json().catch(() => null)) as { error?: unknown; reason?: unknown } | null;
      read = {
        kind: "refused",
        status: res.status,
        ...(typeof err?.error === "string" ? { error: err.error } : {}),
        ...(typeof err?.reason === "string" ? { reason: err.reason } : {}),
      };
    }
  } catch {
    read = { kind: "unreachable" };
  }
  if (st.pollCtl === ctl) st.pollCtl = null;
  // Superseded (a send, a newer read) or dropped: the answer is older than the card's state.
  if (ctl.signal.aborted || !live(st)) return;
  if (readUser) {
    st.userId = readUser; // R1
    st.userListed = !!thread || readListed;
    if (st.userListed) adoptDiscussUser(st.wiki, readBot, readUser);
  }
  if (thread) {
    st.discussionId = thread.id;
    st.turns = traceTurnsFromThread(thread.messages);
    paintTurns(st);
    read = { kind: "thread", running: st.turns.some((t) => t.state === "running") };
  }
  const step = tracePollStep(read, st.pollFailures);
  if (step.next === "again") {
    st.pollFailures = step.failures;
    st.poll = setTimeout(() => void loadThread(st), step.delayMs);
    return;
  }
  st.pollFailures = 0;
  if (step.next === "gone") {
    // A card with no turns (its first read, a key never traced) has nothing gone.
    if (st.turns.length > 0) {
      st.turns = [];
      st.discussionId = null;
      paintTurns(st);
      traceNote(st, TRACE_THREAD_GONE, true);
    }
  } else if (step.next === "failed") {
    if (st.turns.some((t) => t.state === "running")) {
      for (const t of st.turns) if (t.state === "running") Object.assign(t, { state: "error", text: step.message, status: undefined });
      paintTurns(st);
    } else traceNote(st, step.message, true);
  }
}

/** `onStart` runs once the send passes its checks, before anything else: the
 *  follow-up box clears there, so a refused send keeps the question. */
async function send(st: TraceState, question: string, onStart?: () => void): Promise<void> {
  if (st.busy || !question.trim() || discussSendBlocked()) return;
  onStart?.();
  // A user action: the reads before it are superseded, and the bound counts afresh.
  stopReads(st);
  st.pollFailures = 0;
  const turn: TraceTurn = { question: question.trim(), text: "", state: "running", turnId: null };
  st.card.querySelector(".wiki-trace-note[data-trace-end]")?.remove();
  st.turns.push(turn);
  st.busy = true;
  paintTurns(st);
  const body: Record<string, unknown> = { wiki: st.wiki, traceKey: st.key, question: turn.question, mode: "explore" };
  if (st.discussionId) body.discussionId = st.discussionId;
  const user = st.discussionId && st.userId ? st.userId : ((st.userListed ? st.userId : null) ?? discussUserFor(st.wiki)); // R2
  if (user) body.userId = user;
  const fail = (msg: string) => {
    turn.state = "error";
    turn.text = msg;
  };
  const ctl = new AbortController();
  st.ctl = ctl;
  let busyRead = false;
  const stopWait = whenSlow(() => {
    turn.waiting = true;
    if (live(st)) paintTurns(st);
  });
  const answered = () => {
    stopWait();
    if (!turn.waiting) return;
    turn.waiting = false;
    if (live(st)) paintTurns(st);
  };
  try {
    const res = await fetch(DISCUSS_PATH, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(body), signal: ctl.signal });
    answered();
    if (!res.ok || !res.body) {
      const err = (await res.json().catch(() => null)) as { error?: unknown; reason?: unknown } | null;
      // A turn of the thread still runs (another tab, /chat): show that turn, not this refusal.
      if (res.status === 409 && err?.reason === "busy") busyRead = true;
      else fail(typeof err?.error === "string" ? `${err.error} (${res.status})` : `The turn was refused (${res.status}).`);
    } else {
      const parser = makeSseFrameParser((f) => {
        if (!live(st)) return ctl.abort();
        let m: Record<string, unknown> = {};
        try {
          m = JSON.parse(f.data) as Record<string, unknown>;
        } catch {
          return;
        }
        if (f.event === "turn") {
          if (typeof m.discussionId === "string") st.discussionId = m.discussionId;
          if (typeof m.userId === "string") {
            st.userId = m.userId; // R2
            st.userListed = true;
            adoptDiscussUser(st.wiki, null, m.userId);
          }
          if (typeof m.turnId === "string") turn.turnId = m.turnId;
        } else if (f.event === "status") turn.status = traceStatusFrom(m, turn.status);
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
      if (turn.state === "running" && !ctl.signal.aborted) fail("The turn ended before its answer.");
    }
  } catch {
    if (!ctl.signal.aborted) fail("The turn failed: the server did not answer.");
  }
  answered();
  if (st.ctl === ctl) st.ctl = null;
  st.busy = false;
  if (ctl.signal.aborted || !live(st)) return;
  if (busyRead) {
    st.turns = st.turns.filter((t) => t !== turn);
    paintTurns(st);
    await loadThread(st);
    return;
  }
  paintTurns(st);
}

async function continueInClaudeCode(st: TraceState, _btn: HTMLElement): Promise<void> {
  const last = [...st.turns].reverse().find((t) => t.turnId && t.state !== "running");
  if (!last?.turnId) return;
  const note = (text: string) => traceNote(st, text);
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
  let st: TraceState | null = null;
  const card = d.place(range, inlineCardHtml("trace", key, `<div class="wiki-discuss-status"><span class="spinner"></span><span>Searching the wiki…</span></div>`, null), () => {
    if (st) dropTrace(st);
  });
  if (!card) return null;
  card.setAttribute("data-trace-key", key);
  const state: TraceState = (st = { key, wiki: d.wiki(), card, turns: [], discussionId: null, userId: null, userListed: false, busy: false, ctl: null, poll: null, pollCtl: null, pollFailures: 0, dropped: false });
  openTraces.add(state);
  traces.set(card, state);
  void (async () => {
    const r = await fetchMentions(state.wiki, key);
    const body = card.querySelector(".wiki-sel-card-body");
    // Out for a render of its page counts as here: the card comes back.
    if (!live(state) || !body) return;
    if (!r.ok) {
      body.innerHTML = `<div class="wiki-discuss-error" role="alert">${esc(r.message)}</div>`;
      return;
    }
    const agent = discussAgentOn();
    body.innerHTML = traceBodyHtml(r.body, { currentRelPath: d.relPath(), hrefFor: d.hrefFor, agent });
    paintTurns(state);
    if (agent) await loadThread(state);
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
  // R3: a pick waits for the bot's running Trace turns, and drops each card's thread.
  const ofBot = (bot: string) => [...openTraces].filter((st) => live(st) && discussBotFor(st.wiki) === bot);
  registerDiscussUserViews({
    live: (bot) => ofBot(bot).some((st) => st.busy || st.turns.some((t) => t.state === "running")),
    reset: (bot) => {
      for (const st of ofBot(bot)) {
        Object.assign(st, { discussionId: null, userId: null, userListed: false, turns: [] });
        paintTurns(st);
        void loadThread(st);
      }
    },
  });
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
    void send(st, input?.value ?? "", () => {
      if (input) input.value = "";
    });
  });
  document.addEventListener("input", (e) => {
    const card = (e.target as HTMLElement).closest?.<HTMLElement>(".wiki-sel-card[data-trace-key]");
    const st = card ? traces.get(card) : undefined;
    if (st && (e.target as HTMLElement).matches(".wiki-trace-input")) syncTraceSend(st.card, st.busy);
  });
}
