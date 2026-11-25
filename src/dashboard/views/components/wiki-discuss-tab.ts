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
 * turn; a newer turn retires it. The text the edit replaces is painted with
 * the CSS highlight {@link DISCUSS_EDIT_MARK_HIGHLIGHT} (no element added, so
 * the text nodes the chips' anchors hold stay as rendered; a closed Fold
 * around it is opened) while the edit is offered. Apply sends the
 * preview's two hashes back and renders the page again, keeping the tab and
 * moving the reader to the applied note and the changed passage. A transient
 * refusal (another writer, uncommitted changes, a Gardener card, a server
 * error) keeps Apply; `stale`/`changed` and a failed preview offer «Preview
 * again» (fresh hashes); a lost Apply answer previews the turn again to learn
 * whether it wrote, never claiming it did not; «Change the wording» puts
 * its prompt ahead of any draft in the follow-up box (the reader sends it,
 * and the turn carries the discussion with this edit); Discard drops the
 * card in this tab only. Apply
 * is in the read-only write selectors, «Change the wording» in the egress
 * ones, and both in `WIKI_READ_SLICE_HIDDEN_SELECTOR`.
 *
 * Discuss v2 (PR 4, mimir plan muninn-wiki-discuss-v2): the discussion is the
 * page's wiki thread. When the tab is shown (or a turn starts) the tab reads
 * `GET /api/wiki/discuss/thread` once per page per session: the live thread's
 * turns join the ones streamed here (by turn id), the bot and user give
 * «Pop out ↗» (`/chat?…&src=wiki`), and the closed threads and old one-shot
 * turns fill «Earlier discussions». The user is the one the route resolved;
 * it is kept per bot in localStorage (`muninn-discuss-user-<bot>`) once a
 * thread holds it (or the reader picked it after a `no-user` refusal) and sent
 * with every turn and read afterwards, so /chat's default-user dropdown never
 * moves the page's thread. The Explore/Edit toggle sets the next turn's
 * `mode`; «Start over» closes the live thread (it moves under «Earlier
 * discussions»), and an earlier thread's Delete is /chat's thread delete.
 */

import { copyText } from "./copy-path.ts";
import { escHtml } from "./escape.ts";
import { makeSseFrameParser } from "./client-runtime.ts";
import { revealRange } from "./wiki-hash-target.ts";
import { revealRightPane } from "./wiki-pane-toggle.ts";
import { WIKI_READONLY_INPUT_PLACEHOLDER, wikiReadonlyWikiFlag } from "./wiki-readonly-client.ts";
import {
  anchorRange,
  applyDiscussFrame,
  DISCUSS_REWORD_PROMPT,
  appliedEditTarget,
  editMarkHolds,
  editMarkTarget,
  editMarkWords,
  openFoldsAround,
  rewordDraft,
  currentTurn,
  discussEarlierHtml,
  discussPopOutHref,
  discussUserPickHtml,
  dropStoredCopy,
  mergeThreadTurns,
  turnsFromThread,
  type EarlierDiscussions,
  type StoredThreadMessage,
  applyAnswerLost,
  editAfterApplyRefusal,
  editAfterLostApply,
  editAfterPreviewFailure,
  readEditPreview,
  discussionLive,
  discussRefusalMessage,
  findPassage,
  keepAnchor,
  newTurn,
  patchDiscussTurns,
  streamClosed,
  type DiscussAnchor,
  type DiscussEditPreview,
  type DiscussPassage,
  type DiscussTurnView,
  type DiscussionView,
} from "./wiki-discuss-state.ts";
import { HANDOFF_QUESTION_MAX } from "../../../wiki/discuss-bounds.ts";
import { DISCUSS_ASK_BTN_ID, DISCUSS_BODY_ID, DISCUSS_INPUT_ID, DISCUSS_POPOUT_ID, DISCUSS_START_OVER_ID, DISCUSS_TAB } from "./wiki-discuss-tab-view.ts";

