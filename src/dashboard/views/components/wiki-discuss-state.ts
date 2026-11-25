/**
 * Discuss's tab, the pure half (mimir plan muninn-wiki-discuss, P3): the turn
 * state the tab renders from, how one stream frame moves it, the words for
 * each refusal the route answers, the tab's HTML and where a passage sits in
 * the rendered article. No DOM globals: the article helper takes its nodes'
 * own document, so a test drives it in a happy-dom `Window` of its own.
 *
 * The state lives here, outside the tab's HTML, because the pane re-renders:
 * a turn keeps streaming into its record while the reader is on another page
 * or tab, and the tab paints whatever the record holds when it is shown.
 */

import { escHtml as esc } from "./escape.ts";
import { renderStreamingBody } from "./wiki-ask-render.ts";
import { HANDOFF_CONTEXT_MAX } from "../../../wiki/discuss-bounds.ts";
import { DISCUSS_TEXT_HIDDEN, discussReading } from "./wiki-discuss-text.ts";
import { PEEK_CLASS } from "./wiki-ref-dom.ts";

/** How a turn stands in the tab. `sending` until the route's `turn` event;
 *  `refused` when the route answered a JSON refusal (no row was stored);
 *  `dropped` when the stream closed before the turn ended (the server still
 *  runs it to its end and stores it). */
export type DiscussTurnState = "sending" | "running" | "done" | "error" | "timeout" | "abandoned" | "refused" | "dropped";

/** The passage a turn asks about, as P1's panel read it. */
export interface DiscussPassage {
  selection: string;
  before: string;
  after: string;
  atStart: boolean;
  atEnd: boolean;
  heading: string;
  edge?: "added" | "reordered";
}

export interface DiscussTurnView {
  /** The tab's own key for the turn, set before the route answers. */
  key: string;
  turnId: string | null;
  seq: number | null;
  passage: DiscussPassage | null;
  question: string;
  /** The streamed text so far, replaced by the final answer on `done`. */
  text: string;
  state: DiscussTurnState;
  /** The route's phase (`snapshots`, `card`, `model`) while it runs. */
  phase: string | null;
  tools: string[];
  /** A refusal's or failure's words. */
  message: string | null;
  /** The answer carries a proposed edit (P4 previews and applies it). */
  proposedEdit: boolean;
  /** The proposed edit's preview and Apply (P4), once the tab asked for them. */
  edit: DiscussEditView | null;
  /** «Continue in Claude Code»: where its request stands. */
  handover: { state: "busy" | "done" | "failed"; note: string; prompt?: string } | null;
  /** The chip found no such passage in the page as it is now. */
  passageGone: boolean;
}

/** What `POST /api/wiki/discuss/apply` previewed: the diff and what Apply must send back. */
export interface DiscussEditPreview {
  before: string;
  after: string;
  beforeCtx: string;
  afterCtx: string;
  fromLine: number;
  toLine: number;
  note: string | null;
  findings: { check: string; message: string; line?: number }[];
  pageChangedSinceTurn: boolean;
  logEntry: string;
  baseHash: string;
  previewHash: string;
  /** The old text as the reader shows it, to find and mark its block. */
  markText: string;
}

/** Where the proposed edit stands in the tab. `refused`: the preview or
 *  Apply answered why it cannot apply; `failed`: the request itself failed. */
export type DiscussEditState = "loading" | "ready" | "refused" | "applying" | "applied" | "discarded" | "failed";

export interface DiscussEditView {
  state: DiscussEditState;
  preview: DiscussEditPreview | null;
  message: string | null;
  /** The card's way on when it holds no Apply: `preview` previews the same
   *  turn again (fresh hashes); `lost` asks again whether a lost Apply wrote. */
  retry?: "preview" | "lost" | null;
}

/** A refusal that may pass on its own: no answer, a server error the route
 *  did not mark `final`, another writer (`locked`), uncommitted changes
 *  (`dirty`) or a Gardener card (`held`). */
function transientEditRefusal(status: number, body: Record<string, unknown> | null): boolean {
  if (body?.final === true) return false;
  return status === 0 || status >= 500 || body?.locked === true || body?.dirty === true || body?.held === true;
}

/** An answer that is not the route's: no answer, a 2xx without its body, or a
 *  5xx without the route's JSON `error` (a proxy's 502/504 page). The request
 *  may have reached the route and written, so it is a lost answer, not a refusal. */
export function applyAnswerLost(r: { ok: boolean; status: number; body: Record<string, unknown> | null }): boolean {
  return r.status === 0 || r.ok || (r.status >= 500 && typeof r.body?.error !== "string");
}

/** The card after Apply answered a refusal (`status` ≠ 0). A transient one
 *  keeps the preview and its Apply: the route checks both hashes again, so a
 *  page changed meanwhile answers `stale` and writes nothing. `stale` and
 *  `changed` drop the hashes and offer «Preview again»; the rest are final. */
export function editAfterApplyRefusal(preview: DiscussEditPreview, status: number, body: Record<string, unknown> | null): DiscussEditView {
  const message = discussEditRefusalMessage(status, body);
  if (body?.stale === true || body?.changed === true) return { state: "refused", preview: null, message, retry: "preview" };
  if (transientEditRefusal(status, body)) return { state: "ready", preview, message };
  return { state: "refused", preview, message };
}

/** The card after a preview gave none: «Preview again» when it may pass, else final. */
export function editAfterPreviewFailure(status: number, body: Record<string, unknown> | null): DiscussEditView {
  if (status === 0) return { state: "failed", preview: null, message: "The preview could not be fetched: the server did not answer.", retry: "preview" };
  return { state: "refused", preview: null, message: discussEditRefusalMessage(status, body), retry: transientEditRefusal(status, body) ? "preview" : null };
}

/** Words for an Apply whose answer was found written after it was lost. */
export const LOST_APPLY_APPLIED = "Applied to the page. Apply's answer was lost, so whether log.md and the commit followed is not shown here.";

