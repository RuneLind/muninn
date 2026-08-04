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
 * do exactly that must not close the panel out from under them.
 */
export function shouldCloseChatOptions(ctx: ChatOptClickContext): boolean {
  if (!ctx.open) return false;
  if (ctx.sending) return false;
  if (!ctx.attached) return false;
  if (ctx.inPanel || ctx.inOpener) return false;
  if (ctx.mode === "direct" && ctx.inQuestionBox) return false;
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