export { DISCUSS_ASK_BTN_ID, DISCUSS_BODY_ID, DISCUSS_INPUT_ID, DISCUSS_TAB };
const DISCUSS_PATH = "/api/wiki/discuss";
const CONTINUE_PATH = "/api/wiki/discuss/continue";
const APPLY_PATH = "/api/wiki/discuss/apply";
const THREAD_PATH = "/api/wiki/discuss/thread";
const CLOSE_PATH = "/api/wiki/discuss/thread/close";
/** The wiki's bot as the last thread read named it, and each bot's user once
 *  a thread holds it (or the reader picked it). */
const botKey = (wiki: string) => `muninn-discuss-bot-${wiki}`;
const userKey = (bot: string) => `muninn-discuss-user-${bot}`;

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the route's default user answers instead */
  }
}
/** The CSS highlight (`::highlight(…)`) on the text the current turn's proposed edit would replace. */
export const DISCUSS_EDIT_MARK_HIGHLIGHT = "wiki-discuss-edit-mark";
export { DISCUSS_REWORD_PROMPT };

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
/** The edit mark now: for which turn's preview (turn key and preview hash),
 *  in which article, over which range (null: not found there) and the words
 *  that range covered when it was found. */
let editMark: { want: string; article: Element; range: Range | null; words: string } | null = null;
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
/** A turn was just sent: the next paint scrolls to the bottom, wherever the
 *  pane stood (the bar and «Earlier discussions» sit above the turns, so a
 *  short pane can start past the follow margin). */
let followSend = false;
/** An Apply wrote this page while the tab was shown (an inline card's Apply
 *  shows it first), and the page is rendered
 *  again: that render keeps the tab, then shows the reader the applied card and
 *  the changed passage. Cleared by the render, or by leaving the page. */
let afterApply: { page: string; key: string } | null = null;
/** Each preview request's number, per turn key: an older answer arriving late
 *  never replaces a newer preview's hashes. */
const previewSeq = new Map<string, number>();

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
    d = { wiki: deps.wiki(), relPath, discussionId: null, turns: [], mode: "explore" };
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
  // A draft belongs to its page: another page starts with an empty box.
  const page = deps ? `${deps.wiki()}\n${deps.relPath() ?? ""}` : "";
  if (afterApply && afterApply.page !== page) afterApply = null;
  if (!enabled && tab?.classList.contains("active")) {
    // A page render turns the tab off first and on again once its payload is
    // read, in the same task; after an Apply that off must not leave the tab.
    // A render that never turns it on (a failed load) leaves it then.
    if (afterApply) {
      queueMicrotask(() => {
        if (enabled) return;
        afterApply = null;
        if (tab.classList.contains("active")) deps?.switchTab("conn");
      });
    } else deps?.switchTab("conn");
  }
  if (page !== draftPage) {
    draftPage = page;
    const input = body?.querySelector<HTMLTextAreaElement>(`#${DISCUSS_INPUT_ID}`);
    if (input) input.value = "";
  }
  if (enabled && tab?.classList.contains("active")) maybeLoad();
  paint();
  // The render's later enhancements (the ref links) replace text nodes the
  // mark's range may sit in: the mark is checked again once they have run.
  if (enabled) afterRender(() => syncEditMark(here()));
  if (enabled && afterApply) {
    const shown = afterApply;
    afterApply = null;
    // After the rest of the render (its enhancements and its scroll to the top).
    afterRender(() => revealApplied(shown.key));
  }
}

function afterRender(run: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
}

/** After an Apply's render: the changed passage scrolled into view in the
 *  article, and focus on the applied card's note. */
function revealApplied(key: string): void {
  const t = turnByKey(key);
  const p = t?.edit?.state === "applied" ? t.edit.preview : null;
  if (!p) return;
  const article = document.querySelector<HTMLElement>("#articleWrap .wiki-article");
  const found = article && p.after.trim() ? appliedEditTarget(article, p) : null;
  if (article && found) revealRange(article, found.range, found.block);
  document.querySelector<HTMLElement>(`#${DISCUSS_BODY_ID} [data-turn-key="${CSS.escape(key)}"] .wiki-discuss-edit-done`)?.focus();
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
  maybeLoad();
  paint();
  if (focus) document.getElementById(DISCUSS_INPUT_ID)?.focus();
}

