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
import { deriveAskThreadTitle } from "../../../wiki/ask-chat.ts";

export { deriveAskThreadTitle };

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

/** `GET /api/wiki/chat-target` response. `botName === null` ⇒ `reason` says why. */
export interface ChatTarget {
  wiki?: string;
  botName: string | null;
  reason?: "unknown_bot" | "bot_gone" | "needs_bot";
  error?: string;
  needsBot: boolean;
  bots: { name: string }[];
  users: { id: string; name: string }[];
  defaultUserId: string | null;
  connectors: ChatTargetConnector[];
  connectorsError?: string;
  botDefault: ChatTargetBotDefault | null;
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
 * Which user the popover preselects: the remembered one (if this bot still has
 * it) → the bot's `bot_default_user` mapping → the sole user → none.
 *
 * Never positional beyond the sole-user case — picking `users[0]` out of several
 * attributes a thread (and everything the pipeline extracts from it) to whoever
 * happens to sort first.
 */
export function pickUserId(target: ChatTarget, stored?: string | null): string {
  const has = (id?: string | null): boolean => !!id && target.users.some((u) => u.id === id);
  if (has(stored)) return stored as string;
  if (has(target.defaultUserId)) return target.defaultUserId as string;
  if (target.users.length === 1) return target.users[0]!.id;
  return "";
}

/**
 * Which connector the popover preselects: this wiki's last-used escalation
 * connector → the user+bot's persisted chat preference → `""` (bot default).
 *
 * A remembered id that no longer names a live connector row falls through rather
 * than preselecting an option the picker cannot show.
 */
export function pickConnectorId(
  target: ChatTarget,
  stored?: string | null,
  preferred?: string | null,
): string {
  const has = (id?: string | null): boolean => !!id && target.connectors.some((c) => c.id === id);
  if (has(stored)) return stored as string;
  if (has(preferred)) return preferred as string;
  return "";
}

/** Suffix naming the one capability difference that changes what the seed may
 *  promise. Only ever states the ABSENCE — a "web search" badge on the majority
 *  of options is noise. */
export function capabilitySuffix(supportsWebTools: boolean): string {
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
  const row = target.connectors.find((c) => c.id === connectorId);
  return row ? row.supportsWebTools : !!target.botDefault?.supportsWebTools;
}

/**
 * The name the thread will really get: the typed override when it is non-blank,
 * else the question — through `deriveAskThreadTitle` either way, so the preview
 * shows the same lowercased, flattened, ≤50-char string the route creates instead
 * of leaving the reader to discover the normalization after the fact.
 */
export function previewThreadName(typed: string, question: string): string {
  const raw = typed && typed.trim() ? typed : question;
  return deriveAskThreadTitle(raw || "");
}

/** Copy for the 409 a colliding thread name produces. Parameterized on WHERE the
 *  colliding name came from, because "a chat for this question already exists"
 *  is a lie when the reader typed the name themselves. */
export function conflictCopy(nameWasTyped: boolean): string {
  return nameWasTyped
    ? "A chat with that name already exists."
    : "A chat for this question already exists.";
}
