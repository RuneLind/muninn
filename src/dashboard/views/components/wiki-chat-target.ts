/**
 * Pure model for the wiki reader's "start a chat from here" popover.
 *
 * DOM-free and dependency-light on purpose (the `wiki-explain.ts` /
 * `wiki-integrate.ts` split rationale): `wiki-browser.ts` is bundled into the
 * browser, so everything decidable without a document — which user and which
 * connector a fresh escalation defaults to, how each option is labelled, and what
 * the thread will actually be named — lives here and is unit-tested, while the
 * bundle keeps only the wiring.
 *
 * `deriveAskThreadTitle` is imported from the SERVER's own `src/wiki/ask-chat.ts`
 * rather than re-implemented: that module is pure string work with no imports, and
 * the name preview must be byte-identical to the name the route creates (the
 * `synthesisTopicKey` precedent).
 */
import { deriveAskThreadTitle, deriveAskThreadTitleOrNull } from "../../../wiki/ask-chat.ts";
import { escHtml as esc } from "./escape.ts";
import { explainSelectionFromLabel } from "./wiki-explain.ts";

/** One named connector row as `GET /api/wiki/chat-target` serves it — capability
 *  already resolved server-side (`connectorCapabilities` cannot run here). */
export interface ChatTargetConnector {
  id: string;
  name: string;
  connectorType: string;
  supportsWebTools: boolean;
}

/** The bot's own connector, i.e. what "(bot default)" actually means. */
export interface ChatTargetBotDefault {
  connectorType: string;
  model?: string;
  supportsWebTools: boolean;
}

/**
 * `GET /api/wiki/chat-target` response.
 *
 * `botName === null` ⇒ `reason` says why and `bots` carries the picker's options;
 * NOTHING else is present on that branch (the route used to ship four dummy
 * fields, and a `needsBot` boolean that only ever re-encoded `reason`). The
 * fields the ok branch fills are therefore optional here, and every consumer
 * below tolerates their absence.
 */
export interface ChatTarget {
  botName: string | null;
  reason?: "unknown_bot" | "bot_gone" | "needs_bot";
  error?: string;
  /** Only on the failure branch — the bot picker's options. */
  bots?: { name: string }[];
  users?: { id: string; name: string }[];
  defaultUserId?: string | null;
  /** Which user `preferredConnectorId` belongs to (a preference is per user+bot,
   *  so a client landing on a different user must refetch it). */
  preferredForUserId?: string | null;
  preferredConnectorId?: string | null;
  connectors?: ChatTargetConnector[];
  connectorsError?: string;
  botDefault?: ChatTargetBotDefault | null;
}

/** Where the chat page stores the user it is on — SHARED with this popover on
 *  purpose: the chat page overwrites it on every user switch and on the deep link
 *  this feature generates, so "the user I chat as" is one answer, not two. */
export function chatUserStorageKey(botName: string): string {
  return "muninn-chat-user-" + botName;
}

/** Last connector used for an escalation FROM this wiki. Scoped per wiki (not per
 *  bot): "which model reads mimir for me" is a per-wiki habit, and it deliberately
 *  does not disturb the chat page's own `muninn-connector-<bot>` sidebar memory. */
export function wikiConnectorStorageKey(wiki: string): string {
  return "muninn-wiki-chat-connector-" + (wiki || "__default__");
}

/**
 * Stored value meaning "(bot default) was a deliberate choice here".
 *
 * "(bot default)" is the empty connector id, and storing `""` was indistinguishable
 * from storing nothing: {@link pickConnectorId}'s membership test can never match
 * it, so the next open fell straight through to the user+bot chat preference and
 * silently re-selected a named model the reader had explicitly moved off. A
 * sentinel makes the choice rememberable; it is mapped back to `""` on read.
 */
export const WIKI_CONNECTOR_DEFAULT = "__default__";