/** «Ask here» from P1's panel: one turn about the passage (or the whole page
 *  when `passage` is null), in this page's discussion. False when nothing was
 *  sent (off, read-only, off a page, or a turn of the discussion still running). */
export function askInDiscuss(question: string, passage: DiscussPassage | null, selected: Range | null = null): boolean {
  return startTurn(question, passage, selected, null) !== null;
}

/**
 * The selection menu's turn (Discuss v2 PR 5, D3): one turn of this page's
 * thread about `passage`, answered in an inline card under the paragraph.
 * It is the same turn record the pane draws (one turn, never a copy), sent
 * through the pane's own entry with `mode` for this turn only (the toggle is
 * left as the reader set it), and the pane is not opened. The card draws it
 * through {@link discussTurnForCard} and repaints on {@link onDiscussChange}.
 * A refusal before the request says why, in the words the panel uses.
 */
export function startInlineTurn(question: string, passage: DiscussPassage, selected: Range | null, mode: "explore" | "edit"): { key: string } | { refused: string } {
  if (!enabled) return { refused: "This wiki has no wiki agent here." };
  if (discussSendBlocked()) return { refused: "This wiki is read-only: nothing on it is sent to a model." };
  const d = ensureHere();
  if (d && discussionLive(d)) return { refused: "This page's discussion has a turn still running: ask when it has ended." };
  const key = startTurn(question, passage, selected, null, { mode, openPane: false });
  return key ? { key } : { refused: "The turn could not start here." };
}

/** The turn an inline card draws, by key, in the open page's discussion;
 *  `current` decides whether its edit card is offered. Null once the turn is
 *  gone (Start over, another page). */
export function discussTurnForCard(key: string): { turn: DiscussTurnView; current: boolean } | null {
  const d = here();
  const t = d?.turns.find((x) => x.key === key) ?? null;
  return d && t ? { turn: t, current: currentTurn(d) === t } : null;
}

/** «Open in Discuss →» on an inline card: the pane on this page's thread,
 *  scrolled to the turn. */