/**
 * The card after Apply's answer was lost (the request may have written), from
 * a fresh preview of the same turn (`r`). The turn reads as applied: it is,
 * and the page is rendered again. Still offered: the outcome is unknown, and
 * Apply is offered with the fresh hashes (a write that landed meanwhile makes
 * it answer `stale` or `applied`). No answer again: unknown, with a way to ask.
 * Only the applied reading renders the page again: on the others nothing
 * reads as written, so the article keeps its scroll, as after a refusal.
 */
export function editAfterLostApply(preview: DiscussEditPreview, r: { ok: boolean; status: number; body: Record<string, unknown> | null }): { edit: DiscussEditView; reload: boolean } {
  const lost = "Apply's answer did not arrive, so whether it wrote is unknown";
  if (r.body?.reason === "applied") return { edit: { state: "applied", preview, message: LOST_APPLY_APPLIED }, reload: true };
  const fresh = r.ok ? readEditPreview(r.body) : null;
  if (fresh) return { edit: { state: "ready", preview: fresh, message: `${lost}; the turn does not read as applied now. Apply again to write it.` }, reload: false };
  if (applyAnswerLost(r)) return { edit: { state: "failed", preview: null, message: `${lost}, and the server does not answer now. Check again to find out.`, retry: "lost" }, reload: false };
  return { edit: { state: "refused", preview: null, message: `${lost}. ${discussEditRefusalMessage(r.status, r.body)}`, retry: transientEditRefusal(r.status, r.body) ? "lost" : null }, reload: false };
}

/** A preview body as the route answers it, or null when it is not one. */
export function readEditPreview(body: Record<string, unknown> | null): DiscussEditPreview | null {
  if (!body || body.ok !== true || typeof body.before !== "string" || typeof body.after !== "string" || typeof body.baseHash !== "string" || typeof body.previewHash !== "string") return null;
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
  const num = (k: string) => (typeof body[k] === "number" ? (body[k] as number) : 0);
  const findings = Array.isArray(body.findings)
    ? (body.findings as Record<string, unknown>[]).filter((f) => f && typeof f.message === "string").map((f) => ({ check: String(f.check ?? ""), message: f.message as string, ...(typeof f.line === "number" ? { line: f.line } : {}) }))
    : [];
  return {
    before: body.before,
    after: body.after,
    beforeCtx: str("beforeCtx"),
    afterCtx: str("afterCtx"),
    fromLine: num("fromLine"),
    toLine: num("toLine"),
    note: typeof body.note === "string" ? body.note : null,
    findings,
    pageChangedSinceTurn: body.pageChangedSinceTurn === true,
    logEntry: str("logEntry"),
    baseHash: body.baseHash,
    previewHash: body.previewHash,
    markText: str("markText"),
  };
}

/** Readable words for a refusal the apply route answered (`status`, the parsed body or null). */
export function discussEditRefusalMessage(status: number, body: Record<string, unknown> | null): string {
  const error = typeof body?.error === "string" ? body.error : "";
  if (body?.readonly === true) return `This wiki is read-only here: nothing is written. ${error}`.trim();
  if (body?.refused === true) return `This edit cannot be applied: ${error}.`;
  if (body?.stale === true || body?.changed === true) return error;
  if (body?.dirty === true || body?.held === true || body?.locked === true) return error;
  switch (body?.reason) {
    case "superseded":
      return "A newer turn of this discussion follows, so this edit is no longer offered.";
    case "applied":
      return "This edit is already applied.";
    case "not-done":
    case "no-agent":
      return error;
  }
  return error ? `${error} (${status}).` : `The edit could not be applied (${status}).`;
}

export interface DiscussionView {
  wiki: string;
  relPath: string;
  /** The route's discussion id: the page's live wiki thread (Discuss v2), from
   *  the thread read or the first turn's `turn` event. */
  discussionId: string | null;
  turns: DiscussTurnView[];
  /** The wiki's bot and the thread's user, from the thread read (PR 4): what
   *  «Pop out ↗» opens /chat with. */
  bot?: string | null;
  userId?: string | null;
  /** The mode the next turn is sent in (the Explore/Edit toggle). */
  mode?: "explore" | "edit";
  /** Where the thread read stands for this page. */
  load?: "loading" | "done" | "failed";
  loadError?: string | null;
  /** The route answered `no-user`/`unknown-user`: the users to pick from. */
  userPick?: { users: { id: string; name: string }[]; message: string } | null;
  /** «Earlier discussions»: the page's closed threads and old one-shot turns. */
  earlier?: EarlierDiscussions | null;
}

// ── The page's thread as `GET /api/wiki/discuss/thread` answers it (PR 4) ──

/** A ledger row as the thread read sends it (the fields the tab reads). */
export interface StoredDiscussTurn {
  id: string;
  discussionId: string;
  seq: number;
  selection: string | null;
  question: string;
  answer: string;
  endState: string;
  error: string | null;
  toolCalls: { name: string; input: string }[];
  proposedEdit: unknown;
  editAppliedAt: number | null;
  createdAt: number;
}

/** A thread message joined to its ledger row. */
export interface StoredThreadMessage {
  id: string;
  role: string;
  content: string;
  createdAt: number;
  turn: StoredDiscussTurn | null;
}

export interface EarlierDiscussions {
  /** The page's closed wiki threads (Start over), newest first, with their messages. */
  closed: { id: string; name: string; createdAt: number; closedAt: number | null; messages: StoredThreadMessage[] }[];
  /** The page's old one-shot turns (v1, no thread), oldest first. */
  oneShot: StoredDiscussTurn[];
}

/** Words for a stored turn that did not end done. */
const STORED_END_WORDS: Record<string, string> = {
  error: "The turn failed.",
  timeout: "The turn ran past its time limit and was stopped.",
  abandoned: "The turn was abandoned: its run stopped before it ended.",
  running: "This turn is still running on the server. Reload the page once it has ended to see its answer.",
};

/** A stored turn as the tab shows it: its key is `s:<turn id>`, so a turn this
 *  tab streamed and the same turn read back are one turn. A turn still running
 *  reads as `dropped` (this tab has no stream for it, and sending is left to
 *  the route, which answers busy). */