/**
 * Which user the popover preselects: the remembered one (if this bot still has
 * it) → the bot's `bot_default_user` mapping → the sole user → none.
 *
 * Never positional beyond the sole-user case — picking `users[0]` out of several
 * attributes a thread (and everything the pipeline extracts from it) to whoever
 * happens to sort first.
 */
export function pickUserId(target: ChatTarget, stored?: string | null): string {
  const users = target.users ?? [];
  const has = (id?: string | null): boolean => !!id && users.some((u) => u.id === id);
  if (has(stored)) return stored as string;
  if (has(target.defaultUserId)) return target.defaultUserId as string;
  if (users.length === 1) return users[0]!.id;
  return "";
}

/**
 * Which connector the popover preselects: this wiki's last-used escalation
 * connector → the user+bot's persisted chat preference → `""` (bot default).
 *
 * A remembered id that no longer names a live connector row falls through rather
 * than preselecting an option the picker cannot show — but a remembered
 * {@link WIKI_CONNECTOR_DEFAULT} is a real remembered ANSWER and stops the chain.
 */
export function pickConnectorId(
  target: ChatTarget,
  stored?: string | null,
  preferred?: string | null,
): string {
  if (stored === WIKI_CONNECTOR_DEFAULT) return "";
  const rows = target.connectors ?? [];
  const has = (id?: string | null): boolean => !!id && rows.some((c) => c.id === id);
  if (has(stored)) return stored as string;
  if (has(preferred)) return preferred as string;
  return "";
}

/** What to store for a pick so it survives to the next open — the sentinel for
 *  "(bot default)", the id otherwise. */
export function connectorStorageValue(connectorId: string): string {
  return connectorId || WIKI_CONNECTOR_DEFAULT;
}

/** Suffix naming the one capability difference that changes what the seed may
 *  promise. Only ever states the ABSENCE — a "web search" badge on the majority
 *  of options is noise. */
function capabilitySuffix(supportsWebTools: boolean): string {
  return supportsWebTools ? "" : " · no web search";
}

/** Label for a named connector option. */
export function connectorOptionLabel(row: ChatTargetConnector): string {
  return row.name + capabilitySuffix(row.supportsWebTools);
}

/** Label for the empty "(bot default)" option — which is a REAL choice (it means
 *  "no connector on the thread", i.e. whatever the bot is configured with), so it
 *  carries its resolved capability like every other option. */
export function botDefaultOptionLabel(botDefault: ChatTargetBotDefault | null): string {
  if (!botDefault) return "Bot default";
  const model = botDefault.model ? " · " + botDefault.model : "";
  return (
    "Bot default (" + botDefault.connectorType + model + ")" +
    capabilitySuffix(botDefault.supportsWebTools)
  );
}

/** Whether the CHOSEN option can actually run a web search — the same resolution
 *  the route runs before deciding what the seed may claim. */
export function chosenSupportsWebTools(target: ChatTarget, connectorId: string): boolean {
  if (!connectorId) return !!target.botDefault?.supportsWebTools;
  const row = (target.connectors ?? []).find((c) => c.id === connectorId);
  return row ? row.supportsWebTools : !!target.botDefault?.supportsWebTools;
}

/**
 * The name the thread will really get: the typed override when it derives a name
 * at all, else the question — mirroring the route's own fallback exactly (a typed
 * name of only control characters has no name in it, so the question wins there
 * too), and through the same derivation, so the preview shows the same
 * lowercased, flattened, ≤50-char string `createThread` stores.
 */
export function previewThreadName(typed: string, question: string): string {
  return deriveAskThreadTitleOrNull(typed || "") ?? deriveAskThreadTitle(question || "");
}