export function showTurnInDiscuss(key: string): void {
  openDiscussTab();
  afterRender(() => document.querySelector<HTMLElement>(`#${DISCUSS_BODY_ID} [data-turn-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" }));
}

/** Called after every state change the tab paints (a stream frame, a preview,
 *  an Apply), whether or not the tab is on screen: the inline cards repaint
 *  from it. Returns the unsubscribe. */
const changeListeners = new Set<() => void>();
export function onDiscussChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/** Start a turn of this page's discussion: its key, or null when nothing was
 *  sent (off, read-only, off a page, or a turn still running). The pane opens
 *  unless `openPane` is false (the selection menu's inline card). */
function startTurn(question: string, passage: DiscussPassage | null, selected: Range | null, box: BoxSend | null, opts: { mode?: "explore" | "edit"; openPane?: boolean } = {}): string | null {
  if (!enabled || discussSendBlocked()) return null;
  const d = ensureHere();
  if (!d || !question.trim() || discussionLive(d)) return null;
  if (opts.openPane !== false) openDiscussTab();
  maybeLoad();
  const key = `t${++turnSeq}`;
  void runTurn(d, key, question.trim(), passage, passage ? selected : null, box, opts.mode);
  return key;
}

/** The turn the box sent was accepted: empty the box, unless the reader has
 *  since typed something else there or moved to another page. */
function clearSentBox(box: BoxSend): void {
  if (draftPage !== box.page) return;
  const input = document.getElementById(DISCUSS_INPUT_ID) as HTMLTextAreaElement | null;
  if (input && input.value === box.text) input.value = "";
}

function paint(): void {
  for (const fn of changeListeners) fn();
  const body = document.getElementById(DISCUSS_BODY_ID);
  if (!body) return;
  const list = body.querySelector<HTMLElement>(".wiki-discuss-turns");
  const d = here();
  const live = !!d && discussionLive(d);
  // Follow the stream while the reader is at the bottom of the pane: read
  // before anything is drawn, and scroll after all of it (the bar, the user
  // picker and «Earlier discussions» change the pane's height too).
  const atBottom = !pressing && (followAfterPress || followSend || body.scrollHeight - body.scrollTop - body.clientHeight < 40);
  followSend = false;
  paintBar(body, d, live);
  if (list) {
    patchDiscussTurns(list, d);
    if (atBottom) body.scrollTop = body.scrollHeight;
    if (!pressing) followAfterPress = false;
  }
  syncEditMark(d);
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

async function runTurn(d: DiscussionView, key: string, question: string, passage: DiscussPassage | null, selected: Range | null, box: BoxSend | null, mode?: "explore" | "edit"): Promise<void> {
  const turn = newTurn(key, question, passage);
  noteActionError(d, null);
  if (selected) anchors.set(turn.key, keepAnchor(selected));
  d.turns.push(turn);
  followSend = true;
  paint();
  const body: Record<string, unknown> = { wiki: d.wiki, relPath: d.relPath, question };
  if (passage) {
    Object.assign(body, { selection: passage.selection, before: passage.before, after: passage.after, atStart: passage.atStart, atEnd: passage.atEnd, heading: passage.heading });
    if (passage.edge) body.edge = passage.edge;
  }
  if (d.discussionId) body.discussionId = d.discussionId;
  body.mode = mode ?? d.mode ?? "explore";
  const user = sendUser(d);
  if (user) body.userId = user;
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
    noteUserRefusal(d, data);
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
    if (frame.event === "turn") {
      dropStoredCopy(d, turn);
      if (typeof data.userId === "string") keepUser(d, data.userId);
    }
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

/** Fetch the current turn's edit preview from its stored turn id: when the
 *  turn ends, and again from «Preview again» (the hashes it answers replace
 *  the card's; an answer to an older request is dropped). */
async function previewEdit(t: DiscussTurnView): Promise<void> {
  if (!t.turnId) return;
  const seq = (previewSeq.get(t.key) ?? 0) + 1;
  previewSeq.set(t.key, seq);
  t.edit = { state: "loading", preview: null, message: null };
  schedulePaint();
  const r = await postApply({ turnId: t.turnId, preview: true });
  if (previewSeq.get(t.key) !== seq || t.edit?.state !== "loading") return;
  const preview = r.ok ? readEditPreview(r.body) : null;
  t.edit = preview ? { state: "ready", preview, message: null } : editAfterPreviewFailure(r.status, r.body);
  schedulePaint();
}

/** «Preview again» / «Check again» on a card that holds no Apply. `offPane`:
 *  pressed on an inline card in the article, not in the tab. */
function retryEdit(key: string, offPane = false): void {
  const d = here();
  const t = turnByKey(key);
  const e = t?.edit;
  if (!d || !t || !e?.retry || (e.state !== "refused" && e.state !== "failed") || currentTurn(d) !== t || discussSendBlocked()) return;
  if (e.retry === "lost") void settleLostApply(d, t, e.preview ?? null, offPane);
  else void previewEdit(t);
}

/** Apply's answer was lost: preview the same turn again to learn whether it
 *  wrote ({@link editAfterLostApply}); `shown` is the preview Apply sent. */
async function settleLostApply(d: DiscussionView, t: DiscussTurnView, shown: DiscussEditPreview | null, offPane: boolean): Promise<void> {
  const preview = shown ?? lostPreview.get(t.key) ?? null;
  if (!t.turnId || !preview) return;
  lostPreview.set(t.key, preview);
  t.edit = { state: "applying", preview, message: "Apply's answer did not arrive: checking whether it wrote…" };
  paint();
  const r = await postApply({ turnId: t.turnId, preview: true });
  const out = editAfterLostApply(preview, r);
  t.edit = out.edit;
  if (out.edit.retry !== "lost") lostPreview.delete(t.key);
  finishApply(d, t, out.reload, offPane);
}

/** The preview a lost Apply sent, kept while «Check again» is offered. */
const lostPreview = new Map<string, DiscussEditPreview>();

/** Paint the card; render the page again when it reads as written, keeping
 *  the reader on the tab when it is the one shown. An Apply from an inline
 *  card (`offPane`) opens the tab first: the render removes the card, so the
 *  outcome is shown on the pane's turn, as a pane Apply ends. */
function finishApply(d: DiscussionView, t: DiscussTurnView, reload: boolean, offPane = false): void {
  paint();
  if (!reload || !deps || deps.relPath() !== d.relPath) return;
  if (offPane) openDiscussTab();
  const tab = document.querySelector<HTMLElement>(`[data-conntab="${DISCUSS_TAB}"]`);
  if (tab?.classList.contains("active")) afterApply = { page: `${deps.wiki()}\n${d.relPath}`, key: t.key };
  deps.reload?.();
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
async function applyEdit(key: string, offPane = false): Promise<void> {
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
    // The page on screen is the one written: render it again.
    finishApply(d, t, true, offPane);
    return;
  }
  // No answer, a success whose body did not arrive whole, or a gateway's 5xx:
  // the request may have written, so ask the route rather than claim either way.
  if (applyAnswerLost(r)) {
    await settleLostApply(d, t, preview, offPane);
    return;
  }
  t.edit = editAfterApplyRefusal(preview, r.status, r.body);
  paint();
}

/** «Change the wording»: the follow-up box asks for another wording, ahead of
 *  any draft the reader had typed; the reader sends it. The box is in the tab:
 *  from an inline card (`offPane`) the tab is shown first. */
function rewordEdit(key: string, offPane = false): void {
  const t = turnByKey(key);
  if (!t || discussSendBlocked()) return;
  if (offPane) openDiscussTab();
  const input = document.getElementById(DISCUSS_INPUT_ID) as HTMLTextAreaElement | null;
  if (!input) return;
  input.value = rewordDraft(input.value);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function discardEdit(key: string): void {
  const t = turnByKey(key);
  if (!t?.edit || t.edit.state === "applying" || t.edit.state === "applied") return;
  t.edit = { state: "discarded", preview: null, message: null };
  paint();
}

/** Paint the text the current turn's ready edit would replace (opening a
 *  closed Fold around it); take the paint off on any other state, turn or
 *  page. A target found, or not found, in this article is not searched again
 *  while its range still covers the words it was found on; one a later text
 *  node replacement broke is found again, and its Folds are left as the
 *  reader has them (a Fold the reader closed stays closed). */
function syncEditMark(d: DiscussionView | null): void {
  const article = document.querySelector<HTMLElement>("#articleWrap .wiki-article");
  const cur = d ? currentTurn(d) : null;
  const p = cur?.edit?.state === "ready" || cur?.edit?.state === "applying" ? cur.edit.preview : null;
  const want = p && cur ? `${cur.key}\n${p.previewHash}` : "";
  const same = !!editMark && !!article && editMark.want === want && editMark.article === article;
  if (same && (!editMark!.range || editMarkHolds(article!, editMark!.range, editMark!.words))) return;
  editMark = null;
  const found = p && article ? editMarkTarget(article, p) : null;
  if (p && article) editMark = { want, article, range: found?.range ?? null, words: found ? editMarkWords(found.range) : "" };
  if (found && article && !same) openFoldsAround(article, found.node);
  paintEditMark(found?.range ?? null);
}

/** The edit mark through the CSS Custom Highlight API; without it, no mark. */
function paintEditMark(range: Range | null): void {
  const registry = (globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const Highlight = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!registry || !Highlight) return;
  if (range) registry.set(DISCUSS_EDIT_MARK_HIGHLIGHT, new Highlight(range));
  else registry.delete(DISCUSS_EDIT_MARK_HIGHLIGHT);
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

// ── The page's thread (Discuss v2, PR 4) ─────────────────────────────────

/** The user a turn or a read sends: only one kept for the wiki's bot, which a
 *  thread holds or the reader picked (so /chat lists it and the route takes
 *  it). Otherwise none, and the route uses the bot's default user. */
function sendUser(d: DiscussionView): string | null {
  const bot = d.bot ?? lsGet(botKey(d.wiki));
  return bot ? lsGet(userKey(bot)) : null;
}

/** A thread now holds `userId` (a turn was accepted, or the read found one):
 *  keep it for the wiki's bot. */
function keepUser(d: DiscussionView, userId: string): void {
  d.userId = userId;
  const bot = d.bot ?? lsGet(botKey(d.wiki));
  if (bot) lsSet(userKey(bot), userId);
}

/** The route named the wiki's bot (a thread read or a refusal): kept for the
 *  wiki, so a later session sends the user kept for that bot. */
function learnBot(d: DiscussionView, bot: string): void {
  d.bot = bot;
  lsSet(botKey(d.wiki), bot);
}

/** A `no-user`/`unknown-user` refusal: drop a kept user the route no longer
 *  lists, and offer the users it named. */
function noteUserRefusal(d: DiscussionView, data: Record<string, unknown> | null): void {
  const reason = data?.reason;
  if (reason !== "no-user" && reason !== "unknown-user") return;
  if (typeof data?.bot === "string") learnBot(d, data.bot);
  if (reason === "unknown-user") {
    const bot = d.bot ?? lsGet(botKey(d.wiki));
    if (bot) lsSet(userKey(bot), null);
  }
  const users = Array.isArray(data?.users)
    ? (data.users as { id?: unknown; name?: unknown }[]).filter((u) => typeof u?.id === "string").map((u) => ({ id: u.id as string, name: typeof u.name === "string" ? u.name : (u.id as string) }))
    : [];
  d.userPick = {
    users,
    message: users.length
      ? "Pick the user this page's discussion belongs to (it is kept in this browser)."
      : `No chat user is set up for this wiki's bot${d.bot ? ` (${d.bot})` : ""}: add one in /chat, then reload the page.`,
  };
}

/** Read the thread once per page per session, when the tab is shown or a turn starts. */
function maybeLoad(): void {
  const d = ensureHere();
  if (d && !d.load) void loadThread(d);
}

async function getThread(d: DiscussionView, user: string | null): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
  const q = new URLSearchParams({ relPath: d.relPath });
  if (d.wiki) q.set("wiki", d.wiki);
  if (user) q.set("userId", user);
  try {
    const res = await fetch(`${THREAD_PATH}?${q.toString()}`, { headers: { Accept: "application/json" } });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/** Each discussion's newest thread read: a read applies its result only while
 *  it is still the newest, so one that started before «Start over», a delete
 *  or a user pick (each starts a new read) never lands over the reset. */
const readGen = new WeakMap<DiscussionView, number>();

async function loadThread(d: DiscussionView): Promise<void> {
  if (d.load === "loading") return;
  d.load = "loading";
  const gen = (readGen.get(d) ?? 0) + 1;
  readGen.set(d, gen);
  const stale = () => readGen.get(d) !== gen;
  const cachedBot = d.bot ?? lsGet(botKey(d.wiki));
  const kept = sendUser(d);
  let r = await getThread(d, kept);
  if (stale()) return;
  if (kept && r.status === 422 && r.body?.reason === "unknown-user") {
    if (cachedBot) lsSet(userKey(cachedBot), null);
    r = await getThread(d, null);
    if (stale()) return;
  }
  // The wiki answers on another bot than last time: that bot's kept user, if any.
  const bot = r.ok && typeof r.body?.bot === "string" ? r.body.bot : null;
  if (bot) learnBot(d, bot);
  if (bot && bot !== cachedBot) {
    const forBot = lsGet(userKey(bot));
    if (forBot && forBot !== r.body?.userId) {
      const again = await getThread(d, forBot);
      if (stale()) return;
      if (again.ok) r = again;
      else if (again.body?.reason === "unknown-user") lsSet(userKey(bot), null);
    }
  }
  if (r.ok && r.body) {
    const b = r.body;
    d.bot = typeof b.bot === "string" ? b.bot : (d.bot ?? null);
    d.userPick = null;
    d.loadError = null;
    const thread = b.thread as { id?: unknown } | null;
    const threadId = thread && typeof thread.id === "string" ? thread.id : null;
    if (typeof b.userId === "string") {
      if (threadId) keepUser(d, b.userId);
      else d.userId = d.userId ?? b.userId;
    }
    mergeThreadTurns(d, threadId, turnsFromThread(Array.isArray(b.messages) ? (b.messages as StoredThreadMessage[]) : []));
    d.earlier = {
      closed: Array.isArray(b.closed) ? (b.closed as EarlierDiscussions["closed"]) : [],
      closedTotal: typeof b.closedTotal === "number" ? b.closedTotal : undefined,
      oneShot: Array.isArray(b.oneShot) ? (b.oneShot as EarlierDiscussions["oneShot"]) : [],
    };
    d.load = "done";
    // A read-back current turn with an edit not yet applied: its card, as a streamed turn gets.
    const cur = currentTurn(d);
    if (cur && cur.state === "done" && cur.proposedEdit && !cur.edit && cur.turnId) void previewEdit(cur);
  } else {
    d.load = "failed";
    noteUserRefusal(d, r.body);
    if (!d.userPick) {
      d.loadError =
        r.status === 0
          ? "The page's discussion could not be read: the server did not answer."
          : `The page's discussion could not be read${typeof r.body?.error === "string" ? `: ${r.body.error}` : ""} (${r.status}).`;
    }
  }
  schedulePaint();
}

/** Read the page's thread again (after Start over, a delete or a user pick). */
function reloadThread(d: DiscussionView): void {
  d.load = undefined;
  void loadThread(d);
}

/** «Start over» or a Delete failed: shown until the reader's next action
 *  (a thread read after it leaves it, unlike a read failure). */
function noteActionError(d: DiscussionView, message: string | null): void {
  d.actionError = message;
}

/** The bar (mode, «Pop out ↗», «Start over»), the user picker and «Earlier
 *  discussions»: each drawn only when its markup changed, so an open
 *  `<details>` or a focused select survives the stream's repaints. */
function paintBar(body: HTMLElement, d: DiscussionView | null, live: boolean): void {
  const mode = d?.mode ?? "explore";
  for (const b of Array.from(body.querySelectorAll<HTMLButtonElement>("[data-discuss-mode]"))) b.setAttribute("aria-pressed", String(b.dataset.discussMode === mode));
  const pop = body.querySelector<HTMLAnchorElement>(`#${DISCUSS_POPOUT_ID}`);
  const href = discussPopOutHref(d);
  if (pop) {
    pop.hidden = !href;
    if (href && pop.getAttribute("href") !== href) pop.setAttribute("href", href);
  }
  const over = body.querySelector<HTMLButtonElement>(`#${DISCUSS_START_OVER_ID}`);
  if (over) {
    over.hidden = !d?.discussionId;
    over.disabled = live;
  }
  const userEl = body.querySelector<HTMLElement>(".wiki-discuss-user");
  if (userEl) {
    const html =
      (d?.actionError ? `<div class="wiki-discuss-hint">${escHtml(d.actionError)}</div>` : "") +
      (d?.userPick ? discussUserPickHtml(d.userPick) : d?.loadError ? `<div class="wiki-discuss-hint">${escHtml(d.loadError)}</div>` : "");
    if (userEl.dataset.drawn !== html) {
      userEl.innerHTML = html;
      userEl.dataset.drawn = html;
    }
    userEl.hidden = !html;
  }
  const earlierEl = body.querySelector<HTMLElement>(".wiki-discuss-earlier-wrap");
  if (earlierEl) {
    const html = discussEarlierHtml(d?.earlier);
    if (earlierEl.dataset.drawn !== html) {
      const wasOpen = !!earlierEl.querySelector("details[open]");
      earlierEl.innerHTML = html;
      earlierEl.dataset.drawn = html;
      const det = earlierEl.querySelector<HTMLDetailsElement>("details");
      if (det && wasOpen) det.open = true;
    }
  }
}

function setMode(mode: string): void {
  const d = ensureHere();
  if (!d || (mode !== "explore" && mode !== "edit")) return;
  d.mode = mode;
  paint();
}

/** «Start over»: close the live thread; it moves under «Earlier discussions»
 *  and the next turn starts a new one. Not while a turn runs. */
async function startOver(): Promise<void> {
  const d = here();
  if (!d?.discussionId || discussionLive(d) || discussSendBlocked()) return;
  const threadId = d.discussionId;
  noteActionError(d, null);
  let ok = false;
  let error = "";
  try {
    const res = await fetch(CLOSE_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId }) });
    ok = res.ok;
    if (!ok) error = ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `status ${res.status}`;
  } catch {
    error = "the server did not answer";
  }
  // A thread already closed elsewhere is just as gone from this page.
  if (!ok && !/no live wiki thread/.test(error)) {
    noteActionError(d, `Start over failed: ${error}.`);
    paint();
    return;
  }
  for (const t of d.turns) anchors.delete(t.key);
  d.turns = [];
  d.discussionId = null;
  reloadThread(d);
  paint();
}

