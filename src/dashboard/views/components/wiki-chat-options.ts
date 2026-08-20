/// <reference lib="dom" />
/**
 * The /wiki reader's "start a chat from here" DIALOG — the whole DOM half: its
 * state, its render, its four openers, and the document listeners that drive it.
 *
 * Lifted out of `wiki-browser.ts` unchanged (2026-08 architecture review, cut 2)
 * — same DOM ids/classes, same `/api/wiki/chat-target` + `/api/wiki/ask/chat`
 * request shapes, same keyboard and click semantics. The PURE half (defaults,
 * labels, thread-name preview, the Escape/click-away decisions, the suggestion
 * templates) already lived in `wiki-chat-target.ts` and is imported from there,
 * never re-implemented here.
 *
 * IMPORTED by `wiki-browser.ts`, never bundled on its own: the reader page loads
 * exactly one client bundle, and a second `makeBundledClientScript` entrypoint
 * would give the page two module states and two document listener sets — the rule
 * already written above the `share-dialog.ts` import.
 *
 * **This module OWNS its document listeners** (the `share-dialog.ts` shape): the
 * shell's click delegate no longer carries a chat-options branch at all. They are
 * registered by `initChatOptions`, not at module import, and the shell calls it
 * from exactly the spot its own chat-options `change` listener used to occupy —
 * i.e. AFTER the shell's click delegate is registered. That ordering is
 * load-bearing rather than incidental: the click-away test reads
 * `document.contains(target)`, so a handler that synchronously detaches its own
 * target (the fact-check integrate panel's Cancel) must still run BEFORE the
 * click-away decision, exactly as it did when both lived in one listener.
 *
 * The split also costs an invariant that used to be free. THREE click delegates
 * now run for every click — this module's (in `wireChatOptions` below), the
 * shell's follow-up / write-action delegate (the `document.addEventListener(
 * "click", …)` chain in `wiki-browser.ts`, just above the `initChatOptions`
 * call) and the shell's navigation delegate on `document.body` (the
 * `NAV_LINK_SELECTOR` set — `[data-wiki-page]` / `[data-page]` / `[data-relpath]`,
 * registered first) — so **their selector sets must stay
 * disjoint**; a `data-page` OR `data-relpath` chip rendered INSIDE this dialog
 * would navigate the article pane out from under it. While every branch lived in one `if / else if` chain that
 * exclusivity was structural; now it is a convention, and a selector added to
 * both files fires both handlers on one click with nothing to say so.
 *
 * Everything this needs from the shell arrives through the `ChatOptionsDeps`
 * port passed to `initChatOptions` — the shown Ask turn, the Ask session, the
 * open article and its outgoing links, the shared `POST /api/wiki/ask/chat`, and
 * the escalate bar's repaint. No `let` is shared across the file boundary, which
 * is what let the dialog's state move whole. The one seam pointing the other way
 * is `closeChatOptionsIfNavigatingAway`, which `renderBreadcrumb` calls.
 */

import { escHtml as esc } from "./escape.ts";
import {
  articleChatContextHtml,
  botDefaultOptionLabel,
  captureChatOptFocus,
  chatOptConflictFootHtml,
  chatOptEscapeAction,
  chatOptNameChipsHtml,
  chatOptNameSource,
  chatOptQuestion,
  chatOptQuestionHtml,
  chatOptQuestionReadOnly,
  chatOptStatusLines,
  chatOptSuggestionsHtml,
  chatOptSummaryHtml,
  chatOptSummaryTextHtml,
  chatUserStorageKey,
  chosenSupportsWebTools,
  composeDeclineQuestion,
  conflictStatusLine,
  connectorOptionLabel,
  connectorStorageValue,
  shouldCloseArticleChatOnNavigate,
  suggestedQuestions,
  threadNameSuggestions,
  CHAT_ESC_ANSWER_MAX,
  CHAT_OPT_ADV_ID,
  CHAT_OPT_ESC_CONFIRM,
  CHAT_OPT_NAME_CHIP_ATTR,
  CHAT_OPT_QUESTION_ID,
  CHAT_OPT_SUGGEST_ATTR,
  DECLINE_CHAT_BTN_ID,
  DISCUSS_ARTICLE_BTN_ID,
  pickConnectorId,
  pickUserId,
  previewThreadName,
  shouldCloseChatOptions,
  summaryThreadName,
  wikiConnectorStorageKey,
  type ChatEscState,
  type ChatOptArticle,
  type ChatOptFocus,
  type ChatOptMode,
  type ChatTarget,
} from "./wiki-chat-target.ts";
import { readActiveWikiName, withWikiParam } from "./wiki-param.ts";
import { wikiReadonlyWikiFlag } from "./wiki-readonly-client.ts";

// ── The shell port ────────────────────────────────────────────────────

/**
 * The Ask turn as this dialog uses it — structurally a subset of the shell's
 * `AskTurn`, declared here so the two files share no type declaration and no
 * import cycle. Every field is one the dialog genuinely reads (or, for
 * `chatEsc`, writes back).
 */
export interface ChatOptTurn {
  question: string;
  answer: string;
  citations: { title: string; pageName?: string }[];
  kind?: string;
  declined?: "no_hits" | "low_confidence";
  explainPage?: string;
  originQuestion?: string;
  chatEsc?: ChatEscState;
}

/** The page the article opener acts on — the shell's `WikiListing`, narrowed to
 *  the fields the dialog copies into `ChatOptArticle`. */
export interface ChatOptPage {
  name: string;
  title: string;
  relPath: string;
  description?: string;
  desc?: string;
  updated?: string;
}

/** What POST /api/wiki/ask/chat answers, as this dialog reads it. Mirrors the
 *  shell's `AskChatResponse` — the POST itself stays in the shell, shared with the
 *  plain (one-click) escalate path. */
export interface ChatOptPostResult {
  status: number;
  ok: boolean;
  data: {
    chatUrl?: string;
    error?: string;
    threadExists?: boolean;
    nameTaken?: boolean;
    alreadyQueued?: boolean;
    existingThreadId?: string;
    connectorApplied?: boolean;
  };
}

/**
 * Everything the dialog needs from the reader shell. Declared with METHOD syntax
 * so a shell function typed on the richer `AskTurn` still satisfies it.
 *
 * Method syntax means those parameters are checked BIVARIANTLY, so the shell's
 * `refreshChatEscalateBar(turn: AskTurn)` is accepted here even though this
 * module only promises it a `ChatOptTurn` — the narrower shape. That is unsound
 * in general, and it is safe here for one structural reason: **this module never
 * CONSTRUCTS a turn.** Every turn it holds came out of `getShownTurn()` (via
 * `state.turn`), i.e. it is a real `AskTurn` the shell handed over, narrowed on
 * the way in and handed straight back — the `AskTurn`-only fields are still
 * there at runtime, unread. The shell's own guard closes the remaining gap: its
 * `refreshChatEscalateBar` starts with `if (turn !== askShownTurn) return;`, an
 * IDENTITY test, so a turn that did not come from the shell repaints nothing at
 * all rather than being read as an `AskTurn`.
 *
 * Both halves of that are load-bearing. Synthesizing a `ChatOptTurn` here — a
 * stub for a decline, say — and passing it to `refreshChatEscalateBar` would
 * hand the shell an object missing every field its `AskTurn` type promises, with
 * no type error anywhere; it survives today only because the identity guard
 * would drop it. Prefer `getShownTurn()` and keep it that way.
 */