export function turnFromStored(t: StoredDiscussTurn): DiscussTurnView {
  const passage: DiscussPassage | null = t.selection ? { selection: t.selection, before: "", after: "", atStart: false, atEnd: false, heading: "" } : null;
  const view = newTurn(`s:${t.id}`, t.question, passage);
  view.turnId = t.id;
  view.seq = t.seq;
  view.text = t.answer ?? "";
  view.tools = (t.toolCalls ?? []).map((c) => (c.input ? `${c.name} ${c.input}` : c.name));
  if (t.endState === "done") {
    view.state = "done";
    view.proposedEdit = t.proposedEdit !== null && t.proposedEdit !== undefined;
    if (view.proposedEdit && t.editAppliedAt) view.edit = { state: "applied", preview: null, message: "This edit is applied to the page." };
  } else {
    view.state = t.endState === "running" ? "dropped" : END_STATES.has(t.endState) ? (t.endState as DiscussTurnState) : "error";
    view.message = STORED_END_WORDS[t.endState] ?? STORED_END_WORDS.error!;
    if (t.error && t.endState !== "running") view.message += ` ${t.error}`;
  }
  return view;
}

/** The live thread's turns from its messages, in turn order (a message with
 *  no ledger row is left out: every turn's pair carries its row). */
export function turnsFromThread(messages: StoredThreadMessage[]): DiscussTurnView[] {
  const seen = new Set<string>();
  const out: DiscussTurnView[] = [];
  for (const m of messages) {
    if (!m.turn || seen.has(m.turn.id)) continue;
    seen.add(m.turn.id);
    out.push(turnFromStored(m.turn));
  }
  return out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * Add the thread read's turns to the discussion: a turn the tab already holds
 * (same turn id) is kept as the tab has it, since it may be streaming or carry
 * an edit card's state; nothing the tab holds is removed. The read's thread
 * becomes the discussion id when the tab has none yet.
 */
export function mergeThreadTurns(d: DiscussionView, threadId: string | null, stored: DiscussTurnView[]): void {
  if (threadId && !d.discussionId) d.discussionId = threadId;
  const have = new Set(d.turns.map((t) => t.turnId).filter((x): x is string => !!x));
  // A turn this tab is starting has no id yet: the read may already list it
  // as running. It is the newest; the `turn` event files it under its id.
  const sending = d.turns.some((t) => t.state === "sending");
  for (const t of stored) {
    if (t.turnId && have.has(t.turnId)) continue;
    if (sending && t.state === "dropped") continue;
    d.turns.push(t);
  }
}

/** The `turn` event gave `t` its id: drop a read-back copy of the same turn. */
export function dropStoredCopy(d: DiscussionView, t: DiscussTurnView): void {
  if (!t.turnId) return;
  d.turns = d.turns.filter((x) => x === t || x.turnId !== t.turnId);
}

/** The pop-out link: the page's thread in /chat (`src=wiki` keeps /chat from
 *  stamping its remembered connector on it). Null until the thread, its bot
 *  and its user are known. */
export function discussPopOutHref(d: DiscussionView | null): string | null {
  if (!d?.discussionId || !d.bot || !d.userId) return null;
  const q = new URLSearchParams({ bot: d.bot, thread: d.discussionId, user: d.userId, src: "wiki" });
  return `/chat?${q.toString()}`;
}

function shortDate(ms: number | null | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function earlierExchange(q: string, a: string): string {
  return (
    `<div class="wiki-discuss-earlier-turn">` +
    `<div class="wiki-discuss-q">${esc(q)}</div>` +
    (a ? `<div class="wiki-discuss-answer">${renderStreamingBody(a)}</div>` : "") +
    `</div>`
  );
}

/**
 * «Earlier discussions»: a collapsed `<details>` with the page's closed
 * threads (read-only, each with Delete) and its old one-shot turns grouped by
 * discussion (read-only). Empty string when there are none. Its own classes,
 * never `.wiki-discuss-turn`: nothing in it is a turn of the live thread.
 */
export function discussEarlierHtml(e: EarlierDiscussions | null | undefined): string {
  if (!e || (e.closed.length === 0 && e.oneShot.length === 0)) return "";
  const groups: string[] = [];
  for (const t of e.closed) {
    const items: string[] = [];
    let q: string | null = null;
    for (const m of t.messages) {
      if (m.role === "user") {
        if (q !== null) items.push(earlierExchange(q, ""));
        q = m.content;
      } else if (m.role === "assistant") {
        items.push(earlierExchange(q ?? "", m.content));
        q = null;
      }
    }
    if (q !== null) items.push(earlierExchange(q, ""));
    groups.push(
      `<div class="wiki-discuss-earlier-group" data-earlier-thread="${esc(t.id)}">` +
        `<div class="wiki-discuss-earlier-head"><span>${esc(t.name)}${t.closedAt ? ` · closed ${esc(shortDate(t.closedAt))}` : ""}</span>` +
        `<button type="button" class="wiki-discuss-earlier-delete" data-discuss-delete-thread="${esc(t.id)}" title="Delete this discussion and its turns">Delete</button></div>` +
        (items.length ? items.join("") : `<div class="wiki-discuss-hint">No turns.</div>`) +
        `</div>`,
    );
  }
  const byDiscussion = new Map<string, StoredDiscussTurn[]>();
  for (const t of e.oneShot) {
    const list = byDiscussion.get(t.discussionId) ?? [];
    list.push(t);
    byDiscussion.set(t.discussionId, list);
  }
  for (const [id, turns] of byDiscussion) {
    turns.sort((a, b) => a.seq - b.seq);
    groups.push(
      `<div class="wiki-discuss-earlier-group" data-earlier-oneshot="${esc(id)}">` +
        `<div class="wiki-discuss-earlier-head"><span>Before threads · ${esc(shortDate(turns[0]!.createdAt))}</span></div>` +
        turns.map((t) => earlierExchange(t.selection ? `> ${t.selection.replace(/\s+/g, " ").trim()}\n\n${t.question}` : t.question, t.answer)).join("") +
        `</div>`,
    );
  }
  const n = e.closed.length + byDiscussion.size;
  return `<details class="wiki-discuss-earlier"><summary>Earlier discussions (${n})</summary>${groups.join("")}</details>`;
}

/** The user picker the tab shows when the route needs the thread's user. */
export function discussUserPickHtml(p: { users: { id: string; name: string }[]; message: string } | null | undefined): string {
  if (!p) return "";
  const opts = p.users.map((u) => `<option value="${esc(u.id)}">${esc(u.name)} (${esc(u.id)})</option>`).join("");
  return (
    `<div class="wiki-discuss-error" role="alert">${esc(p.message)}</div>` +
    (p.users.length
      ? `<div class="wiki-discuss-actions"><select class="wiki-discuss-user-select" aria-label="The user this discussion belongs to">${opts}</select>` +
        `<button type="button" class="wiki-discuss-continue" data-discuss-pick-user>Use this user</button></div>`
      : "")
  );
}

export function newTurn(key: string, question: string, passage: DiscussPassage | null): DiscussTurnView {
  return { key, turnId: null, seq: null, passage, question, text: "", state: "sending", phase: null, tools: [], message: null, proposedEdit: false, edit: null, handover: null, passageGone: false };
}

/** A turn that may still change: the tab sends no second turn meanwhile. */
export function turnLive(t: DiscussTurnView): boolean {
  return t.state === "sending" || t.state === "running";
}

/** The current turn: the highest `seq`, never the last to finish (a turn
 *  closed as abandoned may still finish after a newer one started). A turn
 *  still `sending` (no `seq` yet) is the newest: it was sent after every
 *  numbered one. A turn without a `seq` that is no longer live (refused, or
 *  dropped before its `turn` event) never hides a numbered turn; it is current
 *  only when no turn has a `seq`. */
export function currentTurn(d: DiscussionView): DiscussTurnView | null {
  let best: DiscussTurnView | null = null;
  let sending: DiscussTurnView | null = null;
  let unnumbered: DiscussTurnView | null = null;
  for (const t of d.turns) {
    if (t.seq === null) {
      if (t.state === "sending") sending = t;
      else if (t.state !== "refused") unnumbered = t;
      continue;
    }
    if (!best || (best.seq ?? 0) < t.seq) best = t;
  }
  return sending ?? best ?? unnumbered;
}

/** A turn of the discussion is live, wherever it sits: the tab sends no
 *  other turn meanwhile (the route would answer 409 busy). */
export function discussionLive(d: DiscussionView): boolean {
  return d.turns.some(turnLive);
}

const END_STATES: ReadonlySet<string> = new Set(["done", "error", "timeout", "abandoned"]);

/**
 * Move one turn by one decoded stream frame. Returns the discussion id the
 * `turn` event carried, so the caller can file it on the discussion. The
 * vocabulary is the route's: `turn`, `status`, `delta`, `tool`, `done`,
 * `app_error`, `heartbeat`, `end`.
 */
export function applyDiscussFrame(t: DiscussTurnView, event: string, data: Record<string, unknown>): { discussionId?: string } {
  switch (event) {
    case "turn":
      if (typeof data.turnId === "string") t.turnId = data.turnId;
      if (typeof data.seq === "number") t.seq = data.seq;
      t.state = "running";
      return typeof data.discussionId === "string" ? { discussionId: data.discussionId } : {};
    case "status":
      if (typeof data.phase === "string") t.phase = data.phase;
      return {};
    case "delta":
      if (typeof data.text === "string" && t.state === "running") t.text += data.text;
      return {};
    case "tool":
      if (typeof data.name === "string") t.tools.push(typeof data.input === "string" && data.input ? `${data.name} ${data.input}` : data.name);
      return {};
    case "done":
      t.state = "done";
      t.phase = null;
      if (typeof data.answer === "string") t.text = data.answer;
      t.proposedEdit = data.proposedEdit !== null && data.proposedEdit !== undefined;
      return {};
    case "app_error":
      t.state = typeof data.endState === "string" && END_STATES.has(data.endState) ? (data.endState as DiscussTurnState) : "error";
      t.phase = null;
      t.message = typeof data.message === "string" ? data.message : "The turn failed.";
      return {};
    default:
      return {};
  }
}

/** The stream ended: a turn still running lost its reader, not its run. The
 *  server stores it on the page's thread, which the tab reads on a page load
 *  (Discuss v2), so a reload shows it once it has ended. */
export function streamClosed(t: DiscussTurnView): void {
  if (!turnLive(t)) return;
  t.state = "dropped";
  t.phase = null;
  t.message = t.turnId
    ? "The connection closed before the turn ended. The server runs it to its end and stores it in this page's discussion: reload the page once it has ended to see the answer."
    : "The connection closed before the turn started here. The server may still run it and store it in this page's discussion: reload the page to see it.";
}

/** Readable words for a refusal the route answered as JSON before its stream
 *  (`status`, the parsed body or null). Each names what to do next. */
export function discussRefusalMessage(status: number, body: { error?: unknown; reason?: unknown; readonly?: unknown } | null): string {
  const error = typeof body?.error === "string" ? body.error : "";
  const reason = typeof body?.reason === "string" ? body.reason : "";
  if (body?.readonly === true) return `This wiki is read-only: nothing on it is sent to a model. ${error}`.trim();
  switch (reason) {
    case "no-agent":
      return "This wiki has no wiki agent any more (its .wiki-agent.md is gone since the page loaded). Reload the page.";
    case "busy":
      return status === 429
        ? "Four discuss turns are already running on this muninn. Try again when one has ended."
        : "The discussion's last turn is still running. Wait for it to end, then ask again.";
    case "rules-too-large":
      return `This wiki's agent rules (.wiki-agent.md) are over their size bound since the page loaded (${error.replace(/^the wiki's \.wiki-agent\.md is /, "")}), so the agent cannot run. Shorten the file, then reload the page.`;
    case "rules-unreadable":
      return "This wiki's agent rules (.wiki-agent.md) cannot be read since the page loaded (a symlink, or a file muninn may not read), so the agent cannot run. Fix the file, then reload the page.";
    case "no-bot":
      return `No bot can answer on this wiki here: ${error || "none is configured"}.`;
    case "no-snapshot":
      return "The wiki agent reads a snapshot of the wiki, and this wiki is not a git work tree, so it cannot run here.";
    case "page-not-in-snapshot":
      return `The wiki agent cannot read this page: ${error.replace(/^the wiki agent cannot read this page: /, "")}.`;
    case "unknown-discussion":
    case "other-page":
    case "closed":
    case "other-user":
    case "other-bot":
      return `${error}. Start a new discussion: reload the page.`;
    case "no-user":
    case "unknown-user":
      return "The route needs the user this page's discussion belongs to: pick one above, then ask again.";
  }
  if (status === 403) return error || "The wiki agent is for admins.";
  return error ? `The turn could not start: ${error} (${status}).` : `The turn could not start (${status}).`;
}

const PHASE_WORDS: Record<string, string> = {
  snapshots: "Taking snapshots of the wiki and the code…",
  card: "Reading the plan card…",
  model: "The agent is reading…",
  writing: "Writing the answer…",
};

/** The quote a chip shows; the chip itself carries the whole passage. */
const CHIP_MAX = 160;

function chipText(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= CHIP_MAX ? flat : `${flat.slice(0, CHIP_MAX - 1)}…`;
}

function lineSpan(p: DiscussEditPreview): string {
  return p.fromLine === p.toLine ? `line ${p.fromLine}` : `lines ${p.fromLine}–${p.toLine}`;
}

/**
 * The proposed edit's card (P4). Only the current turn's edit is offered: an
 * older turn's says a newer turn follows. The diff shows the file's text in
 * the range struck and what replaces it, with the page around it; then the
 * lint findings the edit adds, and Apply, «Change the wording» and Discard.
 */
export function discussEditHtml(t: DiscussTurnView, current: boolean): string {
  const key = esc(t.key);
  const e = t.edit;
  if (!current && e?.state !== "applied") {
    return `<div class="wiki-discuss-edit-note">This answer proposed an edit. A newer turn follows, so it is no longer offered.</div>`;
  }
  if (!e || e.state === "loading") return `<div class="wiki-discuss-edit" data-edit-state="loading"><div class="wiki-discuss-status"><span class="spinner"></span><span>Previewing the proposed edit…</span></div></div>`;
  if (e.state === "discarded") return `<div class="wiki-discuss-edit-note" data-edit-state="discarded">The proposed edit was discarded.</div>`;
  const parts: string[] = [`<div class="wiki-discuss-edit" data-edit-state="${e.state}">`];
  const p = e.preview;
  parts.push(`<div class="wiki-discuss-edit-head">Proposed edit${p ? ` · ${esc(lineSpan(p))}` : ""}</div>`);
  if (p && e.state !== "refused") {
    if (p.note) parts.push(`<div class="wiki-discuss-edit-why">${esc(p.note)}</div>`);
    parts.push(
      `<div class="wiki-discuss-diff">` +
        `<div class="wiki-discuss-diff-old"><span class="wiki-discuss-diff-ctx">${esc(p.beforeCtx)}</span><del>${esc(p.before)}</del><span class="wiki-discuss-diff-ctx">${esc(p.afterCtx)}</span></div>` +
        `<div class="wiki-discuss-diff-new"><span class="wiki-discuss-diff-ctx">${esc(p.beforeCtx)}</span><ins>${esc(p.after)}</ins><span class="wiki-discuss-diff-ctx">${esc(p.afterCtx)}</span></div>` +
        `</div>`,
    );
    if (p.findings.length) {
      parts.push(
        `<div class="wiki-discuss-edit-lint">The edit adds ${p.findings.length === 1 ? "a lint finding" : `${p.findings.length} lint findings`}:<ul>` +
          p.findings.map((f) => `<li>${esc(f.check)}${f.line ? ` (line ${f.line})` : ""}: ${esc(f.message)}</li>`).join("") +
          `</ul></div>`,
      );
    }
    if (p.pageChangedSinceTurn && e.state === "ready") parts.push(`<div class="wiki-discuss-edit-why">The page changed since this turn; the old text is still there exactly once, and the diff is against the page as it is now.</div>`);
  }
  // The applied note takes focus after the page renders again (`tabindex="-1"`).
  if (e.message) parts.push(e.state === "applied" ? `<div class="wiki-discuss-edit-done" role="status" tabindex="-1">${esc(e.message)}</div>` : `<div class="wiki-discuss-error" role="alert">${esc(e.message)}</div>`);
  if (e.state !== "applied") {
    const busy = e.state === "applying" ? " disabled" : "";
    parts.push(
      `<div class="wiki-discuss-actions">` +
        (e.state === "ready" || e.state === "applying" ? `<button type="button" class="wiki-discuss-apply" data-discuss-apply="${key}"${busy}>${e.state === "applying" ? "Applying…" : "Apply"}</button>` : "") +
        (e.retry && (e.state === "refused" || e.state === "failed") ? `<button type="button" class="wiki-discuss-apply" data-discuss-repreview="${key}">${e.retry === "lost" ? "Check again" : "Preview again"}</button>` : "") +
        `<button type="button" class="wiki-discuss-continue" data-discuss-reword="${key}"${busy}>Change the wording</button>` +
        `<button type="button" class="wiki-discuss-continue" data-discuss-discard="${key}"${busy}>Discard</button>` +
        `</div>`,
    );
  }
  parts.push(`</div>`);
  return parts.join("");
}

/** One turn's markup. Every control keys on `data-discuss-*` and the turn's key.
 *  `current`: the discussion's current turn ({@link currentTurn}), the only one whose edit is offered. */
export function discussTurnHtml(t: DiscussTurnView, current = true): string {
  const key = esc(t.key);
  const parts: string[] = [`<div class="wiki-discuss-turn" data-turn-key="${key}" data-turn-state="${t.state}"${t.seq !== null ? ` data-turn-seq="${t.seq}"` : ""}>`];
  if (t.passage) {
    parts.push(`<button type="button" class="wiki-discuss-chip" data-discuss-chip="${key}" title="Show this passage in the page">“${esc(chipText(t.passage.selection))}”</button>`);
    if (t.passageGone) parts.push(`<div class="wiki-discuss-gone" role="status">That passage is no longer in the page.</div>`);
  } else parts.push(`<div class="wiki-discuss-whole">About the whole page</div>`);
  parts.push(`<div class="wiki-discuss-q">${esc(t.question)}</div>`);
  if (turnLive(t)) {
    const phase = t.state === "sending" ? "Starting the turn…" : (PHASE_WORDS[t.phase ?? ""] ?? "Working…");
    parts.push(`<div class="wiki-discuss-status"><span class="spinner"></span><span>${esc(phase)}</span></div>`);
  }
  if (t.tools.length) {
    parts.push(`<div class="wiki-discuss-tools">${t.tools.slice(-6).map((x) => `<span class="wiki-discuss-tool">${esc(x)}</span>`).join("")}</div>`);
  }
  if (t.text) parts.push(`<div class="wiki-discuss-answer">${renderStreamingBody(t.text)}</div>`);
  if (t.message) parts.push(`<div class="wiki-discuss-error" role="alert">${esc(t.message)}</div>`);
  if (t.proposedEdit && t.state === "done") parts.push(discussEditHtml(t, current));
  if (t.turnId && !turnLive(t) && t.state !== "refused") {
    const h = t.handover;
    parts.push(
      `<div class="wiki-discuss-actions"><button type="button" class="wiki-discuss-continue" data-discuss-continue="${key}"${h?.state === "busy" ? " disabled" : ""}>Continue in Claude Code</button>` +
        `<span class="wiki-discuss-cont-status" role="status">${h ? esc(h.note) : ""}</span></div>` +
        (h?.state === "failed" && h.prompt ? `<textarea class="wiki-discuss-cont-out" readonly aria-label="The prompt">${esc(h.prompt)}</textarea>` : ""),
    );
  }
  parts.push("</div>");
  return parts.join("");
}

const HINT_HTML = `<div class="wiki-discuss-hint">Select a passage and choose «Ask here», or ask about the whole page below. The wiki agent reads the page and the code it names, and answers here.</div>`;

/** Oldest first by `seq` (an unnumbered turn last). */
function turnsInOrder(d: DiscussionView): DiscussTurnView[] {
  return [...d.turns].sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));
}

