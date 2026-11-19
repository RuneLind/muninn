/// <reference lib="dom" />
/**
 * Discuss's tab — the fourth tab of the reader's side pane, on wikis with a
 * wiki agent (mimir plan muninn-wiki-discuss, P3; the route is
 * `routes/wiki-discuss.ts`). Not a dialog: a pane body like Ask's.
 *
 * The page payload's `reader.discussAgent` (a `.wiki-agent.md` at the wiki
 * root, the route registered, an admin viewer) shows the tab, through
 * {@link setDiscussAgentEnabled}, which the handoff module calls per page; a
 * read-only wiki never shows it. A turn starts from P1's panel («Ask here», a
 * passage) or from the tab's own box (the whole page first, then a follow-up
 * in the same discussion); the breadcrumb's 💬 Discuss opens the tab here.
 *
 * Each page's discussion lives in {@link discussions}, outside the tab's HTML:
 * the stream writes into its record and the tab is painted from it, so a turn
 * keeps streaming while the reader is on another tab or page. The answer goes
 * through `renderStreamingBody`, the Ask tab's markdown function. A passage
 * chip reveals its passage (`revealRange`: the text itself scrolled into view
 * and highlighted, nothing added to the DOM). It looks first for the reader's
 * own selection, kept in memory with the turn ({@link anchors}): the range
 * while it is still in the article with the same text, then the text it
 * covered as rendered, which a DecisionLog selection needs (the turn's
 * `selection` is in authored order, with list markers the page does not show);
 * last the turn's `selection`. A passage no longer there says so.
 *
 * The controls that call the agent (`#wikiDiscussAskBtn`, `#wikiDiscussInput`,
 * the panel's «Ask here», «Continue in Claude Code») are in the read-only
 * egress selectors and the input in the keydown one; the tab and its body are
 * in `WIKI_READ_SLICE_HIDDEN_SELECTOR`.
 */

import { copyText } from "./copy-path.ts";
import { makeSseFrameParser } from "./client-runtime.ts";
import { revealRange } from "./wiki-hash-target.ts";
import { revealRightPane } from "./wiki-pane-toggle.ts";
import { WIKI_READONLY_INPUT_PLACEHOLDER, wikiReadonlyWikiFlag } from "./wiki-readonly-client.ts";
import {
  applyDiscussFrame,
  discussionLive,
  discussRefusalMessage,
  findPassage,
  newTurn,
  patchDiscussTurns,
  renderedPassageText,
  streamClosed,
  type DiscussPassage,
  type DiscussTurnView,
  type DiscussionView,
} from "./wiki-discuss-state.ts";
import { HANDOFF_QUESTION_MAX } from "../../../wiki/discuss-bounds.ts";
import { DISCUSS_ASK_BTN_ID, DISCUSS_BODY_ID, DISCUSS_INPUT_ID, DISCUSS_TAB } from "./wiki-discuss-tab-view.ts";

export { DISCUSS_ASK_BTN_ID, DISCUSS_BODY_ID, DISCUSS_INPUT_ID, DISCUSS_TAB };
const DISCUSS_PATH = "/api/wiki/discuss";
const CONTINUE_PATH = "/api/wiki/discuss/continue";

export interface DiscussTabDeps {
  /** The served wiki's registry name. */
  wiki(): string;
  /** The open page's relPath, or null off a page. */
  relPath(): string | null;
  /** The shell's tab switch (`switchConnTab`). */
  switchTab(tab: string): void;
}

let deps: DiscussTabDeps | null = null;
let enabled = false;
/** Every page's discussion this session, by wiki and relPath. */
const discussions = new Map<string, DiscussionView>();
let turnSeq = 0;
/** The reader's selection behind each passage turn, by turn key, for this
 *  session only (a reload keeps the stored `selection` and its context):
 *  the range as selected and the text it covered as rendered. */
const anchors = new Map<string, { range: Range; rendered: string }>();
/** The page the box's draft was typed on. */
let draftPage = "";
/** What the box held when it sent a turn, and on which page: the box is
 *  cleared when that turn is accepted, only if it still holds exactly that. */
interface BoxSend {
  text: string;
  page: string;
}
let paintQueued = false;
/** A press is held in the tab: the pane does not follow the stream meanwhile,
 *  or the control under the pointer would move before the release. */
let pressing = false;

const keyOf = (wiki: string, relPath: string) => `${wiki}\n${relPath}`;

function here(): DiscussionView | null {
  const relPath = deps?.relPath();
  if (!deps || !relPath) return null;
  return discussions.get(keyOf(deps.wiki(), relPath)) ?? null;
}

function ensureHere(): DiscussionView | null {
  const relPath = deps?.relPath();
  if (!deps || !relPath) return null;
  const k = keyOf(deps.wiki(), relPath);
  let d = discussions.get(k);
  if (!d) {
    d = { wiki: deps.wiki(), relPath, discussionId: null, turns: [] };
    discussions.set(k, d);
  }
  return d;
}

/** Whether this page offers the tab. */
export function discussAgentOn(): boolean {
  return enabled;
}