/**
 * The question the popover would send RIGHT NOW.
 *
 * Three sources, and the split is the whole point:
 * - **Pinned** (the decline hook) — the question belongs to the TURN that failed
 *   and is fixed at open time. It is never re-read from the Ask box, and the box
 *   is never written to: overwriting it destroyed whatever draft the reader had
 *   typed, left the failed question armed in the box afterwards, and on the
 *   Connections tab wrote into a hidden textarea.
 * - **Escalate** — the turn's own question, snapshotted at open.
 * - **Direct** (the "New chat" button) — whatever the LIVE Ask box holds at this
 *   instant, deliberately re-read at submit: the reader can (and, when the panel
 *   says "Type a question first", must) keep typing with the panel up.
 *
 * `boxValue` is `null` when there is no Ask box in the document at all.
 */
export function chatOptQuestion(
  state: { mode: "direct" | "escalate"; question: string; pinnedQuestion?: string },
  boxValue: string | null,
): string {
  if (typeof state.pinnedQuestion === "string") return state.pinnedQuestion.trim();
  if (state.mode !== "direct") return state.question;
  return (boxValue || "").trim();
}

/** The turn fields {@link composeDeclineQuestion} needs — a structural subset of
 *  the reader's `AskTurn` (and of the persisted `StoredAskTurn`, which carries
 *  both extra fields precisely so a rehydrated declined turn still composes). */
export interface DeclineQuestionTurn {
  /** The turn's displayed question — for an Explain turn this is the LABEL. */
  question: string;
  /** Explain turns: the page the passage was selected from (title, else name). */
  explainPage?: string;
  /** Follow-up turns: the question that opened this chain, already composed. */
  originQuestion?: string;
}

/**
 * The question a declined turn actually escalates with — which is NOT always its
 * displayed one.
 *
 * Two turn kinds carry a question that cannot be answered on its own, and both
 * reach the decline hook:
 * - an **Explain** turn's question is the display label `Explain: "<80-char
 *   slice>…"` (the real question is built server-side from `sel` and never comes
 *   back), so the passage is re-stated together with the page it was read on;
 * - a **follow-up** turn's question is the raw follow-up text ("and what about
 *   the second one?"), which only means anything after the question that opened
 *   the chain — so that origin is prepended.
 *
 * A plain Ask question is returned untouched. The two branches are exclusive by
 * construction (a follow-up always goes through the plain-question path, so it
 * never carries `explainPage`), and the origin is deliberately NOT re-wrapped
 * when it already equals the question.
 *
 * The framing stays third-person about the reader for the same reason
 * `buildDirectChatSeed`'s opening does: a first-person "I first asked …" is prose
 * the memory extractor happily records as a fact about the user.
 */
export function composeDeclineQuestion(turn: DeclineQuestionTurn): string {
  const question = (turn.question || "").trim();
  const page = (turn.explainPage || "").trim();
  if (page) {
    const sel = explainSelectionFromLabel(question);
    return sel
      ? `About the wiki page "${page}": explain this passage — "${sel}"`
      : `About the wiki page "${page}": ${question}`;
  }
  const origin = (turn.originQuestion || "").trim();
  if (origin && origin !== question) {
    return `Context — the earlier question in this wiki session was "${origin}". ` +
      `Follow-up: ${question}`;
  }
  return question;
}

/** What the popover's document-level click listener knows about one click. */
export interface ChatOptClickContext {
  /** The popover is open at all. */
  open: boolean;
  /** The click target is STILL in the document. A submit re-renders the panel
   *  from state, which detaches the very button that was clicked. */
  attached: boolean;
  /** The click landed inside the panel. */
  inPanel: boolean;
  /** The click landed on one of the two buttons that OPEN the panel. */
  inOpener: boolean;
  /** A submit is in flight (its own click is what re-rendered the panel). */
  sending: boolean;
  /** The click landed in the Ask box — direct mode reads its question from
   *  there, so it is part of the popover's flow, not an outside click. */
  inQuestionBox: boolean;
  /** The popover's question is PINNED to a turn (the decline hook), so the Ask
   *  box is no longer part of its flow — see {@link chatOptQuestion}. */
  pinned: boolean;
  mode: "direct" | "escalate";
}

