import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Platform } from "../types.ts";
import { processMessage } from "../core/message-processor.ts";

import { simulatorState, type SimMessage } from "./state.ts";

/**
 * Bridges the simulator state to the core message processor.
 *
 * Creates platform-appropriate say/setStatus/postToChannel callbacks
 * that write to simulator state and broadcast via WebSocket.
 */
export async function processSimulatorMessage(
  conversationId: string,
  text: string,
  botConfig: BotConfig,
  config: Config,
): Promise<void> {
  const conversation = simulatorState.getConversation(conversationId);
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} not found`);
  }

  // Messages sent from the chat page are stored as "web" platform, even when
  // continuing a conversation that originated on Telegram or Slack.
  const platform: Platform = "web";
  // The original conversation type is still used for context gathering (e.g.
  // Slack channel messages) and response formatting.
  const isSlack = conversation.type.startsWith("slack_");

  // Gather recent channel messages for context BEFORE adding user message
  // (avoids double-counting — the current message is already passed as `text`)
  const recentChannelMessages = isSlack && conversation.messages.length > 0
    ? conversation.messages
        .slice(-15)
        .map((m) => `${m.sender === "user" ? conversation.username : botConfig.name}: ${m.text}`)
    : undefined;

  // Add user message to state (after gathering context)
  const userMessage: SimMessage = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    sender: "user",
    text,
  };
  simulatorState.addMessage(conversationId, userMessage);

  // Create say callback — adds bot message to conversation state
  // Note: does NOT clear status here — status is cleared after processMessage completes
  // to avoid flickering during multi-chunk Telegram responses
  const say = async (message: string): Promise<void> => {
    const botMessage: SimMessage = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      sender: "bot",
      text: message,
    };
    simulatorState.addMessage(conversationId, botMessage);
  };

  // Create setStatus callback — updates conversation status
  const setStatus = async (status: string): Promise<void> => {
    simulatorState.setStatus(conversationId, status);
  };

  // Create postToChannel callback for Slack conversation types
  const postToChannel = isSlack
    ? async (channel: string, message: string): Promise<void> => {
        // Find or create the target channel conversation
        const channelConv = simulatorState.findOrCreateChannel(
          conversation.botName,
          channel,
          conversation.userId,
          conversation.username,
        );
        const botMessage: SimMessage = {
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          sender: "bot",
          text: message,
        };
        simulatorState.addMessage(channelConv.id, botMessage);
      }
    : undefined;

  // Determine channel context for Slack channels
  const channelContext = conversation.channelName ?? undefined;

  try {
    await processMessage({
      text,
      userId: conversation.userId,
      username: conversation.username,
      platform,
      botConfig,
      config,
      say,
      setStatus,
      postToChannel,
      channelContext,
      recentChannelMessages,
    });
  } finally {
    simulatorState.setStatus(conversationId, "");
  }
}