/** The turns list's markup, oldest first. */
export function discussTurnsHtml(d: DiscussionView | null): string {
  if (!d || d.turns.length === 0) return HINT_HTML;
  const cur = currentTurn(d);
  return turnsInOrder(d).map((t) => discussTurnHtml(t, t === cur)).join("");
}

/** The markup each turn element was drawn from. */
const drawn = new WeakMap<Element, string>();

/**
 * Bring a drawn turn element to `fresh`'s markup in place: its attributes, and
 * only the parts whose markup changed. While a turn streams, its chip and its
 * question stay the same nodes, so a press on the chip survives the repaints;
 * the answer and the status line are redrawn.
 */
function patchTurn(el: Element, fresh: Element): void {
  for (const { name } of Array.from(el.attributes)) if (!fresh.hasAttribute(name)) el.removeAttribute(name);
  for (const { name, value } of Array.from(fresh.attributes)) if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  const want = Array.from(fresh.children);
  const old = Array.from(el.children);
  let k = 0;
  for (const part of want) {
    // The next old part with the same markup is kept; the old parts it skips are gone.
    const html = part.outerHTML;
    let j = k;
    while (j < old.length && old[j]!.outerHTML !== html) j++;
    if (j < old.length) {
      for (; k < j; k++) old[k]!.remove();
      k = j + 1;
      continue;
    }
    el.insertBefore(part, old[k] ?? null);
  }
  for (; k < old.length; k++) old[k]!.remove();
}