/** Delete an earlier (closed) thread with its turns: /chat's thread delete. */
async function deleteEarlier(threadId: string): Promise<void> {
  const d = here();
  if (!d || !threadId || discussSendBlocked()) return;
  if (typeof confirm === "function" && !confirm("Delete this earlier discussion and its turns?")) return;
  noteActionError(d, null);
  try {
    const res = await fetch(`/chat/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
    // 404: already gone (deleted in another tab), as «Start over» treats a thread closed elsewhere.
    if (!res.ok && res.status !== 404) noteActionError(d, `The discussion could not be deleted (${res.status}).`);
  } catch {
    noteActionError(d, "The discussion could not be deleted: the server did not answer.");
  }
  reloadThread(d);
}

/** The picker's choice: kept for the bot, then the thread is read for that user. */
function pickUser(): void {
  const d = here();
  const sel = document.querySelector<HTMLSelectElement>(`#${DISCUSS_BODY_ID} .wiki-discuss-user-select`);
  if (!d || !sel?.value) return;
  const bot = d.bot ?? lsGet(botKey(d.wiki));
  if (bot) lsSet(userKey(bot), sel.value);
  d.userId = sel.value;
  d.userPick = null;
  noteActionError(d, null);
  reloadThread(d);
  paint();
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
    // The shell switches to the tab on this click: read the page's thread once it shows.
    if (t.closest(`[data-conntab="${DISCUSS_TAB}"]`)) {
      afterRender(() => {
        if (!enabled) return;
        maybeLoad();
        paint();
      });
      return;
    }
    const mode = t.closest<HTMLElement>("[data-discuss-mode]");
    if (mode) {
      setMode(mode.dataset.discussMode ?? "");
      return;
    }
    if (t.closest(`#${DISCUSS_START_OVER_ID}`)) {
      void startOver();
      return;
    }
    const del = t.closest<HTMLElement>("[data-discuss-delete-thread]");
    if (del) {
      void deleteEarlier(del.dataset.discussDeleteThread ?? "");
      return;
    }
    if (t.closest("[data-discuss-pick-user]")) {
      pickUser();
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
    // The edit card's controls also sit in the selection menu's inline card,
    // outside the tab's body (`offPane`).
    const offPane = (el: HTMLElement) => !el.closest(`#${DISCUSS_BODY_ID}`);
    const apply = t.closest<HTMLElement>("[data-discuss-apply]");
    if (apply) {
      void applyEdit(apply.dataset.discussApply ?? "", offPane(apply));
      return;
    }
    const reword = t.closest<HTMLElement>("[data-discuss-reword]");
    if (reword) {
      rewordEdit(reword.dataset.discussReword ?? "", offPane(reword));
      return;
    }
    const retry = t.closest<HTMLElement>("[data-discuss-repreview]");
    if (retry) {
      retryEdit(retry.dataset.discussRepreview ?? "", offPane(retry));
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