export interface ChatOptionsDeps {
  /** The Ask turn currently painted in the pane (`askShownTurn`) — escalate mode's
   *  subject, and the decline hook's. A callback, not a copy: the shown turn
   *  changes under an open dialog. */
  getShownTurn(): ChatOptTurn | null;
  /** This reader's Ask session, oldest-first (`askTurns`) — read only for the
   *  "Continue …" starter chip. */
  getAskTurns(): ChatOptTurn[];
  /** The page open in the article pane (`currentArticle`), or null. */
  getCurrentArticle(): ChatOptPage | null;
  /** Titles of that page's outgoing links (`currentOutgoingTitles`). */
  getOutgoingTitles(): string[];
  /** The shared `POST /api/wiki/ask/chat` — one spelling of the body encoding for
   *  both escalation paths, so it stays with the other one, in the shell. */
  postAskChat(payload: Record<string, unknown>): Promise<ChatOptPostResult>;
  /** Repaint a turn's "Continue in chat →" bar after the dialog mirrors its
   *  outcome onto `turn.chatEsc`. */
  refreshChatEscalateBar(turn: ChatOptTurn): void;
}

/**
 * Injected by `initChatOptions`. The defaults are inert rather than throwing, but
 * they are also unreachable on the page: nothing can open the dialog until the
 * listeners are wired, and wiring happens in the same call that sets these.
 */
let deps: ChatOptionsDeps = {
  getShownTurn: () => null,
  getAskTurns: () => [],
  getCurrentArticle: () => null,
  getOutgoingTitles: () => [],
  postAskChat: () => Promise.resolve({ status: 0, ok: false, data: {} }),
  refreshChatEscalateBar: () => {},
};

/** Wire the dialog to the shell AND register its document listeners. Called once,
 *  from `wiki-browser.ts`. Deleting that call leaves a reader whose Discuss / New
 *  chat / ⚙ buttons do nothing at all — which `tsc` and the unit tests cannot see,
 *  so `e2e/wiki-chat-dialog.spec.ts` pins it. */
export function initChatOptions(d: ChatOptionsDeps): void {
  deps = d;
  wireChatOptions();
}

/** The wiki this reader is browsing — read by the same RULE the shell uses
 *  (`wiki-param.ts`), though not at the same moment: the shell snapshots it once
 *  at boot (`const WIKI = readActiveWikiName()` in `wiki-browser.ts`) while this
 *  re-reads it on every call. Deliberate — this file is imported before the shell
 *  runs, so a module-scope capture here would read the global too early — and the
 *  two cannot disagree, because the value never changes after the bundle loads:
 *  `window.__WIKI_NAME__` is injected server-side by `views/wiki-page.ts` before
 *  the script tag and nothing mutates it, and switching wikis is a full page load
 *  (`pageUrl` re-emits `WIKI` into every in-page link). The value is what keeps
 *  every fetch, the remembered connector key and the POST body on the wiki
 *  actually on screen. */
function wikiName(): string {
  return readActiveWikiName();
}

/** Append the active `wiki` param to a URL so the fetch stays on-wiki. */
function withWiki(url: string): string {
  return withWikiParam(url, wikiName());
}

// ── Chat options popover ──────────────────────────────────────────────
// One popover, two entry points: the "New chat" button beside the Ask box (a
// DIRECT escalation — the reader's question goes straight to a real thread, no
// Ask turn first) and the ⚙ on a committed turn's "Continue in chat →" bar. Both
// resolve the same way and POST the same route; only `mode` and whether an answer
// rides along differ.
//
// Everything the panel prefills comes from ONE `GET /api/wiki/chat-target` fetch:
// the reader client holds a WIKI NAME, and which bot/user/connector a thread lands
// on is a server question (a wiki name is not a bot name, and the bot that answers
// Ask can differ from the bot that owns the chat). Defaults, labels and the thread
// name preview are the pure `wiki-chat-target.ts`.

interface ChatOptState {
  mode: ChatOptMode;
  /** The turn this popover acts for: escalate mode carries its answer +
   *  citations into the seed, and BOTH modes mirror the outcome back onto its
   *  `chatEsc` bar. Null for the "New chat" and "💬 Discuss" openers, neither of
   *  which has a turn. */
  turn: ChatOptTurn | null;
  /** Article mode: the page the question is about. The POST sends its name +
   *  relPath and the SERVER re-resolves both against the index — this copy only
   *  drives the panel (title, thread-name default, question prefill/hint). */
  article?: ChatOptArticle;
  question: string;
  /** Present ⇒ the question is PINNED to `turn` (the decline hook): it is not
   *  read from the Ask box at open, not re-read at submit, and the box is never
   *  written to. See `chatOptQuestion`. */
  pinnedQuestion?: string;
  /** The pinned question comes from a turn the WIKI DECLINED — the POST says so
   *  (`askDeclined`) so the seed stops ordering the search that just failed. */
  askDeclined?: boolean;
  target: ChatTarget | null;
  loading: boolean;
  /** Fatal load error (no target ⇒ nothing to send). */
  error?: string;
  /** Transient line under the fields (send failures, "already queued", …). */
  status?: string;
  statusIsError?: boolean;
  /** Bot override in flight — set only once the reader picks one. */
  botName: string;
  /** Bot picker options, cached from the response that ASKED for a bot. The ok
   *  branch ships no `bots`, so without this the picker would vanish the moment
   *  a pick resolved — and a re-fetch that failed would dead-end with no way back. */
  bots: { name: string }[];
  /** Sticky: this popover was opened on a wiki that needed a bot picked, so the
   *  picker stays rendered through every later state (resolved, error, sending). */
  needsBotPicker: boolean;
  userId: string;
  connectorId: string;
  /** Typed thread-name override; "" ⇒ derive from the question. */
  threadName: string;
  sending: boolean;
  /** A name collision the reader must resolve. `threadExists` ⇒ the thread really
   *  is this article's (or this question's) and "Send there →" is the primary
   *  action; `nameTaken` ⇒ the route checked the colliding thread's identity and
   *  it is an UNRELATED thread that owns the name, so a new thread is the only
   *  offer and `existingThreadId` is empty. */
  conflict?: { existingThreadId: string; typedName: boolean; nameTaken?: boolean };
  /** One Escape has been pressed on a typed question — the next one discards it
   *  (`chatOptEscapeAction`). Cleared by typing. */
  escArmed?: boolean;
  /** The reader has edited the question in this dialog, so it is unsaved work a
   *  stray Escape must confirm before discarding. A PREFILLED question (escalate's
   *  turn, direct's copy of the Ask box) is reproducible and never confirms. */
  dirty?: boolean;
  /** The As/Model/Thread disclosure is open. Collapsed by default: all three
   *  values are already right nearly every time, and seven rows before the
   *  question is what made this dialog read as a form rather than a question box. */
  advOpen?: boolean;
  /** Titles of the open article's outgoing links, for the "How it connects"
   *  starter question. Absent ⇒ that chip is simply not offered. */
  links?: string[];
  /** A 409 `alreadyQueued` — the thread already holds an unopened question. The
   *  deep link is the recovery: open it, and the queued seed is delivered. */
  queuedUrl?: string;
  /** Terminal success — the thread's deep link. */
  doneUrl?: string;
  openedTab?: boolean;
}
let chatOpt: ChatOptState | null = null;
/** Monotonic id so a slow chat-target fetch can't repopulate a newer open. */
let chatOptLoadSeq = 0;

function chatOptPanel(): HTMLElement | null {
  return document.getElementById("wikiChatOpt");
}