/** Per page render: whether the page's wiki has an agent this viewer may use.
 *  Never on a read-only wiki (the route refuses it; the controls are blocked
 *  by the egress selectors as a backstop). Leaving the tab while it is shown
 *  on a page without one goes back to Connections. */
export function setDiscussAgentEnabled(on: boolean): void {
  enabled = on && !wikiReadonlyWikiFlag();
  const tab = document.querySelector<HTMLElement>(`[data-conntab="${DISCUSS_TAB}"]`);
  if (tab) tab.hidden = !enabled;
  const body = document.getElementById(DISCUSS_BODY_ID);
  if (!enabled && tab?.classList.contains("active")) deps?.switchTab("conn");
  // A draft belongs to its page: another page starts with an empty box.
  const page = deps ? `${deps.wiki()}\n${deps.relPath() ?? ""}` : "";
  if (page !== draftPage) {
    draftPage = page;
    const input = body?.querySelector<HTMLTextAreaElement>(`#${DISCUSS_INPUT_ID}`);
    if (input) input.value = "";
  }
  paint();
}

/** Is this wiki read-only right now? Read at every send, independent of
 *  {@link enabled}: the window flag, or the class the read-only guard stamps.
 *  The keydown guard does not cover P1's question box, so this is the
 *  backstop for its ⌘/Ctrl+Enter. */
export function discussSendBlocked(): boolean {
  return wikiReadonlyWikiFlag() || !!document.body?.classList.contains("wiki-readonly-wiki");
}

/** Show the tab (the breadcrumb's 💬 Discuss, «Ask here»), the pane first. */
export function openDiscussTab(focus = false): void {
  if (!enabled || !deps) return;
  revealRightPane();
  deps.switchTab(DISCUSS_TAB);
  paint();
  if (focus) document.getElementById(DISCUSS_INPUT_ID)?.focus();
}

/** «Ask here» from P1's panel: one turn about the passage (or the whole page
 *  when `passage` is null), in this page's discussion. False when nothing was
 *  sent (off, read-only, off a page, or a turn of the discussion still running). */
export function askInDiscuss(question: string, passage: DiscussPassage | null, selected: Range | null = null): boolean {
  return startTurn(question, passage, selected, null);
}

function startTurn(question: string, passage: DiscussPassage | null, selected: Range | null, box: BoxSend | null): boolean {
  if (!enabled || discussSendBlocked()) return false;
  const d = ensureHere();
  if (!d || !question.trim() || discussionLive(d)) return false;
  openDiscussTab();
  void runTurn(d, question.trim(), passage, passage ? selected : null, box);
  return true;
}

/** The turn the box sent was accepted: empty the box, unless the reader has
 *  since typed something else there or moved to another page. */
function clearSentBox(box: BoxSend): void {
  if (draftPage !== box.page) return;
  const input = document.getElementById(DISCUSS_INPUT_ID) as HTMLTextAreaElement | null;
  if (input && input.value === box.text) input.value = "";
}

function paint(): void {
  const body = document.getElementById(DISCUSS_BODY_ID);
  if (!body) return;
  const list = body.querySelector<HTMLElement>(".wiki-discuss-turns");
  const d = here();
  if (list) {
    // Follow the stream while the reader is at the bottom of the pane.
    const atBottom = !pressing && body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    patchDiscussTurns(list, d);
    if (atBottom) body.scrollTop = body.scrollHeight;
  }
  const live = !!d && discussionLive(d);
  const input = body.querySelector<HTMLTextAreaElement>(`#${DISCUSS_INPUT_ID}`);
  const btn = body.querySelector<HTMLButtonElement>(`#${DISCUSS_ASK_BTN_ID}`);
  const started = !!d && d.turns.some((t) => t.turnId !== null);
  // A read-only wiki keeps the boot locks' placeholder: this paint runs on
  // every page render, after `applyWikiReadonlyInputLocks` (it never re-enables the box).
  const readonly = discussSendBlocked();
  if (input) input.placeholder = readonly ? WIKI_READONLY_INPUT_PLACEHOLDER : started ? "Follow up on this discussion…" : "Ask the wiki agent about this page…";
  if (btn) {
    btn.textContent = started ? "Follow up" : "Ask";
    btn.disabled = live;
  }
}