/**
 * Whether a document click should dismiss the popover.
 *
 * The two non-obvious rules both come from the same failure: `submitChatOptions`
 * sets `sending` and re-renders SYNCHRONOUSLY before its first await, so by the
 * time this listener runs, the Send button the user clicked is detached — a bare
 * `closest("#wikiChatOpt")` test then reports "outside", the panel closes, and
 * the in-flight submit sees `chatOpt !== state` and closes the pre-opened tab.
 * Net effect: a thread and a seed were created server-side and the reader saw
 * nothing, with the retry hitting `alreadyQueued`. So a detached target is never
 * an outside click, and neither is anything at all while a submit is in flight.
 *
 * The third rule is the empty-question recovery path: in direct mode the panel
 * tells the reader to "Type a question first", and clicking into the Ask box to
 * do exactly that must not close the panel out from under them. It does NOT
 * apply to a PINNED question (the decline hook), which neither reads nor writes
 * the box — there the box is an unrelated control like any other.
 */
export function shouldCloseChatOptions(ctx: ChatOptClickContext): boolean {
  if (!ctx.open) return false;
  if (ctx.sending) return false;
  if (!ctx.attached) return false;
  if (ctx.inPanel || ctx.inOpener) return false;
  if (ctx.mode === "direct" && !ctx.pinned && ctx.inQuestionBox) return false;
  return true;
}

/** Copy for the 409 a colliding thread name produces. Parameterized on WHERE the
 *  colliding name came from, because "a chat for this question already exists"
 *  is a lie when the reader typed the name themselves. */
export function conflictCopy(nameWasTyped: boolean): string {
  return nameWasTyped
    ? "A chat with that name already exists."
    : "A chat for this question already exists.";
}

/** Id of the decline hook's button — shared by {@link declineChatBarHtml}, the
 *  reader's click delegation and its click-away opener test, so the three can't
 *  drift. */
export const DECLINE_CHAT_BTN_ID = "wikiChatDeclineBtn";

/** Why the wiki declined, in the reader's words. `low_confidence` must NOT read as
 *  "nothing found" — weak sources did ride out and are listed under the answer, so
 *  the honest framing is "nothing solid", not "nothing". */
function declineNote(reason: "no_hits" | "low_confidence"): string {
  return reason === "low_confidence"
    ? "The wiki had nothing solid on this."
    : "The wiki had nothing on this.";
}

/**
 * The decline hook: the whole inner markup of the escalate bar for a turn the wiki
 * DECLINED to answer, rendered in place of the ordinary "Continue in chat →"
 * button. Pure `reason → html` (no user content is interpolated, so nothing here
 * needs escaping) and it is what makes the hook derivable from turn state alone —
 * `wiki-browser.ts` holds only the wiring.
 *
 * The action is the direct-mode chat path: an honest failure is exactly the moment
 * to offer the bot its tools and memories instead of the wiki index, and the reader
 * should not have to retype the question to get there. (The complementary case —
 * a confident answer the reader still wants to take further — is served by the
 * always-visible "New chat" button beside the Ask box.)
 */
export function declineChatBarHtml(reason: "no_hits" | "low_confidence"): string {
  return (
    '<span class="wiki-chatesc-msg">' + declineNote(reason) + "</span>" +
    '<button id="' + DECLINE_CHAT_BTN_ID + '" class="wiki-chatesc-btn wiki-chatesc-decline">' +
    "Ask in chat instead →</button>"
  );
}

/** Escalation state of one Ask turn, held on the TURN and never in the DOM:
 *  `#wikiChatEscBar` is a singleton node owned by whichever turn is painted, so a
 *  fetch resolving after a turn switch used to paint turn A's "✓ Opened in chat"
 *  (linking A's thread) onto turn B's bar — and on the error path wrote into a
 *  detached node, so the user saw no error at all. */