/** Read a localStorage key, tolerating a disabled/foreign-origin store. */
function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

/** The question the dialog would send RIGHT NOW — the pure `chatOptQuestion` over
 *  its OWN field (`state.question`, kept current by the `input` delegation). */
function currentChatOptQuestion(state: ChatOptState): string {
  return chatOptQuestion(state);
}

/** What the DEFAULT thread name derives from right now — the article's title in
 *  article mode, the live question everywhere else (`chatOptNameSource`). */
function currentChatOptNameSource(state: ChatOptState): string {
  return chatOptNameSource(state.mode, currentChatOptQuestion(state), state.article?.title);
}

/**
 * The most recent real question of this reader's Ask session, for the "Continue
 * …" starter chip. The shell's `askTurns` (read through the port) is oldest-first,
 * so this walks back from the end.
 *
 * Fact-check turns are skipped: their `question` is the synthetic "Fact check:
 * <page>" label, which is not a question anyone would want continued in chat.
 */
function lastAskedQuestion(): string {
  const askTurns = deps.getAskTurns();
  for (let i = askTurns.length - 1; i >= 0; i--) {
    const turn = askTurns[i]!;
    if (turn.kind === "factcheck") continue;
    const q = (turn.question || "").trim();
    if (q) return q;
  }
  return "";
}

/**
 * Clear an armed Escape confirmation, and the line that announced it.
 *
 * Every path that touches the dialog's state has to do BOTH: `escArmed` says "the
 * next Escape discards", and the status line is the only thing telling the reader
 * so. A path that cleared the status but left the flag armed (the thread-name field
 * and its chips did) left the next single Escape discarding a typed question with
 * no warning ever on screen.
 */
function disarmChatOptEscape(state: ChatOptState): void {
  state.escArmed = false;
  if (state.status === CHAT_OPT_ESC_CONFIRM) {
    state.status = undefined;
    state.statusIsError = false;
  }
}

/** Short day label for the "dated" thread-name chip, e.g. `4 aug`. */
function chatOptTodayLabel(): string {
  return new Date()
    .toLocaleDateString("en-GB", { day: "numeric", month: "short" })
    .toLowerCase();
}

/**
 * Open the dialog. `mode` decides what gets sent; a `pinnedQuestion` overrides
 * where the question comes from entirely (the decline hook — see
 * `chatOptQuestion`).
 *
 * Direct mode PREFILLS the dialog's own question box from the Ask box, once, and
 * leaves the box itself untouched. It used to re-read that box live at submit
 * instead, which is what made opening this on an empty box a dead end: the panel
 * asked for a question while covering the only field that could supply one.
 */
function openChatOptions(
  mode: ChatOptMode,
  opts: {
    pinnedQuestion?: string;
    turn?: ChatOptTurn | null;
    askDeclined?: boolean;
    article?: ChatOptArticle;
    links?: string[];
  } = {},
): void {
  // A read-only wiki (`WIKI_READONLY_ROOTS`) seeds no chat thread — the route
  // 403s all three modes before it resolves a bot. The capture-phase guard
  // cancels the clicks that reach the four openers; this is the gate on the
  // FUNCTION, so a caller that never dispatched a click (a keyboard shortcut, a
  // future programmatic opener) cannot walk past it into a dialog whose only
  // outcome is a refusal.
  if (wikiReadonlyWikiFlag()) return;
  let question = "";
  let turn: ChatOptTurn | null = null;
  const pinned = typeof opts.pinnedQuestion === "string";
  if (pinned) {
    question = opts.pinnedQuestion!.trim();
    turn = opts.turn ?? null;
  } else if (mode === "article") {
    if (!opts.article) return;
    // Editable, and ALWAYS EMPTY: neither page summary prefills. Both are
    // declarative sentences about the topic, Send is enabled on whatever is in
    // the box, and the frontmatter `description` that used to prefill was
    // therefore one click away from being sent as the reader's own question —
    // and appended to the seed a second time by the server. They ride along as a
    // clamped context line instead (`articleChatHint`), with the starter chips as
    // the way to get a real question into the box in one click.
    question = "";
  } else if (mode === "direct") {
    const input = document.getElementById("wikiAskInput") as HTMLTextAreaElement | null;
    question = (input?.value || "").trim();
  } else {
    turn = deps.getShownTurn();
    if (!turn || !turn.answer || turn.kind === "factcheck") return;
    question = turn.question;
  }
  chatOpt = {
    mode, turn, question,
    article: opts.article,
    links: opts.links,
    pinnedQuestion: pinned ? question : undefined,
    askDeclined: opts.askDeclined || undefined,
    target: null, loading: true,
    botName: "", bots: [], needsBotPicker: false,
    userId: "", connectorId: "", threadName: "",
    sending: false,
  };
  renderChatOptions();
  void loadChatTarget();
}

/**
 * Open the popover from the decline hook — the same DIRECT path the "New chat"
 * button uses, but with the question PINNED to the declined turn.
 *
 * It is pinned rather than written into `#wikiAskInput` (which is what shipped
 * first): the box is the reader's own draft space, and stuffing it destroyed
 * whatever they had typed, left the failed question armed in the box after the
 * popover closed, and — on the Connections tab — wrote into a textarea that isn't
 * even visible. Pinning also carries the composition the plain label can't: an
 * Explain turn's question is a display label and a follow-up's is a fragment, so
 * `composeDeclineQuestion` restates the page/passage or the originating question
 * before the seed ever quotes it.
 */
function openDeclineChat(): void {
  const turn = deps.getShownTurn();
  if (!turn || !turn.declined) return;
  openChatOptions("direct", {
    pinnedQuestion: composeDeclineQuestion({
      question: turn.question,
      explainPage: turn.explainPage,
      originQuestion: turn.originQuestion,
    }),
    turn,
    askDeclined: true,
  });
}

/**
 * Open the popover from the breadcrumb's "💬 Discuss" button — the article mode.
 *
 * The page comes from the shell's `currentArticle` through the port (stamped by
 * `renderBreadcrumb`), not from a lookup in `allPages`: only the single-page
 * payload carries `desc`, which is the question hint. No page open ⇒ no-op,
 * exactly like the escalate opener with no committed turn.
 */
function openArticleChat(): void {
  const m = deps.getCurrentArticle();
  if (!m) return;
  openChatOptions("article", {
    article: {
      name: m.name,
      title: m.title,
      relPath: m.relPath,
      description: m.description,
      desc: m.desc,
      updated: m.updated,
    },
    // Snapshotted at open like the article itself: the rail's outgoing links are
    // whatever the last `/api/wiki/page` response carried for THIS page, and a
    // later navigation must not retitle a chip in an open dialog.
    links: deps.getOutgoingTitles().slice(),
  });
}

function closeChatOptions(): void {
  chatOpt = null;
  const panel = chatOptPanel();
  if (panel) panel.remove();
  const scrim = document.getElementById("wikiChatOptScrim");
  if (scrim) scrim.remove();
}

/** Fetch the target for the current bot selection and derive every default.
 *  Re-run whenever the bot picker changes — users, the default-user mapping and
 *  the bot default connector are ALL bot-keyed. */