/**
 * Bring `list` to `d`'s turns, redrawing only a turn whose markup changed: a
 * finished turn's element stays the same node while another turn streams, so
 * a selection, focus or a press in it survives the repaints. A list the pane
 * rendered anew holds no turn element and is drawn whole.
 */
export function patchDiscussTurns(list: HTMLElement, d: DiscussionView | null): void {
  if (!d || d.turns.length === 0) {
    if (list.innerHTML !== HINT_HTML) list.innerHTML = HINT_HTML;
    return;
  }
  const turns = turnsInOrder(d);
  const keys = new Set(turns.map((t) => t.key));
  const have = new Map<string, Element>();
  for (const el of Array.from(list.children)) {
    const k = el.getAttribute("data-turn-key");
    if (k !== null && keys.has(k) && drawn.has(el) && !have.has(k)) have.set(k, el);
    else el.remove();
  }
  const tpl = list.ownerDocument.createElement("template");
  const cur = currentTurn(d);
  turns.forEach((t, i) => {
    const html = discussTurnHtml(t, t === cur);
    let el = have.get(t.key);
    if (!el || drawn.get(el) !== html) {
      tpl.innerHTML = html;
      const fresh = tpl.content.firstElementChild!;
      if (el) patchTurn(el, fresh);
      else el = fresh;
      drawn.set(el, html);
    }
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] ?? null);
  });
}