export interface ChatEscState {
  status: "pending" | "done" | "exists" | "error";
  /** `done`: the thread just created · `exists`: the thread that already covers
   *  this question (built from the 409 body). Absent when the server didn't say. */
  chatUrl?: string;
  /** Whether the deep link actually got a tab — a blocked popup says so honestly
   *  instead of claiming it opened one. */
  opened?: boolean;
  /** Failure copy for the `error` state. */
  message?: string;
}

/** The turn fields {@link chatEscBarHtml} renders from — a structural subset of
 *  the reader's `AskTurn`. */
export interface ChatEscTurn {
  answer: string;
  kind?: string;
  declined?: "no_hits" | "low_confidence";
  chatEsc?: ChatEscState;
}

/**
 * Inner markup of the escalate bar, DERIVED from turn state so a re-render — a
 * `done` refresh, a turn switch, re-opening the turn from history — reproduces
 * the state instead of losing (or misattributing) it.
 *
 * **Branch order is load-bearing.** A REALISED escalation (`done`/`exists` — a
 * thread exists and the reader's only way back to it is this link) outranks the
 * decline hook, which is an offer to start one. Ordering the decline check first
 * shadowed the link silently: a declined turn whose escalation succeeded went on
 * showing "Ask in chat instead →", and the second click walked 409 recovery for a
 * thread the reader could no longer reach.
 */
export function chatEscBarHtml(turn: ChatEscTurn): string {
  // No committed answer (still streaming, or a turn that died at app_error / an
  // SSE drop): the click's only possible outcome is a silent no-op, so render no
  // bar at all rather than a button that does nothing.
  if (!turn.answer) return "";
  // Fact-check turns are excluded: the question is synthetic and the answer is
  // tool-produced, so the seed's "answered from indexed page excerpts alone — no
  // memories, no tools" framing would be false.
  if (turn.kind === "factcheck") return "";
  const st = turn.chatEsc;
  if (st?.status === "done") {
    return (
      '<a class="wiki-chatesc-done" href="' + esc(st.chatUrl || "") + '" target="_blank">' +
      (st.opened ? "✓ Opened in chat →" : "Chat thread created — open it →") +
      "</a>"
    );
  }
  if (st?.status === "exists") {
    // A 409 is NOT auto-retried with `forceNew` — that minted a fresh thread (and
    // a fresh auto-sent model turn) on every re-click. Offer the existing thread,
    // and make starting another an explicit second choice.
    return (
      '<span class="wiki-chatesc-msg">A chat for this question already exists' +
      (st.chatUrl
        ? ' — <a class="wiki-chatesc-done" href="' + esc(st.chatUrl) + '" target="_blank">Open it →</a>'
        : "") +
      "</span>" +
      '<button id="wikiChatEscNewBtn" class="wiki-chatesc-btn">Start new thread</button>'
    );
  }
  // The wiki declined this question (no hits, or only weak nearest-neighbours):
  // offer the chat escalation as the PROMINENT next step instead of the ordinary
  // "Continue in chat →" button, which reads as an optional extra on an answer
  // that doesn't exist. Derived from `turn.declined`, so it survives a turn
  // switch and a reload.
  if (turn.declined) return declineChatBarHtml(turn.declined);
  const pending = st?.status === "pending";
  return (
    '<button id="wikiChatEscBtn" class="wiki-chatesc-btn"' + (pending ? " disabled" : "") + ">" +
    (pending ? "Opening chat…" : "Continue in chat →") + "</button>" +
    // Same escalation, with the choices the one-click path decides for you (user,
    // model, thread name). Opens the shared popover.
    '<button id="wikiChatEscOptBtn" class="wiki-chatesc-gear" title="Chat options…"' +
    (pending ? " disabled" : "") + ' aria-label="Chat options">⚙</button>' +
    '<span class="wiki-chatesc-msg' + (st?.status === "error" ? " error" : "") +
    '" id="wikiChatEscMsg">' + esc(st?.status === "error" ? st.message || "" : "") + "</span>"
  );
}
