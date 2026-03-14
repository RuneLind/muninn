import type { Config } from "../config.ts";
import type { BotConfig, ConnectorType } from "../bots/config.ts";
import type { Platform } from "../types.ts";
import { processMessage } from "../core/message-processor.ts";
import type { Connector } from "../db/connectors.ts";

import { chatState, type ChatMessage } from "./state.ts";

/**
 * Bridges the chat state to the core message processor.
 *
 * Creates platform-appropriate say/setStatus/postToChannel callbacks
 * that write to chat state and broadcast via WebSocket.
 */
export async function processChatMessage(
  conversationId: string,
  text: string,
  botConfig: BotConfig,
  config: Config,
  threadId?: string,
  connectorOverride?: "copilot-sdk" | "claude-cli",
  threadConnector?: Connector,
): Promise<void> {
  const conversation = chatState.getConversation(conversationId);
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} not found`);
  }

  // Build effective config: thread connector > inline override > bot config.json
  let effectiveBotConfig = botConfig;
  if (threadConnector) {
    effectiveBotConfig = {
      ...botConfig,
      connector: threadConnector.connectorType as ConnectorType,
      model: threadConnector.model ?? botConfig.model,
      baseUrl: threadConnector.baseUrl ?? botConfig.baseUrl,
      thinkingMaxTokens: threadConnector.thinkingMaxTokens ?? botConfig.thinkingMaxTokens,
      timeoutMs: threadConnector.timeoutMs ?? botConfig.timeoutMs,
    };
  } else if (connectorOverride) {
    effectiveBotConfig = { ...botConfig, connector: connectorOverride as BotConfig["connector"] };
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
  const userMessage: ChatMessage = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    sender: "user",
    text,
    threadId: threadId ?? null,
  };
  chatState.addMessage(conversationId, userMessage);

  // Create say callback — adds bot message to conversation state
  // Note: does NOT clear status here — status is cleared after processMessage completes
  // to avoid flickering during multi-chunk Telegram responses
  const say = async (message: string): Promise<void> => {
    const botMessage: ChatMessage = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      sender: "bot",
      text: message,
      threadId: threadId ?? null,
    };
    chatState.addMessage(conversationId, botMessage);
  };

  // Create setStatus callback — updates conversation status
  const setStatus = async (status: string): Promise<void> => {
    chatState.setStatus(conversationId, status);
  };

  // Create postToChannel callback for Slack conversation types
  const postToChannel = isSlack
    ? async (channel: string, message: string): Promise<void> => {
        // Find or create the target channel conversation
        const channelConv = chatState.findOrCreateChannel(
          conversation.botName,
          channel,
          conversation.userId,
          conversation.username,
        );
        const botMessage: ChatMessage = {
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          sender: "bot",
          text: message,
        };
        chatState.addMessage(channelConv.id, botMessage);
      }
    : undefined;

  // Determine channel context for Slack channels
  const channelContext = conversation.channelName ?? undefined;

  // Create onTextDelta callback for streaming text to web clients
  // null = clear streaming bubble (e.g. tool calls started)
  const onTextDelta = (delta: string | null): void => {
    if (delta === null) {
      chatState.publishStreamClear(conversationId, threadId ?? null);
    } else {
      chatState.publishTextDelta(conversationId, delta, threadId ?? null);
    }
  };

  const onIntent = (intentText: string): void => {
    chatState.publishIntent(conversationId, intentText, threadId ?? null);
  };

  const onToolStatus = (statusText: string): void => {
    chatState.publishToolStatus(conversationId, statusText, threadId ?? null);
  };

  try {
    const result = await processMessage({
      text,
      userId: conversation.userId,
      username: conversation.username,
      platform,
      botConfig: effectiveBotConfig,
      config,
      say,
      setStatus,
      postToChannel,
      channelContext,
      recentChannelMessages,
      threadId,
      onTextDelta,
      onIntent,
      onToolStatus,
    });

    // Publish response metadata to web clients (token usage, timing)
    if (result) {
      chatState.publishResponseMeta(conversationId, {
        threadId: threadId ?? null,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        contextTokens: result.contextTokens,
        contextWindow: effectiveBotConfig.contextWindow,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
        model: result.model,
        numTurns: result.numTurns,
        toolCalls: result.toolCalls,
      });
    }
  } finally {
    chatState.setStatus(conversationId, "");
  }
}