async function loadChatTarget(): Promise<void> {
  const state = chatOpt;
  if (!state) return;
  const seq = ++chatOptLoadSeq;
  state.loading = true;
  state.error = undefined;
  renderChatOptions();
  try {
    let url = withWiki("/api/wiki/chat-target");
    if (state.botName) {
      url += (url.indexOf("?") === -1 ? "?" : "&") + "bot=" + encodeURIComponent(state.botName);
    }
    const res = await fetch(url);
    const data = (await res.json().catch(() => ({}))) as ChatTarget & { error?: string };
    if (chatOpt !== state || seq !== chatOptLoadSeq) return; // superseded
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    state.target = data;
    // `bots` rides the FAILURE branch only (the ok path ships none — the picker
    // exists for a wiki that didn't resolve). Latch both the options and the fact
    // that this popover needs a picker, so it survives a later resolve AND a later
    // failure: without the latch an error response rendered no select at all, and
    // the reader had to close and re-open the panel to try another bot.
    if (data.bots?.length) {
      state.bots = data.bots;
      state.needsBotPicker = true;
    }
    if (data.botName) {
      state.botName = data.botName;
      state.userId = pickUserId(data, lsGet(chatUserStorageKey(data.botName)));
      // The route folds in the preference for the user it expects the client to
      // land on; only a DIFFERENT user (a remembered override) costs a second
      // round-trip.
      let preferred: string | null = null;
      if (state.userId && state.userId === data.preferredForUserId) {
        preferred = data.preferredConnectorId ?? null;
      } else if (state.userId) {
        preferred = await fetchPreferredConnector(state.userId, data.botName);
        if (chatOpt !== state || seq !== chatOptLoadSeq) return;
      }
      state.connectorId = pickConnectorId(data, lsGet(wikiConnectorStorageKey(wikiName())), preferred);
    } else {
      // `reason` is the ONLY branch key: `needs_bot` is not an error at all (the
      // picker IS the answer), the other two are real errors — shown ABOVE the
      // picker latched just above, which is their recovery. (`needsBot` was a
      // second encoding of exactly this.)
      if (data.reason !== "needs_bot") state.error = data.error || "No chat target for this wiki.";
    }
  } catch (err) {
    if (chatOpt !== state || seq !== chatOptLoadSeq) return;
    state.error = "Couldn't work out where this chat would go — " +
      (err instanceof Error ? err.message : String(err));
  } finally {
    if (chatOpt === state && seq === chatOptLoadSeq) {
      state.loading = false;
      renderChatOptions();
    }
  }
}

/** The user+bot's persisted preferred connector (the chat page's own sidebar
 *  memory, in DB). Never fatal — no preference just means "bot default". */