// ── Where a passage sits in the rendered article ─────────────────────────

/** Elements whose text is the reader's, not the page's: never matched. The
 *  hidden set is what the selection's own reading leaves out (P1b), so a
 *  passage read through a fact chip still matches. */
const SKIP = `button, script, style, svg, textarea, input, select, .${PEEK_CLASS}, ${DISCUSS_TEXT_HIDDEN}`;
/** The smallest block around a found passage, the fallback flash where the
 *  browser has no highlights. A `<details>` is never it: that is a whole fold. */
const BLOCK = "li, p, h1, h2, h3, h4, h5, h6, td, th, dt, dd, blockquote, pre, figure, summary, .callout, tr";
/** How many characters (white space dropped) of each end of the passage are matched. */
const KEY_CHARS = 48;

function compact(s: string): string {
  return s.replace(/\s+/g, "");
}

/** A passage found in the article: the text node it starts in, the range over
 *  exactly its text, and the smallest block holding all of it (null when that
 *  would be the article or a fold). */
export interface FoundPassage {
  node: Text;
  range: Range;
  block: Element | null;
}

/** The context a turn carries about where its passage was selected. */
export interface PassageContext {
  before?: string;
  after?: string;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** The text the article walk reads from `range` (the reader's controls and
 *  hidden additions left out), so a passage kept as the reader saw it is
 *  searched as {@link findPassage} reads the page. */
export function renderedPassageText(range: Range): string {
  const root = range.commonAncestorContainer;
  const parts: string[] = [];
  const take = (n: Text) => {
    if (n.parentElement?.closest(SKIP) || !range.intersectsNode(n)) return;
    const a = n === range.startContainer ? range.startOffset : 0;
    const b = n === range.endContainer ? range.endOffset : n.data.length;
    parts.push(n.data.slice(a, b));
  };
  if (root.nodeType === 3) take(root as Text);
  else {
    const walker = (root.ownerDocument ?? (root as Document)).createTreeWalker(root, 4);
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) take(n);
  }
  return parts.join(" ");
}