/** Paint at most once a frame: deltas arrive many times a second. */
function schedulePaint(): void {
  if (paintQueued) return;
  paintQueued = true;
  const run = () => {
    paintQueued = false;
    paint();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
}

async function runTurn(d: DiscussionView, question: string, passage: DiscussPassage | null, selected: Range | null, box: BoxSend | null): Promise<void> {
  const turn = newTurn(`t${++turnSeq}`, question, passage);
  if (selected) {
    const range = selected.cloneRange();
    anchors.set(turn.key, { range, rendered: renderedPassageText(range) });
  }
  d.turns.push(turn);
  paint();
  const body: Record<string, unknown> = { wiki: d.wiki, relPath: d.relPath, question };
  if (passage) {
    Object.assign(body, { selection: passage.selection, before: passage.before, after: passage.after, atStart: passage.atStart, atEnd: passage.atEnd, heading: passage.heading });
    if (passage.edge) body.edge = passage.edge;
  }
  if (d.discussionId) body.discussionId = d.discussionId;
  let res: Response;
  try {
    res = await fetch(DISCUSS_PATH, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(body) });
  } catch {
    turn.state = "refused";
    turn.message = "The turn could not start: the server did not answer.";
    schedulePaint();
    return;
  }
  if (!res.ok || !res.body) {
    let data: Record<string, unknown> | null = null;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      data = null;
    }
    turn.state = "refused";
    turn.message = discussRefusalMessage(res.status, data);
    schedulePaint();
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = makeSseFrameParser((frame) => {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(frame.data || "{}") as Record<string, unknown>;
    } catch {
      return;
    }
    const out = applyDiscussFrame(turn, frame.event, data);
    if (out.discussionId && !d.discussionId) d.discussionId = out.discussionId;
    if (frame.event === "turn" && box) {
      clearSentBox(box);
      box = null;
    }
    schedulePaint();
  });
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      parser.push(decoder.decode(chunk.value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } catch {
    /* the connection dropped: streamClosed says so */
  }
  streamClosed(turn);
  schedulePaint();
}

function turnByKey(key: string): DiscussTurnView | null {
  return here()?.turns.find((t) => t.key === key) ?? null;
}

const compactText = (s: string) => s.replace(/\s+/g, "");

/** The chip: reveal the passage in the article as it is now, or say it is gone. */
function revealPassage(key: string): void {
  const t = turnByKey(key);
  if (!t?.passage) return;
  const article = document.querySelector<HTMLElement>("#articleWrap .wiki-article");
  let range: Range | null = null;
  let block: Element | null = null;
  const kept = anchors.get(key);
  if (article && kept) {
    const r = kept.range;
    // Still the reader's selection: in this article, over the same text.
    if (article.contains(r.startContainer) && article.contains(r.endContainer) && compactText(renderedPassageText(r)) === compactText(kept.rendered)) range = r;
    else {
      const f = findPassage(article, kept.rendered, t.passage);
      if (f) [range, block] = [f.range, f.block];
    }
  }
  if (article && !range) {
    const f = findPassage(article, t.passage.selection, t.passage);
    if (f) [range, block] = [f.range, f.block];
  }
  t.passageGone = !range;
  paint();
  if (article && range) revealRange(article, range, block);
}

async function continueInClaudeCode(key: string): Promise<void> {
  const t = turnByKey(key);
  if (!t?.turnId || t.handover?.state === "busy") return;
  t.handover = { state: "busy", note: "Building the prompt…" };
  paint();
  let prompt: string | null = null;
  try {
    const res = await fetch(CONTINUE_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turnId: t.turnId }) });
    const data = (await res.json().catch(() => null)) as { prompt?: unknown; error?: unknown } | null;
    if (res.ok && typeof data?.prompt === "string") prompt = data.prompt;
    else t.handover = { state: "failed", note: typeof data?.error === "string" ? `${data.error} (${res.status})` : `The prompt could not be built (${res.status}).` };
  } catch {
    t.handover = { state: "failed", note: "The prompt could not be built: the server did not answer." };
  }
  if (prompt === null) {
    paint();
    return;
  }
  const ok = await copyText(prompt);
  t.handover = ok
    ? { state: "done", note: `Copied, ${prompt.length} characters. Paste it into Claude Code.` }
    : { state: "failed", note: "Copy failed. The prompt is below: copy it by hand.", prompt };
  paint();
  if (!ok) {
    const out = document.querySelector<HTMLTextAreaElement>(`[data-turn-key="${key}"] .wiki-discuss-cont-out`);
    out?.focus();
    out?.select();
  }
}

/** The tab's own box: the first question about the whole page, then a
 *  follow-up in the same discussion. The box keeps the question until the
 *  route accepts the turn (its `turn` event), so a refusal leaves it to retry. */
function askFromBox(): void {
  const input = document.getElementById(DISCUSS_INPUT_ID) as HTMLTextAreaElement | null;
  const q = input?.value.trim() ?? "";
  if (!input || !q) return;
  startTurn(q.slice(0, HANDOFF_QUESTION_MAX), null, null, { text: input.value, page: draftPage });
}

/** Wire the tab once, at boot. */
export function initDiscussTab(d: DiscussTabDeps): void {
  deps = d;
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest) return;
    if (t.closest(`#${DISCUSS_ASK_BTN_ID}`)) {
      askFromBox();
      return;
    }
    const chip = t.closest<HTMLElement>("[data-discuss-chip]");
    if (chip) {
      revealPassage(chip.dataset.discussChip ?? "");
      return;
    }
    const cont = t.closest<HTMLElement>("[data-discuss-continue]");
    if (cont) void continueInClaudeCode(cont.dataset.discussContinue ?? "");
  });
  document.addEventListener("pointerdown", (e) => {
    pressing = !!(e.target as HTMLElement).closest?.(`#${DISCUSS_BODY_ID}`);
  }, true);
  for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, () => (pressing = false), true);
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t?.id !== DISCUSS_INPUT_ID || e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    askFromBox();
  });
}
