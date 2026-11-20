/// <reference lib="dom" />
/**
 * Discuss's tab — the fourth tab of the reader's side pane, on wikis with a
 * wiki agent (mimir plan muninn-wiki-discuss, P3; the route is
 * `routes/wiki-discuss.ts`). Not a dialog: a pane body like Ask's.
 *
 * The page payload's `reader.discussAgent` (a `.wiki-agent.md` at the wiki
 * root that the route accepts, the route registered, an admin viewer) shows
 * the tab, through
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
 *
 * A turn that ends `done` with a proposed edit (P4) gets a diff card, fetched
 * from `POST /api/wiki/discuss/apply` by the turn's id while it is the current
 * turn; a newer turn retires it. The card's block in the article is marked
 * ({@link DISCUSS_EDIT_MARK_CLASS}) while the edit is offered. Apply sends the
 * preview's two hashes back and renders the page again; «Change the wording»
 * fills the follow-up box (the reader sends it, and the turn carries the
 * discussion with this edit); Discard drops the card in this tab only. Apply
 * is in the read-only write selectors, «Change the wording» in the egress
 * ones, and both in `WIKI_READ_SLICE_HIDDEN_SELECTOR`.
 */

import { copyText } from "./copy-path.ts";
import { makeSseFrameParser } from "./client-runtime.ts";
import { revealRange } from "./wiki-hash-target.ts";
import { revealRightPane } from "./wiki-pane-toggle.ts";
import { WIKI_READONLY_INPUT_PLACEHOLDER, wikiReadonlyWikiFlag } from "./wiki-readonly-client.ts";
import {
  anchorRange,
  applyDiscussFrame,
  currentTurn,
  discussEditRefusalMessage,
  readEditPreview,
  discussionLive,
  discussRefusalMessage,
  findPassage,
  keepAnchor,
  newTurn,
  patchDiscussTurns,
  streamClosed,
  type DiscussAnchor,
  type DiscussPassage,
  type DiscussTurnView,
  type DiscussionView,
} from "./wiki-discuss-state.ts";
import { HANDOFF_QUESTION_MAX } from "../../../wiki/discuss-bounds.ts";
import { DISCUSS_ASK_BTN_ID, DISCUSS_BODY_ID, DISCUSS_INPUT_ID, DISCUSS_TAB } from "./wiki-discuss-tab-view.ts";

export { DISCUSS_ASK_BTN_ID, DISCUSS_BODY_ID, DISCUSS_INPUT_ID, DISCUSS_TAB };
const DISCUSS_PATH = "/api/wiki/discuss";
const CONTINUE_PATH = "/api/wiki/discuss/continue";
const APPLY_PATH = "/api/wiki/discuss/apply";
/** The class on the article block the current turn's proposed edit would change. */
export const DISCUSS_EDIT_MARK_CLASS = "wiki-discuss-edit-mark";
/** What «Change the wording» puts in the follow-up box. */
export const DISCUSS_REWORD_PROMPT = "Propose another wording for that edit, for the same passage: ";

export interface DiscussTabDeps {
  /** The served wiki's registry name. */
  wiki(): string;
  /** The open page's relPath, or null off a page. */
  relPath(): string | null;
  /** The shell's tab switch (`switchConnTab`). */
  switchTab(tab: string): void;
  /** Fetch and render the open page again, after an Apply wrote it. */
  reload?(): void;
}

let deps: DiscussTabDeps | null = null;
let enabled = false;
/** Every page's discussion this session, by wiki and relPath. */
const discussions = new Map<string, DiscussionView>();
let turnSeq = 0;
/** The reader's selection behind each passage turn, by turn key, for this
 *  session only (a reload keeps the stored `selection` and its context):
 *  its boundaries, held weakly so a re-rendered article is not kept alive,
 *  and the text it covered as rendered. */
const anchors = new Map<string, DiscussAnchor>();
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
/** Where the pane stood when the press began: at its bottom, and its scrollTop. */
let pressFromBottom = false;
let pressTop = 0;
/** The press began at the bottom and the pane was not scrolled meanwhile: the
 *  next paint scrolls to the bottom though the stream grew past the margin. */
let followAfterPress = false;

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
    const atBottom = !pressing && (followAfterPress || body.scrollHeight - body.scrollTop - body.clientHeight < 40);
    patchDiscussTurns(list, d);
    if (atBottom) body.scrollTop = body.scrollHeight;
    if (!pressing) followAfterPress = false;
  }
  syncEditMark(d);
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
  if (selected) anchors.set(turn.key, keepAnchor(selected));
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
  if (turn.state === "done" && turn.proposedEdit && turn.turnId && currentTurn(d) === turn) void previewEdit(turn);
}

/** Fetch the current turn's edit preview from its stored turn id. */
async function previewEdit(t: DiscussTurnView): Promise<void> {
  if (!t.turnId) return;
  t.edit = { state: "loading", preview: null, message: null };
  schedulePaint();
  const r = await postApply({ turnId: t.turnId, preview: true });
  const preview = r.ok ? readEditPreview(r.body) : null;
  t.edit = preview ? { state: "ready", preview, message: null } : { state: r.status === 0 ? "failed" : "refused", preview: null, message: r.status === 0 ? "The preview could not be fetched: the server did not answer." : discussEditRefusalMessage(r.status, r.body) };
  schedulePaint();
}