/**
 * The reader's selection behind a passage turn, kept for the chip: its
 * boundaries through weak references, so an article the reader re-rendered is
 * not held alive by it (a kept `Range` pins its whole detached tree), and the
 * text it covered as rendered, which finds the passage after a re-render.
 */
export interface DiscussAnchor {
  start: WeakRef<Node> | null;
  startOffset: number;
  end: WeakRef<Node> | null;
  endOffset: number;
  rendered: string;
}

export function keepAnchor(range: Range): DiscussAnchor {
  return { start: new WeakRef(range.startContainer), startOffset: range.startOffset, end: new WeakRef(range.endContainer), endOffset: range.endOffset, rendered: renderedPassageText(range) };
}

/** The kept selection as a range, while it is still in `article` over the
 *  same text; else null, and the anchor lets go of its boundaries for good. */
export function anchorRange(anchor: DiscussAnchor, article: Element): Range | null {
  const s = anchor.start?.deref();
  const e = anchor.end?.deref();
  if (s && e && article.contains(s) && article.contains(e)) {
    try {
      const r = article.ownerDocument.createRange();
      r.setStart(s, anchor.startOffset);
      r.setEnd(e, anchor.endOffset);
      if (compact(renderedPassageText(r)) === compact(anchor.rendered)) return r;
    } catch {
      /* an offset past a node edited since: not the selection any more */
    }
  }
  anchor.start = anchor.end = null;
  return null;
}

/**
 * Find the passage `selection` in `article` as it is rendered now. White
 * space is ignored (a selection across list items reads with newlines the DOM
 * does not hold), so is text inside the reader's own controls. Both ends must
 * be there, in order, within the passage's length again: an edited passage
 * whose first words survive elsewhere does not count. When the text occurs
 * more than once, `context` (the turn's `before`/`after`) picks the copy whose
 * surroundings match it longest; a tie, or no context, is the first copy in
 * page order. Null when it is not in the page.
 */
export function findPassage(article: Element, selection: string, context?: PassageContext | null): FoundPassage | null {
  const want = compact(selection);
  if (!want) return null;
  const head = want.slice(0, KEY_CHARS);
  const tail = want.slice(-Math.min(KEY_CHARS, want.length));
  const doc = article.ownerDocument;
  // 4 = NodeFilter.SHOW_TEXT, spelled out so the helper needs no global.
  const walker = doc.createTreeWalker(article, 4);
  const nodes: { node: Text; at: number }[] = [];
  let text = "";
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (n.parentElement?.closest(SKIP)) continue;
    const c = compact(n.data);
    if (!c) continue;
    nodes.push({ node: n, at: text.length });
    text += c;
  }
  const hits: { from: number; to: number }[] = [];
  for (let i = text.indexOf(head); i !== -1; i = text.indexOf(head, i + 1)) {
    const j = text.indexOf(tail, i + Math.max(0, want.length - tail.length));
    if (j === -1 || j - i > want.length * 2 + KEY_CHARS) continue;
    hits.push({ from: i, to: j + tail.length });
  }
  if (hits.length === 0) return null;
  // A compact index to the text node and offset of that character. The node
  // is found by binary search: this runs twice per copy, and a page can hold
  // a short passage hundreds of times.
  const at = (c: number): { node: Text; offset: number } => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (nodes[mid]!.at <= c) lo = mid;
      else hi = mid - 1;
    }
    const { node, at: base } = nodes[lo]!;
    let seen = base;
    for (let o = 0; o < node.data.length; o++) {
      if (/\s/.test(node.data[o]!)) continue;
      if (seen === c) return { node, offset: o };
      seen++;
    }
    return { node, offset: node.data.length };
  };
  const rangeOf = (h: { from: number; to: number }): Range => {
    const a = at(h.from);
    const b = at(h.to - 1);
    const r = doc.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset + 1);
    return r;
  };
  let hit = hits[0]!;
  const before = compact(context?.before ?? "");
  const after = compact(context?.after ?? "");
  if (hits.length > 1 && (before || after)) {
    // Each copy's surroundings are read as the turn's `before`/`after` were
    // (the context reading, which leaves out every reader-only element), not
    // as the match above reads the page: a Fold's «Details» label or a caption
    // next to the selected copy must not cost it the match. The article is
    // read once, and each copy's surroundings are slices of that reading, at
    // most `HANDOFF_CONTEXT_MAX` characters a side, as `before`/`after` are.
    const reading = discussReading(article);
    let best = 0;
    for (const h of hits) {
      const a = at(h.from);
      const b = at(h.to - 1);
      const s = reading.at(a.node, a.offset);
      const e = reading.at(b.node, b.offset + 1);
      if (s === null || e === null) continue;
      const around = {
        before: compact(reading.text.slice(Math.max(0, s - HANDOFF_CONTEXT_MAX), s)),
        after: compact(reading.text.slice(e, e + HANDOFF_CONTEXT_MAX)),
      };
      const score = commonSuffix(around.before, before) + commonPrefix(around.after, after);
      if (score > best) [best, hit] = [score, h];
    }
  }
  const range = rangeOf(hit);
  const common = range.commonAncestorContainer;
  const holder = (common.nodeType === 1 ? (common as Element) : common.parentElement)?.closest(`${BLOCK}, details`) ?? null;
  const block = holder && holder.tagName !== "DETAILS" && article.contains(holder) && holder !== article ? holder : null;
  return { node: range.startContainer as Text, range, block };
}

