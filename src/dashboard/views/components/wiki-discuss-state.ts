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
import { DISCUSS_TEXT_HIDDEN } from "./wiki-discuss-text.ts";
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
  /** «Continue in Claude Code»: where its request stands. */
  handover: { state: "busy" | "done" | "failed"; note: string; prompt?: string } | null;
  /** The chip found no such passage in the page as it is now. */
  passageGone: boolean;
}

export interface DiscussionView {
  wiki: string;
  relPath: string;
  /** The route's discussion id, from the first turn's `turn` event. */
  discussionId: string | null;
  turns: DiscussTurnView[];
}

export function newTurn(key: string, question: string, passage: DiscussPassage | null): DiscussTurnView {
  return { key, turnId: null, seq: null, passage, question, text: "", state: "sending", phase: null, tools: [], message: null, proposedEdit: false, handover: null, passageGone: false };
}

/** A turn that may still change: the tab sends no second turn meanwhile. */
export function turnLive(t: DiscussTurnView): boolean {
  return t.state === "sending" || t.state === "running";
}

/** The current turn: the highest `seq`, never the last to finish (a turn
 *  closed as abandoned may still finish after a newer one started). A turn
 *  without a `seq` yet is the newest: it was sent after every numbered one. */
export function currentTurn(d: DiscussionView): DiscussTurnView | null {
  let best: DiscussTurnView | null = null;
  for (const t of d.turns) {
    if (t.seq === null) return t.state === "refused" ? best : t;
    if (!best || (best.seq ?? 0) < t.seq) best = t;
  }
  return best;
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

/** The stream ended: a turn still running lost its reader, not its run. */
export function streamClosed(t: DiscussTurnView): void {
  if (!turnLive(t)) return;
  t.state = "dropped";
  t.phase = null;
  t.message = "The connection closed before the turn ended. The server runs it to its end and stores it; reload the page later to read it.";
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
    case "no-bot":
      return `No bot can answer on this wiki here: ${error || "none is configured"}.`;
    case "no-snapshot":
      return "The wiki agent reads a snapshot of the wiki, and this wiki is not a git work tree, so it cannot run here.";
    case "page-not-in-snapshot":
      return `The wiki agent cannot read this page: ${error.replace(/^the wiki agent cannot read this page: /, "")}.`;
    case "unknown-discussion":
    case "other-page":
      return `${error}. Start a new discussion: reload the page.`;
  }
  if (status === 403) return error || "The wiki agent is for admins.";
  return error ? `The turn could not start: ${error} (${status}).` : `The turn could not start (${status}).`;
}

const PHASE_WORDS: Record<string, string> = {
  snapshots: "Taking snapshots of the wiki and the code…",
  card: "Reading the plan card…",
  model: "The agent is reading…",
};

/** The quote a chip shows; the chip itself carries the whole passage. */
const CHIP_MAX = 160;

function chipText(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= CHIP_MAX ? flat : `${flat.slice(0, CHIP_MAX - 1)}…`;
}

/** One turn's markup. Every control keys on `data-discuss-*` and the turn's key. */
export function discussTurnHtml(t: DiscussTurnView): string {
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
  if (t.proposedEdit) parts.push(`<div class="wiki-discuss-edit-note">This answer proposes an edit to the page. Previewing and applying it is not built yet.</div>`);
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

/** The turns list, oldest first by `seq` (an unnumbered turn last). */
export function discussTurnsHtml(d: DiscussionView | null): string {
  if (!d || d.turns.length === 0) {
    return `<div class="wiki-discuss-hint">Select a passage and choose «Ask here», or ask about the whole page below. The wiki agent reads the page and the code it names, and answers here.</div>`;
  }
  const turns = [...d.turns].sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));
  return turns.map(discussTurnHtml).join("");
}

// ── Where a passage sits in the rendered article ─────────────────────────

/** Elements whose text is the reader's, not the page's: never matched. The
 *  hidden set is what the selection's own reading leaves out (P1b), so a
 *  passage read through a fact chip still matches. */
const SKIP = `button, script, style, svg, textarea, input, select, .${PEEK_CLASS}, ${DISCUSS_TEXT_HIDDEN}`;
/** The block a found passage reveals: the nearest of these around its start. */
const BLOCK = "li, p, h1, h2, h3, h4, h5, h6, td, th, dt, dd, blockquote, pre, figure, summary, details, .callout, tr";
/** How many characters (white space dropped) of each end of the passage are matched. */
const KEY_CHARS = 48;

function compact(s: string): string {
  return s.replace(/\s+/g, "");
}

/**
 * Find the passage `selection` in `article` as it is rendered now: the text
 * node where it starts and the block around it. White space is ignored (a
 * selection across list items reads with newlines the DOM does not hold), so
 * is text inside the reader's own controls. Both ends must be there, in
 * order, within the passage's length again: an edited passage whose first
 * words survive elsewhere does not count. Null when it is not in the page.
 */
export function findPassage(article: Element, selection: string): { node: Text; block: Element | null } | null {
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
  for (let i = text.indexOf(head); i !== -1; i = text.indexOf(head, i + 1)) {
    const j = text.indexOf(tail, i + Math.max(0, want.length - tail.length));
    if (j === -1 || j - i > want.length * 2 + KEY_CHARS) continue;
    let k = 0;
    while (k + 1 < nodes.length && nodes[k + 1]!.at <= i) k++;
    const node = nodes[k]!.node;
    const block = node.parentElement?.closest(BLOCK) ?? null;
    return { node, block: block && article.contains(block) && block !== article ? block : null };
  }
  return null;
}