async function fetchPreferredConnector(userId: string, botName: string): Promise<string | null> {
  try {
    const res = await fetch(
      "/chat/preferences/" + encodeURIComponent(userId) + "/" + encodeURIComponent(botName),
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { connectorId?: string | null };
    return data.connectorId || null;
  } catch { return null; }
}

/**
 * The three values the summary line reports, derived from state — shared by the
 * full render and the in-place repaint so the collapsed line can't drift from what
 * the expanded pickers hold.
 *
 * The thread name is the SAME `previewThreadName` string the old separate "will be
 * named `…`" line carried, typed override included.
 */
function chatOptSummaryInput(
  state: ChatOptState,
  question: string,
): { userName: string; modelLabel: string; threadName: string } {
  const t = state.target;
  const nameSource = chatOptNameSource(state.mode, question, state.article?.title);
  return {
    userName: (t?.users ?? []).find((u) => u.id === state.userId)?.name || "",
    modelLabel: state.connectorId
      ? (t?.connectors ?? []).find((c) => c.id === state.connectorId)?.name || ""
      : botDefaultOptionLabel(t?.botDefault ?? null),
    threadName: summaryThreadName(state.threadName, nameSource),
  };
}

/**
 * The dialog's body, derived from `chatOpt`.
 *
 * Order is the redesign: what this is about → the question → what to ask →
 * one summary line → the pickers, collapsed. The old order opened with three
 * always-expanded pickers and a name preview, and put the question last (or, in
 * direct mode, nowhere at all).
 */
function chatOptBodyHtml(state: ChatOptState, question: string): string {
  const t = state.target;
  const rows: string[] = [];
  // Article context first — what page this dialog is about, and what the page says
  // about itself. Above the error/loading returns, since it is true regardless.
  if (state.mode === "article" && state.article) {
    rows.push(articleChatContextHtml(state.article));
  }
  // READ-ONLY question modes (`chatOptQuestionReadOnly`): a PINNED decline question
  // — which is composed, not the label shown on the turn, and lives nowhere else —
  // and an ESCALATE question, whose turn's answer + citations ride the POST verbatim.
  if (chatOptQuestionReadOnly(state.mode, typeof state.pinnedQuestion === "string")) {
    rows.push(
      '<div class="wiki-chatopt-pinned">' + esc(state.pinnedQuestion ?? state.question) + "</div>",
    );
  } else {
    // ONE question box for every mode, rendered ABOVE the error/loading returns so
    // the reader can start typing while the chat target is still resolving (Send
    // stays blocked until both land).
    rows.push(chatOptQuestionHtml(state.mode, state.question));
    const suggestions = suggestedQuestions({
      mode: state.mode,
      article: state.article,
      links: state.links,
      wiki: wikiName(),
      lastQuestion: lastAskedQuestion(),
    });
    rows.push(
      chatOptSuggestionsHtml(
        suggestions,
        state.mode === "article" ? "Ask about this page" : "Or start from",
      ),
    );
  }
  // The bot picker outlives its own response: it is rendered from state (not from
  // the current payload) whenever this popover ever needed a bot, so a resolved
  // pick can still be changed, a re-fetch IN FLIGHT still shows the pick that
  // started it, and — crucially — a FAILED re-fetch still offers a way back
  // instead of dead-ending until the reader closes and re-opens.
  if (state.needsBotPicker && state.bots.length) {
    rows.push(
      '<label class="wiki-chatopt-row"><span>Bot</span><select id="wikiChatOptBot">' +
      '<option value="">Pick a bot…</option>' +
      state.bots.map((b) =>
        '<option value="' + esc(b.name) + '"' +
        (b.name === state.botName ? " selected" : "") + ">" + esc(b.name) + "</option>",
      ).join("") +
      "</select></label>",
    );
  }
  if (state.error) {
    rows.push('<div class="wiki-chatopt-line error">' + esc(state.error) + "</div>");
    return rows.join("");
  }
  if (state.loading && !t) {
    rows.push('<div class="wiki-chatopt-line">Working out where this chat lands…</div>');
    return rows.join("");
  }
  if (t?.botName) {
    // Article mode names the thread after the PAGE, not the question — that is
    // what makes every later visit land in the same discussion thread (and 409
    // onto "Send there →") instead of minting a sibling per question.
    // The field's placeholder is the SAME string the summary line reports (i.e. ""
    // when there is nothing to name the thread after yet) — rendered as
    // `previewThreadName`'s generic `wiki ask` fallback, it sat directly under a
    // summary that deliberately omitted the thread part, so the two disagreed about
    // the same value in the one state where both are visible.
    const derived = summaryThreadName(
      "",
      chatOptNameSource(state.mode, question, state.article?.title),
    );
    const users = t.users ?? [];
    // The summary line reports all three collapsed choices, so the reader can see
    // what will happen without expanding anything.
    rows.push(
      chatOptSummaryHtml({
        ...chatOptSummaryInput(state, question),
        advOpen: !!state.advOpen,
      }),
    );
    const adv: string[] = [];
    if (users.length > 1) {
      adv.push(
        '<label class="wiki-chatopt-row"><span>As</span><select id="wikiChatOptUser">' +
        users.map((u) =>
          '<option value="' + esc(u.id) + '"' +
          (u.id === state.userId ? " selected" : "") + ">" + esc(u.name) + "</option>",
        ).join("") +
        "</select></label>",
      );
    }
    adv.push(
      '<label class="wiki-chatopt-row"><span>Model</span><select id="wikiChatOptConn">' +
      '<option value=""' + (state.connectorId ? "" : " selected") + ">" +
      esc(botDefaultOptionLabel(t.botDefault ?? null)) + "</option>" +
      (t.connectors ?? []).map((cRow) =>
        '<option value="' + esc(cRow.id) + '"' +
        (cRow.id === state.connectorId ? " selected" : "") + ">" +
        esc(connectorOptionLabel(cRow)) + "</option>",
      ).join("") +
      "</select></label>",
    );
    // The server degraded its connector listing. Say so where the short list is —
    // otherwise "(bot default) only" is indistinguishable from a wiki that really
    // has no named connectors.
    if (t.connectorsError) {
      adv.push(
        '<div class="wiki-chatopt-note">Couldn\'t load the named models (' +
        esc(t.connectorsError) + ") — the bot default still works.</div>",
      );
    }
    adv.push(
      '<label class="wiki-chatopt-row"><span>Thread</span>' +
      '<input id="wikiChatOptName" type="text" spellcheck="false" placeholder="' +
      esc(derived) + '" value="' + esc(state.threadName) + '"></label>',
    );
    adv.push(
      chatOptNameChipsHtml(
        threadNameSuggestions({
          mode: state.mode,
          question,
          articleTitle: state.article?.title,
          today: chatOptTodayLabel(),
        }),
        state.threadName,
      ),
    );
    if (state.advOpen) rows.push('<div class="wiki-chatopt-adv">' + adv.join("") + "</div>");
    // The capability note lives OUTSIDE the disclosure, unconditionally: it changes
    // what the seed may promise, so a collapsed panel must not hide the difference
    // between a model that can search the web and one that can't. One spelling, one
    // push — it was briefly rendered in both places with two hand-synced strings,
    // which is a copy edit away from the reader seeing different words depending on
    // whether the disclosure happened to be open.
    //
    // Only the seeds that INSTRUCT research act on this capability (direct and
    // article); an escalation quotes an answer and instructs nothing about tools, so
    // the note would be noise there.
    if (state.mode !== "escalate" && !chosenSupportsWebTools(t, state.connectorId)) {
      rows.push(
        '<div class="wiki-chatopt-note">The chosen model has no web search — the question will ' +
        "ask for research with the tools it does have.</div>",
      );
    }
  }
  return rows.join("");
}

/** The status line's inner markup (its container is always rendered, so the line
 *  can be repainted without disturbing the focused thread-name input). The lines
 *  themselves are the pure `chatOptStatusLines` — a status no longer HIDES the
 *  "type a question first" guidance, which is what let an emptied question sit
 *  under conflict copy beside two live buttons that POST it. */
function chatOptStatusHtml(state: ChatOptState, question: string): string {
  return chatOptStatusLines({
    status: state.status,
    statusIsError: state.statusIsError,
    hasTarget: !!state.target?.botName,
    question,
    hasUser: !!state.userId,
  })
    .map(
      (l) => '<div class="wiki-chatopt-line' + (l.error ? " error" : "") + '">' +
        esc(l.text) + "</div>",
    )
    .join("");
}

/** The action row's inner markup. */
function chatOptFootHtml(state: ChatOptState, question: string): string {
  if (state.doneUrl) {
    return (
      '<a class="wiki-chatopt-done" href="' + esc(state.doneUrl) + '" target="_blank">' +
      (state.openedTab ? "✓ Opened in chat →" : "Chat thread ready — open it →") + "</a>"
    );
  }
  // An "already queued" refusal is only actionable if the reader can reach the
  // thread holding the unopened question — opening it delivers that seed, and
  // then this question can be sent. "Send there →" is deliberately NOT offered:
  // it would 409 again on the very same condition.
  if (state.queuedUrl) {
    return (
      '<a class="wiki-chatopt-done" href="' + esc(state.queuedUrl) + '" target="_blank">Open it →</a>' +
      '<button id="wikiChatOptForce" class="wiki-chatopt-btn ghost">Start new thread</button>'
    );
  }
  // Both conflict actions POST the question, so an empty one disables them — a
  // live button there opened a blank tab and closed it again with no feedback.
  if (state.conflict) {
    return chatOptConflictFootHtml({
      nameTaken: state.conflict.nameTaken,
      disabled: state.sending || !question,
    });
  }
  if (state.target?.botName) {
    const blocked = state.sending || !question || !state.userId;
    return (
      '<button id="wikiChatOptSend" class="wiki-chatopt-btn"' + (blocked ? " disabled" : "") + ">" +
      (state.sending ? "Opening…" : "Start chat →") + "</button>"
    );
  }
  return "";
}

/** Panel markup, fully derived from `chatOpt` — every field re-renders from state
 *  so a re-render can never lose (or misattribute) a pick. The status and foot
 *  containers are ALWAYS emitted (even empty) so they can be repainted in place. */
function chatOptionsHtml(state: ChatOptState): string {
  const title =
    state.mode === "article"
      ? "Discuss this article"
      : state.mode === "direct"
        ? "New chat from this wiki"
        : "Continue in chat";
  const question = currentChatOptQuestion(state);
  return (
    '<div class="wiki-chatopt-head">' + esc(title) +
    '<button id="wikiChatOptClose" class="wiki-chatopt-x" aria-label="Close">×</button></div>' +
    '<div class="wiki-chatopt-body">' + chatOptBodyHtml(state, question) + "</div>" +
    '<div id="wikiChatOptStatus">' + chatOptStatusHtml(state, question) + "</div>" +
    '<div class="wiki-chatopt-foot">' + chatOptFootHtml(state, question) + "</div>"
  );
}

/**
 * Repaint ONLY the summary line, the status line and the action row. Used by the
 * typing paths (the question box, the thread-name field), where a wholesale
 * re-render would rip the focused input out from under the caret — but all three
 * genuinely have to change:
 *   • the Send button's enabled state follows the question;
 *   • editing the name clears a name collision, and a foot still offering
 *     "Send there →" then posts `existingThreadId: undefined`;
 *   • the summary line carries the thread-name preview, which follows BOTH fields
 *     (it replaced the separate "will be named …" line this used to poke).
 */
function repaintChatOptFoot(): void {
  const state = chatOpt;
  const panel = chatOptPanel();
  if (!state || !panel) return;
  const question = currentChatOptQuestion(state);
  const sum = panel.querySelector(".wiki-chatopt-sumtext");
  if (sum && state.target?.botName) {
    sum.innerHTML = chatOptSummaryTextHtml(chatOptSummaryInput(state, question));
  }
  const status = panel.querySelector("#wikiChatOptStatus");
  if (status) status.innerHTML = chatOptStatusHtml(state, question);
  const foot = panel.querySelector(".wiki-chatopt-foot");
  if (foot) foot.innerHTML = chatOptFootHtml(state, question);
}

/** Re-focus the field the innerHTML swap just destroyed, caret included. */
function restoreChatOptFocus(snap: ChatOptFocus | null): void {
  if (!snap) return;
  const el = document.getElementById(snap.id) as
    | (HTMLElement & { setSelectionRange?: (s: number, e: number) => void })
    | null;
  if (!el) return;
  el.focus();
  if (snap.start === null || snap.end === null || typeof el.setSelectionRange !== "function") {
    return;
  }
  // A `<select>` has no selection range, and a caret past the (possibly shorter)
  // new value throws on some engines — neither is worth losing the focus over.
  try { el.setSelectionRange(snap.start, snap.end); } catch { /* not a text field */ }
}

/**
 * Paint the dialog, creating it (and its scrim) on the first call of an open.
 *
 * There is no positioning left to do: the dialog is centred in CSS with its own
 * `max-height`. It used to be anchored under whichever button opened it, which
 * needed a re-clamp on every render (the panel grows when the target lands) and
 * still covered the Ask box and the session history it sat on top of.
 */
function renderChatOptions(): void {
  const state = chatOpt;
  let panel = chatOptPanel();
  if (!state) { if (panel) panel.remove(); return; }
  // The question box is rendered BEFORE the chat target resolves, on purpose
  // ("start typing immediately") — and `loadChatTarget`'s finally, the user picker
  // and the connector picker all re-render the whole panel. Without this the reader
  // loses focus and caret mid-word, and the rest of the sentence goes nowhere.
  const active = document.activeElement as HTMLElement | null;
  const focus = captureChatOptFocus(
    active as { id?: string } | null,
    !!panel && !!active && panel.contains(active),
  );
  const created = !panel;
  if (!panel) {
    // The scrim goes in first so it sits UNDER the panel in paint order, and it
    // carries no listener of its own — the document-level click delegation already
    // treats anything outside the panel as a dismissal.
    const scrim = document.createElement("div");
    scrim.id = "wikiChatOptScrim";
    scrim.className = "wiki-chatopt-scrim";
    document.body.appendChild(scrim);
    panel = document.createElement("div");
    panel.id = "wikiChatOpt";
    panel.className = "wiki-chatopt";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Start a chat from this wiki");
    document.body.appendChild(panel);
  }
  // The panel has its own scroll (`max-height: 84vh`), and replacing its innerHTML
  // resets that scroll to 0 — so on a short viewport every re-render (a connector
  // pick, the target landing, a chip click) yanked the reader back to the top, taking
  // Send off screen. Captured and restored around the swap, exactly as `renderList`
  // does for `#wikiList`.
  const scrollTop = panel.scrollTop;
  panel.innerHTML = chatOptionsHtml(state);
  if (scrollTop) panel.scrollTop = scrollTop;
  restoreChatOptFocus(focus);
  // FIRST PAINT ONLY: put the caret in the question box. It is the field the reader
  // came here to fill, and a dialog that opens with nothing focused makes the
  // suggestion chips look like the only way in.
  //
  // Gated on `created`, not on `!focus`: `captureChatOptFocus` returns null for any
  // focused element without an id — which every chip is — so a `!focus` gate
  // re-focused the textarea on every chip click and scrolled a short dialog back to
  // the top, taking Send off screen. The chip handler does its own (preventScroll)
  // focus; this is only for the open.
  if (created) {
    const q = document.getElementById(CHAT_OPT_QUESTION_ID) as HTMLTextAreaElement | null;
    if (q) {
      q.focus({ preventScroll: true });
      // Caret at the END of a prefilled question (direct mode's copy of the Ask
      // box), so typing extends it instead of landing in front of it.
      try { q.setSelectionRange(q.value.length, q.value.length); } catch { /* ignore */ }
    }
  }
}

/**
 * Keep Tab inside the dialog while it is open.
 *
 * The panel declares `role="dialog"` + `aria-modal="true"`, and the scrim only
 * blocks POINTER events: without this, Tab walked straight out of the dialog into
 * the wiki's own list rows and links, which are greyed out and unclickable but still
 * answer Enter — and a screen reader was told the dialog was modal and then read the
 * whole page behind it. Wrapping at both ends is the smallest honest implementation
 * of the claim the markup makes.
 */
function trapChatOptTab(e: KeyboardEvent): void {
  const panel = chatOptPanel();
  if (!panel) return;
  const focusable = Array.prototype.slice
    .call(
      panel.querySelectorAll(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled])',
      ),
    )
    .filter((el: HTMLElement) => el.offsetParent !== null || el === document.activeElement) as
      HTMLElement[];
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  // Focus that has already escaped the dialog (or never entered it) comes back to
  // the top on the next Tab rather than continuing through the page behind.
  if (!active || !panel.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/** POST the escalation. `opts` carries the one field that differs per button:
 *  nothing (first try) · `existingThreadId` (Send there) · `forceNew`. */
async function submitChatOptions(
  win: Window | null,
  opts: { existingThreadId?: string; forceNew?: boolean } = {},
): Promise<void> {
  const state = chatOpt;
  // Belt to the opener's braces: the dialog cannot be opened on a read-only wiki,
  // so this can only fire if the flag flipped under an open panel — but it is the
  // statement that actually spends the thread + the seeded model turn, so it
  // carries its own check rather than trusting how it was reached.
  if (wikiReadonlyWikiFlag()) { if (win) win.close(); return; }
  if (!state || state.sending || !state.target?.botName) { if (win) win.close(); return; }
  // Read the question from state — the dialog's own field in every mode, kept
  // current by the `input` delegation (and fixed at open when pinned).
  const question = currentChatOptQuestion(state);
  state.question = question;
  if (!question || !state.userId) { if (win) win.close(); return; }
  state.sending = true;
  state.status = undefined;
  state.statusIsError = false;
  state.queuedUrl = undefined;
  renderChatOptions();
  const typedName = !!state.threadName.trim();
  try {
    const payload: Record<string, unknown> = {
      wiki: wikiName() || undefined,
      bot: state.botName,
      userId: state.userId,
      question,
      // ALWAYS present, "" included: the key's presence is what tells the route
      // this request made a connector decision ("" = "(bot default)", which is a
      // real choice), and that is what earns the chatUrl's stamp-suppression flag.
      connectorId: state.connectorId,
      threadName: state.threadName.trim() || undefined,
      existingThreadId: opts.existingThreadId,
      forceNew: opts.forceNew || undefined,
    };
    if (state.mode === "article") {
      // The page is sent as a REFERENCE, never as a title/path/summary the seed
      // would quote: the route re-resolves it against the wiki index, so a stale
      // client copy can't put a path in the seed that doesn't resolve.
      payload.mode = "article";
      payload.page = state.article!.name;
      payload.relPath = state.article!.relPath;
    } else if (state.mode === "direct") {
      // The discriminator is explicit: a missing answer alone must stay a 400.
      payload.mode = "direct";
      // The wiki already looked and came up empty on this exact question, and the
      // route knows nothing about that — without the flag the seed opens by
      // ordering the bot to run the search that just failed.
      if (state.askDeclined) payload.askDeclined = true;
    } else {
      const turn = state.turn!;
      payload.answer = turn.answer.slice(0, CHAT_ESC_ANSWER_MAX);
      payload.citations = turn.citations.map((ci) => ({ title: ci.title, pageName: ci.pageName }));
    }
    const { status, ok, data } = await deps.postAskChat(payload);
    if (chatOpt !== state) { if (win) win.close(); return; }
    if (status === 409 && data.nameTaken) {
      // The name collided, but the route checked the colliding thread's own
      // description and it is NOT this article's discussion — an unrelated
      // thread (a `/topic` chat, another wiki's same-titled page) that happens to
      // own the name. There is no "there" to send to, so the only offer is a new
      // thread, which the forceNew walk names with a suffix.
      if (win) win.close();
      state.conflict = { existingThreadId: "", typedName, nameTaken: true };
      state.status = conflictStatusLine(typedName, state.mode, true);
      state.statusIsError = false;
      return;
    }
    if (status === 409 && data.threadExists && data.existingThreadId) {
      if (win) win.close();
      state.conflict = { existingThreadId: data.existingThreadId, typedName };
      // In article mode this 409 is the DESIGNED path, not a failure — the thread
      // is named after the page, so every question after the first collides and
      // belongs in that same thread. The copy says so (`conflictStatusLine`), and
      // "Send there →" is the primary action.
      state.status = conflictStatusLine(typedName, state.mode);
      return;
    }
    if (status === 409 && data.alreadyQueued) {
      // The other question hasn't been opened yet; seeding over it would delete
      // it. Offer the thread itself (opening it delivers that seed) plus the
      // explicit "start another" — never a retry that would 409 identically.
      if (win) win.close();
      state.status = data.error || "A question is already queued on that thread — open it first.";
      state.statusIsError = true;
      state.doneUrl = undefined;
      state.queuedUrl = data.chatUrl;
      return;
    }
    if (!ok || !data.chatUrl) throw new Error(data.error || "HTTP " + status);
    lsSet(chatUserStorageKey(state.botName), state.userId);
    // A pick the route DROPPED (an established thread keeps its own model) is not
    // a preference to remember — storing it would silently re-select a model that
    // never answered anything.
    if (data.connectorApplied !== false) {
      lsSet(wikiConnectorStorageKey(wikiName()), connectorStorageValue(state.connectorId));
    } else {
      state.status = "Sent — but the thread keeps its current model.";
    }
    if (win) win.location.href = data.chatUrl;
    state.conflict = undefined;
    state.doneUrl = data.chatUrl;
    state.openedTab = !!win;
    // Mirror the outcome onto the turn's own bar so it survives closing the panel
    // — the panel is transient, and an Escape or a blocked popup would otherwise
    // lose the only link to the thread this click just created. It matters most on
    // the DECLINE path (which is why that opener passes its turn through): its bar
    // would go on saying "Ask in chat instead →", and the second click would walk
    // 409 recovery for a thread the reader can no longer reach.
    if (state.turn) {
      state.turn.chatEsc = { status: "done", chatUrl: data.chatUrl, opened: !!win };
      deps.refreshChatEscalateBar(state.turn);
    }
  } catch (err) {
    if (win) win.close();
    if (chatOpt !== state) return;
    state.status = "Couldn't start the chat — " + (err instanceof Error ? err.message : String(err));
    state.statusIsError = true;
  } finally {
    if (chatOpt === state) {
      state.sending = false;
      renderChatOptions();
    }
  }
}

/**
 * Close an open ARTICLE dialog when the reader navigates to a different page —
 * the shell's `renderBreadcrumb` seam, so the decision (`shouldCloseArticleChatOnNavigate`)
 * still reads the live `chatOpt` without the shell holding a reference to it.
 */
export function closeChatOptionsIfNavigatingAway(relPath: string): void {
  if (shouldCloseArticleChatOnNavigate(chatOpt, relPath)) closeChatOptions();
}

// ── Listeners (registered by initChatOptions, this module's own) ──────
// Lifted verbatim out of the shell's delegates. The click chain keeps its
// original ORDER, and the click-away test still runs after it, in the same
// listener — see the header for why the registration point matters.

let wired = false;

function wireChatOptions(): void {
  if (wired) return;
  wired = true;
  // The dialog's own click delegation — the four openers plus every control
  // inside the panel, delegated at the document level because the panel (and
  // the panes hosting the openers) is re-rendered from state on every change.
  // The click-away test still runs AFTER the chain, in the same listener.
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    // Chat options popover — two entry points, one panel. The tab is pre-opened
    // SYNCHRONOUSLY inside the click (Safari blocks a `window.open` after an await
    // unconditionally), exactly as the plain escalate button does.
    if (t.closest("#wikiChatEscOptBtn")) openChatOptions("escalate");
    else if (t.closest("#wikiNewChatBtn")) openChatOptions("direct");
    else if (t.closest("#" + DISCUSS_ARTICLE_BTN_ID)) openArticleChat();
    else if (t.closest("#" + DECLINE_CHAT_BTN_ID)) openDeclineChat();
    else if (t.closest("#wikiChatOptClose")) closeChatOptions();
    else if (t.closest("#" + CHAT_OPT_ADV_ID)) {
      // The options disclosure. State-held (never a class poked onto the node), so
      // the next re-render from state doesn't collapse it back under the reader.
      if (chatOpt && !chatOpt.sending) {
        chatOpt.advOpen = !chatOpt.advOpen;
        renderChatOptions();
      }
    } else if (t.closest("[" + CHAT_OPT_SUGGEST_ATTR + "]")) {
      // A starter question FILLS the box and leaves it editable — deliberately not a
      // one-click send. The `desc` prefill in #420 is the cautionary case: a single
      // click from "a sentence about the page" to "the reader's own question, sent".
      //
      // INERT WHILE SENDING, like every other field: `submitChatOptions` reads the
      // question at submit time, but a 409's "Send there →" is a SECOND submit that
      // re-reads it — so a chip clicked while the first POST was in flight silently
      // swapped the question that then went into the existing thread.
      const chip = t.closest("[" + CHAT_OPT_SUGGEST_ATTR + "]") as HTMLElement;
      const q = chip.getAttribute(CHAT_OPT_SUGGEST_ATTR) || "";
      if (chatOpt && !chatOpt.sending) {
        chatOpt.question = q;
        // Counts as the reader's own work: a chip they picked is the only copy of
        // that choice, so Escape confirms before discarding it.
        chatOpt.dirty = true;
        disarmChatOptEscape(chatOpt);
        renderChatOptions();
        const box = document.getElementById(CHAT_OPT_QUESTION_ID) as HTMLTextAreaElement | null;
        if (box) {
          // `preventScroll`: the dialog scrolls internally on a short viewport, and a
          // scroll-into-view here jumped it back to the top on every chip click —
          // taking Send off screen at the moment the reader was ready to press it.
          box.focus({ preventScroll: true });
          try { box.setSelectionRange(box.value.length, box.value.length); } catch { /* ignore */ }
        }
      }
    } else if (t.closest("[" + CHAT_OPT_NAME_CHIP_ATTR + "]")) {
      // A thread-name chip writes the field. An empty value is the "default" chip:
      // `threadName: ""` is exactly what makes the route derive the name again.
      const chip = t.closest("[" + CHAT_OPT_NAME_CHIP_ATTR + "]") as HTMLElement;
      if (chatOpt && !chatOpt.sending) {
        chatOpt.threadName = chip.getAttribute(CHAT_OPT_NAME_CHIP_ATTR) || "";
        // Same reason the typed path clears these: the collision was against the OLD
        // name, and a foot still offering "Send there →" would post a thread id the
        // new name has nothing to do with.
        chatOpt.conflict = undefined;
        chatOpt.queuedUrl = undefined;
        disarmChatOptEscape(chatOpt);
        renderChatOptions();
      }
    }
    else if (t.closest("#wikiChatOptSend")) void submitChatOptions(window.open("", "_blank"));
    else if (t.closest("#wikiChatOptSendThere")) {
      void submitChatOptions(window.open("", "_blank"), {
        existingThreadId: chatOpt?.conflict?.existingThreadId,
      });
    } else if (t.closest("#wikiChatOptForce")) {
      void submitChatOptions(window.open("", "_blank"), { forceNew: true });
    }
    // Click-away dismissal, evaluated AFTER the chain so a click on another control
    // still does its own job (and the two openers above aren't self-closing). The
    // decision is the pure `shouldCloseChatOptions` — in particular a target the
    // submit's own synchronous re-render has DETACHED is not an outside click.
    if (
      chatOpt &&
      shouldCloseChatOptions({
        open: true,
        attached: document.contains(t),
        inPanel: !!t.closest("#wikiChatOpt"),
        inOpener:
          !!t.closest("#wikiChatEscOptBtn") ||
          !!t.closest("#wikiNewChatBtn") ||
          !!t.closest("#" + DISCUSS_ARTICLE_BTN_ID) ||
          !!t.closest("#" + DECLINE_CHAT_BTN_ID),
        sending: chatOpt.sending,
      })
    ) {
      // A click-away with a question the reader TYPED gets the same protection Escape
      // gives it, rather than silently discarding it. This matters more now than it did
      // for the anchored popover: with a scrim, EVERY outside click lands on the scrim,
      // so one stray click over a dimmed page used to throw away a composed question.
      // × and Escape (twice) remain the deliberate ways out, and the status line says so.
      if (
        chatOptEscapeAction({
          question: currentChatOptQuestion(chatOpt),
          escArmed: chatOpt.escArmed,
          dirty: chatOpt.dirty,
          settled: !!chatOpt.doneUrl || !!chatOpt.queuedUrl,
        }) === "confirm"
      ) {
        chatOpt.escArmed = true;
        chatOpt.status = CHAT_OPT_ESC_CONFIRM;
        chatOpt.statusIsError = false;
        repaintChatOptFoot();
      } else {
        closeChatOptions();
      }
    }
  });

  // Popover field changes — delegated (the panel is re-rendered from state on every
  // change, so direct listeners wouldn't survive). Nothing is read back off the DOM.
  document.addEventListener("change", (e) => {
    const state = chatOpt;
    if (!state) return;
    const el = e.target as HTMLElement;
    if (el.id === "wikiChatOptBot") {
      state.botName = (el as HTMLSelectElement).value;
      state.target = null;
      state.conflict = undefined;
      state.queuedUrl = undefined;
      state.status = undefined;
      state.error = undefined;
      // Users and connector preferences are BOT-keyed: carrying the old bot's picks
      // into the refetch would either post a user this bot doesn't have or preselect
      // a model against the wrong preference.
      state.userId = "";
      state.connectorId = "";
      if (state.botName) void loadChatTarget();
      else renderChatOptions();
    } else if (el.id === "wikiChatOptUser") {
      state.userId = (el as HTMLSelectElement).value;
      state.conflict = undefined;
      state.queuedUrl = undefined;
      // The connector preference is per user+bot, so re-resolve it for the new user.
      // Only the foot repaints synchronously (the pick just un-blocked Send); the
      // full re-render waits for the preference rather than running twice.
      repaintChatOptFoot();
      void (async () => {
        const preferred = await fetchPreferredConnector(state.userId, state.botName);
        if (chatOpt !== state || !state.target) return;
        state.connectorId = pickConnectorId(
          state.target, lsGet(wikiConnectorStorageKey(wikiName())), preferred,
        );
        renderChatOptions();
      })();
    } else if (el.id === "wikiChatOptConn") {
      state.connectorId = (el as HTMLSelectElement).value;
      renderChatOptions();
    }
  });

  // Typing paths. Both repaint IN PLACE rather than re-rendering the panel, so the
  // focused field keeps its caret — but they must repaint the status line and the
  // action row too, not just the preview:
  //   • editing the thread name CLEARS a name collision, and a foot still offering
  //     "Send there →" then posts `existingThreadId: undefined`, which silently
  //     creates a brand-new thread instead of sending where it says;
  //   • the question box un-blocks (or re-blocks) Send, and drives both the
  //     thread-name preview in the summary line and the name field's placeholder.
  document.addEventListener("input", (e) => {
    const state = chatOpt;
    const el = e.target as HTMLElement;
    if (!state) return;
    if (el.id === "wikiChatOptName") {
      state.threadName = (el as HTMLInputElement).value;
      state.conflict = undefined;
      state.queuedUrl = undefined;
      state.status = undefined;
      // Editing the name clears the status line, which is where an armed Escape
      // announced itself — so the flag has to go with it.
      state.escArmed = false;
      repaintChatOptFoot();
      return;
    }
    // The question — one field, every mode. A collision is deliberately NOT cleared
    // here: it is a collision on the NAME, and after the 409 the reader may well
    // refine the question and then hit "Send there →", which needs the thread id
    // still on state.
    if (el.id === CHAT_OPT_QUESTION_ID) {
      state.question = (el as HTMLTextAreaElement).value;
      state.dirty = true;
      // Typing disarms the discard confirmation — a stale "press Esc again" would
      // otherwise discard a question the reader had gone back to editing.
      disarmChatOptEscape(state);
      // The thread-name placeholder follows the question in the modes that derive the
      // name from it (i.e. not article mode, whose name comes from the page).
      const name = document.getElementById("wikiChatOptName") as HTMLInputElement | null;
      if (name) name.placeholder = previewThreadName("", currentChatOptNameSource(state));
      repaintChatOptFoot();
    }
  });

  // Dialog keyboard handling.
  //
  // Escape closes it — but a question the reader TYPED (or picked from a chip) exists
  // only inside this dialog, so it gets a confirm-then-discard: the first Escape says
  // so in the status line, the second closes. The decision is the pure
  // `chatOptEscapeAction`; a prefilled question is reproducible and closes at once.
  //
  // ⌘↵ / Ctrl↵ in the question box starts the chat, so the common case never needs
  // the mouse. It goes through the SAME pre-opened-tab discipline as the Send button
  // (Safari blocks a `window.open` issued after an await unconditionally), and is
  // gated on the same conditions the button's disabled state is derived from —
  // otherwise the shortcut would fire a blank tab that opens and closes again.
  document.addEventListener("keydown", (e) => {
    const state = chatOpt;
    if (!state) return;
    if (e.key === "Tab") {
      trapChatOptTab(e);
      return;
    }
    if (e.key === "Escape") {
      const action = chatOptEscapeAction({
        question: currentChatOptQuestion(state),
        escArmed: state.escArmed,
        dirty: state.dirty,
        // Sent, or already queued on the target thread: there is nothing left to
        // protect, and "press Esc again to discard this question" read as a warning
        // about work the reader had in fact just completed.
        settled: !!state.doneUrl || !!state.queuedUrl,
      });
      if (action === "confirm") {
        state.escArmed = true;
        state.status = CHAT_OPT_ESC_CONFIRM;
        state.statusIsError = false;
        repaintChatOptFoot();
        return;
      }
      closeChatOptions();
      return;
    }
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    const el = e.target as HTMLElement | null;
    if (!el || el.id !== CHAT_OPT_QUESTION_ID) return;
    // A conflict or a queued seed is a decision the reader has to make with the
    // buttons (send there / start another / open it) — there is no single "primary"
    // action left for the shortcut to stand for.
    if (state.sending || state.conflict || state.queuedUrl || state.doneUrl) return;
    if (!state.target?.botName || !state.userId || !currentChatOptQuestion(state)) return;
    e.preventDefault();
    void submitChatOptions(window.open("", "_blank"));
  });
}
