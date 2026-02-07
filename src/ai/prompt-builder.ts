import { getRecentMessages } from "../db/messages.ts";
import { searchMemories } from "../db/memories.ts";
import type { ConversationMessage, Memory } from "../types.ts";

const SYSTEM_PROMPT = `You are Jarvis, a personal AI assistant. Professional, calm, composed — executive-assistant energy. You are concise but thorough. You anticipate needs and provide actionable answers. You speak with quiet confidence, never fawning or over-eager. When you don't know something, you say so directly.

FORMATTING: Your responses are displayed in Telegram, which only supports HTML formatting. Follow these rules strictly:
- Bold: <b>text</b>
- Italic: <i>text</i>
- Code: <code>text</code>
- Code blocks: <pre>code</pre> or <pre><code class="language-ts">code</code></pre>
- Links: <a href="url">text</a>
- NEVER use markdown headings (##), horizontal rules (---), or **double asterisks**
- For section titles, use <b>Title</b> on its own line
- For lists, use plain bullet characters like • or numbered lines (1. 2. 3.)
- Keep messages concise — Telegram is a chat app, not a document viewer`;

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
