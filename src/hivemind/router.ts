import { basename } from "node:path";
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
 * Stable across peer reconnects — the broker's `from_id` UUID rotates per
 * session, but cwd basename does not.
 */
export function peerNameFor(msg: { fromCwd: string; fromSummary: string; fromId: string }): string {
  const cwdBase = basename(msg.fromCwd).trim();
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
    const [messageId, conv] = await Promise.all([
      saveMessage({
        userId,
        botName,
        role: "peer",
        content: msg.text,
        platform,
        threadId: thread.id,
        fromPeerId: msg.fromId,
      }),
      this.chatState.findOrCreateBotConversation({ botName, userId }),
    ]);

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