// ── The article mark on the text a proposed edit replaces ────────────────

/** What «Change the wording» puts in the follow-up box. */
export const DISCUSS_REWORD_PROMPT = "Propose another wording for that edit, for the same passage: ";

/** The follow-up box after «Change the wording»: the prompt, and behind it
 *  whatever the reader had typed (a draft is never dropped). A box that
 *  already starts with the prompt, its trailing space edited or not, is kept. */
export function rewordDraft(current: string): string {
  if (!current.trim()) return DISCUSS_REWORD_PROMPT;
  return current.trimStart().startsWith(DISCUSS_REWORD_PROMPT.trimEnd()) ? current : DISCUSS_REWORD_PROMPT + current;
}

/** One line's inline markdown as the reader shows it: a code span's text
 *  literal (markup inside it stays), an autolink as its URL (or its label in
 *  `<url|label>`), tags out, an image's alt, a wiki link's or link's label,
 *  bold, strike and single emphasis markers out. */
function inlineWords(line: string): string {
  const code: string[] = [];
  // \u0000 n \u0000 holds code span n while the rest is read; no rule below matches it.
  const held = line.replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g, (_m, _t, body: string) => `\u0000${code.push(body) - 1}\u0000`);
  return held
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>\n]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/<\/?[A-Za-z][^>\n]*>/g, "")
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\[\[(?:[^\]|\n]*\|)?([^\]\n]*)\]\]/g, "$1")
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+?)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/\u0000(\d+)\u0000/g, (_m, n: string) => code[Number(n)] ?? "");
}

/**
 * Markdown as the reader shows its words, roughly: block markers (headings,
 * bullets, quotes, callouts, table pipes, fence lines) and tags out, inline
 * markup read by {@link inlineWords}; a fenced block's lines are kept as
 * written. Enough to find a passage and score its surroundings, where white
 * space is ignored; the route's `markText` is the fallback.
 */
export function markdownWords(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const open = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence !== null) {
      if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length && !raw.trim().slice(open[1]!.length).trim()) fence = null;
      else out.push(raw);
      continue;
    }
    if (open) {
      fence = open[1]!;
      continue;
    }
    if (/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(raw)) continue;
    const l = raw
      .replace(/^[ \t]*(?:>[ \t]?)+/, "")
      .replace(/^[ \t]*\[![\w-]+\][+-]?[ \t]*/, "")
      .replace(/^[ \t]*#{1,6}[ \t]+/, "")
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/, "")
      .replace(/^\[[ xX]\][ \t]+/, "");
    // A table row: its cells read one by one, as the reader splits them (a pipe inside a code span too).
    out.push(/^\s*\|/.test(l) ? l.split("|").map(inlineWords).join(" ") : inlineWords(l));
  }
  return out.join("\n");
}

/** What the mark needs from a preview. */
export interface EditMarkSource {
  before: string;
  beforeCtx: string;
  afterCtx: string;
  markText: string;
}

/** Where the text an edit replaces sits in the rendered article: its words
 *  read from `before` (so a heading edit, whose `markText` is empty, is
 *  found), else the route's `markText`; the copy picked by the edit's
 *  surroundings when the page shows that text more than once. */
export function editMarkTarget(article: Element, p: EditMarkSource): FoundPassage | null {
  const context = { before: markdownWords(p.beforeCtx), after: markdownWords(p.afterCtx) };
  for (const text of [markdownWords(p.before), p.markText]) {
    if (!text.trim()) continue;
    const found = findPassage(article, text, context);
    if (found) return found;
  }
  return null;
}

/** Where an applied edit's new text sits in the article rendered again after
 *  Apply: found as {@link editMarkTarget} finds the old text, by the new
 *  text's rendered words (its source carries code spans, emphasis and links
 *  the article does not show), the copy picked by the edit's surroundings,
 *  which the write left as they were. */
export function appliedEditTarget(article: Element, p: { after: string; beforeCtx: string; afterCtx: string }): FoundPassage | null {
  return editMarkTarget(article, { before: p.after, beforeCtx: p.beforeCtx, afterCtx: p.afterCtx, markText: "" });
}

/** The words a mark's range covers, as {@link findPassage} reads the page
 *  (white space and reader-only text out): what {@link editMarkHolds} compares. */
export function editMarkWords(range: Range): string {
  return compact(renderedPassageText(range));
}

/** A mark's range still covers the `words` it was found on, in `article`.
 *  A later enhancement that replaces a text node (the ref links'
 *  `replaceWith`) breaks it: a browser moves a boundary in the removed node
 *  onto the parent (the range collapses or covers other words), and a DOM
 *  that does not update ranges leaves it in the detached node. Either way
 *  the target is searched again. */
export function editMarkHolds(article: Element, range: Range, words: string): boolean {
  return article.contains(range.startContainer) && article.contains(range.endContainer) && editMarkWords(range) === words;
}

/** Open every closed `<details>` around `node` inside `article` (a `<Fold>`),
 *  so a highlight on text in it can be seen; the elements opened. */
export function openFoldsAround(article: Element, node: Node): Element[] {
  const opened: Element[] = [];
  for (let d = node.parentElement?.closest("details") ?? null; d && article.contains(d); d = d.parentElement?.closest("details") ?? null) {
    if (!d.hasAttribute("open")) {
      d.setAttribute("open", "");
      opened.push(d);
    }
  }
  return opened;
}