async function postApply(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(APPLY_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, status: res.status, body: data };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/** Apply: the previewed edit, by turn id and the two hashes the preview gave. */
async function applyEdit(key: string): Promise<void> {
  const d = here();
  const t = turnByKey(key);
  if (!d || !t?.turnId || t.edit?.state !== "ready" || !t.edit.preview || currentTurn(d) !== t || discussSendBlocked()) return;
  const preview = t.edit.preview;
  t.edit = { state: "applying", preview, message: null };
  paint();
  const r = await postApply({ turnId: t.turnId, baseHash: preview.baseHash, previewHash: preview.previewHash });
  if (r.ok && r.body?.ok === true) {
    const uncommitted = r.body.uncommitted === true;
    t.edit = {
      state: "applied",
      preview,
      message: r.body.committed === true ? "Applied to the page, with a log.md entry and a commit." : uncommitted ? "Applied to the page, but the commit failed: the page now has changes no commit holds." : "Applied to the page, with a log.md entry; it was not committed here.",
    };
    paint();
    // The page on screen is the one written: render it again.
    if (deps?.relPath() === d.relPath) deps?.reload?.();
    return;
  }
  t.edit = { state: r.status === 0 ? "ready" : "refused", preview, message: r.status === 0 ? "Apply could not reach the server; nothing was written." : discussEditRefusalMessage(r.status, r.body) };
  paint();
}

/** «Change the wording»: the follow-up box asks for another wording; the reader sends it. */
function rewordEdit(key: string): void {
  const t = turnByKey(key);
  const input = document.getElementById(DISCUSS_INPUT_ID) as HTMLTextAreaElement | null;
  if (!t || !input || discussSendBlocked()) return;
  input.value = DISCUSS_REWORD_PROMPT;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function discardEdit(key: string): void {
  const t = turnByKey(key);
  if (!t?.edit || t.edit.state === "applying" || t.edit.state === "applied") return;
  t.edit = { state: "discarded", preview: null, message: null };
  paint();
}

/** Mark the article block the current turn's ready edit would change; clear any other mark. */
function syncEditMark(d: DiscussionView | null): void {
  const article = document.querySelector<HTMLElement>("#articleWrap .wiki-article");
  const cur = d ? currentTurn(d) : null;
  const want = cur?.edit?.state === "ready" || cur?.edit?.state === "applying" ? cur.edit.preview?.markText ?? "" : "";
  const marked = Array.from(document.querySelectorAll<HTMLElement>(`.${DISCUSS_EDIT_MARK_CLASS}`));
  if (!want || !article) {
    for (const el of marked) el.classList.remove(DISCUSS_EDIT_MARK_CLASS);
    return;
  }
  if (marked.length === 1 && article.contains(marked[0]!) && marked[0]!.dataset.discussMark === want) return;
  for (const el of marked) el.classList.remove(DISCUSS_EDIT_MARK_CLASS);
  const found = findPassage(article, want);
  const block = (found ? (found.block ?? found.node.parentElement) : null) as HTMLElement | null;
  if (block && block !== article) {
    block.classList.add(DISCUSS_EDIT_MARK_CLASS);
    block.dataset.discussMark = want;
  }
}

function turnByKey(key: string): DiscussTurnView | null {
  return here()?.turns.find((t) => t.key === key) ?? null;
}

/** The chip: reveal the passage in the article as it is now, or say it is gone. */
function revealPassage(key: string): void {
  const t = turnByKey(key);
  if (!t?.passage) return;
  const article = document.querySelector<HTMLElement>("#articleWrap .wiki-article");
  let range: Range | null = null;
  let block: Element | null = null;
  const kept = anchors.get(key);
  if (article && kept) {
    // Still the reader's selection (in this article, over the same text), else its rendered text.
    range = anchorRange(kept, article);
    if (!range) {
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

/** The press is over: a press that began at the bottom, with the pane not
 *  scrolled since, follows the stream again (it grew meanwhile, past the
 *  40 px margin); the paint is scheduled for a stream that ended meanwhile. */
function endPress(): void {
  if (!pressing) return;
  pressing = false;
  const body = document.getElementById(DISCUSS_BODY_ID);
  followAfterPress = pressFromBottom && !!body && Math.abs(body.scrollTop - pressTop) < 2;
  if (followAfterPress) schedulePaint();
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
    if (cont) {
      void continueInClaudeCode(cont.dataset.discussContinue ?? "");
      return;
    }
    const apply = t.closest<HTMLElement>("[data-discuss-apply]");
    if (apply) {
      void applyEdit(apply.dataset.discussApply ?? "");
      return;
    }
    const reword = t.closest<HTMLElement>("[data-discuss-reword]");
    if (reword) {
      rewordEdit(reword.dataset.discussReword ?? "");
      return;
    }
    const discard = t.closest<HTMLElement>("[data-discuss-discard]");
    if (discard) discardEdit(discard.dataset.discussDiscard ?? "");
  });
  document.addEventListener("pointerdown", (e) => {
    const body = document.getElementById(DISCUSS_BODY_ID);
    pressing = !!body && !!(e.target as HTMLElement).closest?.(`#${DISCUSS_BODY_ID}`);
    if (!pressing || !body) return;
    pressFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    pressTop = body.scrollTop;
  }, true);
  // A press may end with no pointerup: a context menu takes the release, and so
  // can the window losing focus (a native drag ends the press with pointercancel).
  for (const type of ["pointerup", "pointercancel", "contextmenu"]) document.addEventListener(type, endPress, true);
  window.addEventListener("blur", endPress);
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t?.id !== DISCUSS_INPUT_ID || e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    askFromBox();
  });
}
