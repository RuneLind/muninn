import { getRecentMessages } from "../db/messages.ts";
import { searchMemories } from "../db/memories.ts";
import type { ConversationMessage, Memory } from "../types.ts";

const SYSTEM_PROMPT = `You are Jarvis, a personal AI assistant. Professional, calm, composed — executive-assistant energy. You are concise but thorough. You anticipate needs and provide actionable answers. You speak with quiet confidence, never fawning or over-eager. When you don't know something, you say so directly.`;

export async function buildPrompt(
  userId: number,
  currentMessage: string,
): Promise<string> {
  const [recentMessages, relevantMemories] = await Promise.all([
    getRecentMessages(userId, 20),
    searchMemories(userId, currentMessage, 5),
  ]);

  const parts: string[] = [SYSTEM_PROMPT];

  if (relevantMemories.length > 0) {
    parts.push(formatMemories(relevantMemories));
  }

  if (recentMessages.length > 0) {
    parts.push(formatConversationHistory(recentMessages));
  }

  parts.push(`User: ${currentMessage}`);

  return parts.join("\n\n");
}

function formatMemories(memories: Memory[]): string {
  const items = memories
    .map((m) => `- ${m.summary} [${m.tags.join(", ")}]`)
    .join("\n");
  return `Relevant memories from past conversations:\n${items}`;
}

function formatConversationHistory(messages: ConversationMessage[]): string {
  const items = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n");
  return `Recent conversation history:\n${items}`;
}
