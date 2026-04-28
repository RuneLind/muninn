/**
 * Routes inbound peer messages that have no pending `ask_peer` resolver.
 *
 * Phase 2 behavior:
 *  - Resolve the bot's default user (the synthetic owner from migration 027).
 *  - Derive a stable peer name from the inbound message's `from_cwd` basename.
 *  - Find or create a `peer:<name>` thread under that user.
 *  - Persist the message with role='peer' and from_peer_id set to the broker's
 *    per-session peer ID.
 *  - Make sure the bot owner's web conversation exists in chat state, append
 *    the message, and publish so any open chat-page WebSocket sees it live.
 *
 * The bot's connector is intentionally NOT invoked here — autorespond and
 * loop guards land in Phase 3. Phase 2 surfaces the message and lets the
 * human reply manually via the chat UI.
 */

import { getLog } from "../logging.ts";
import type { ChatState, ChatMessage } from "../chat/state.ts";
import type { Platform } from "../types.ts";
import { saveMessage } from "../db/messages.ts";
import { getOrCreatePeerThread } from "../db/threads.ts";
import { getBotDefaultUser } from "../db/chat-preferences.ts";

const log = getLog("hivemind", "router");

export interface InboundPeerMessage {
  fromId: string;
  fromSummary: string;
  fromCwd: string;
  text: string;
  sentAt: string;
}

/**
 * Derive a stable, human-readable peer name from the broker's `from_cwd`.
 * Falls back to a slug of `from_summary` and then to the per-session ID prefix
 * so we never produce an empty thread suffix.
 */
export function peerNameFor(msg: { fromCwd: string; fromSummary: string; fromId: string }): string {
  const cwdBase = msg.fromCwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.trim();
  if (cwdBase) return cwdBase;
  const summarySlug = msg.fromSummary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (summarySlug) return summarySlug;
  return `peer-${msg.fromId.slice(0, 8)}`;
}

export class HivemindRouter {
  constructor(private chatState: ChatState) {}

  /**
   * Handle an unsolicited inbound peer message addressed to `botName`.
   * Returns the persisted message id, or null if the bot has no default user
   * configured (in which case there's no thread to attach the message to).
   */
  async route(botName: string, msg: InboundPeerMessage): Promise<string | null> {
    const userId = await getBotDefaultUser(botName);
    if (!userId) {
      log.warn(
        "Inbound peer message for bot {botName} dropped — no default user configured. " +
          "Set one via the chat page or POST /chat/bot-preferences/{botName}/default-user.",
        { botName, fromId: msg.fromId },
      );
      return null;
    }

    const peerName = peerNameFor(msg);
    const thread = await getOrCreatePeerThread(userId, botName, peerName);

    const platform: Platform = "web";
    const messageId = await saveMessage({
      userId,
      botName,
      role: "peer",
      content: msg.text,
      platform,
      threadId: thread.id,
      fromPeerId: msg.fromId,
    });

    const conv = await this.chatState.findOrCreateBotConversation({ botName, userId });
    const chatMessage: ChatMessage = {
      id: messageId,
      timestamp: new Date(msg.sentAt).getTime() || Date.now(),
      sender: "peer",
      text: msg.text,
      threadId: thread.id,
      fromPeerId: msg.fromId,
    };
    this.chatState.addMessage(conv.id, chatMessage);

    log.info(
      "Routed inbound peer message from {fromId} ({peerName}) to thread {threadName}",
      { botName, fromId: msg.fromId, peerName, threadName: thread.name },
    );
    return messageId;
  }
}
