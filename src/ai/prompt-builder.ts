import { getRecentMessages } from "../db/messages.ts";
import { searchMemoriesHybrid } from "../db/memories.ts";
import { generateEmbedding } from "./embeddings.ts";
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

export interface PromptBuildResult {
  prompt: string;
  meta: {
    dbHistoryMs: number;
    embeddingMs: number;
    memorySearchMs: number;
    messagesCount: number;
    memoriesCount: number;
  };
}

export async function buildPrompt(
  userId: number,
  currentMessage: string,
): Promise<PromptBuildResult> {
  const t0 = performance.now();
  let dbHistoryMs = 0;
  let embeddingMs = 0;

  const [recentMessages, queryEmbedding] = await Promise.all([
    getRecentMessages(userId, 20).then((r) => {
      dbHistoryMs = performance.now() - t0;
      return r;
    }),
    generateEmbedding(currentMessage).then((r) => {
      embeddingMs = performance.now() - t0;
      return r;
    }),
  ]);

  const searchStart = performance.now();
  const relevantMemories = await searchMemoriesHybrid(
    userId,
    currentMessage,
    queryEmbedding,
    5,
  );
  const memorySearchMs = performance.now() - searchStart;

  const totalMs = performance.now() - t0;
  console.log(
    `[Jarvis] prompt_build: ${Math.round(totalMs)}ms` +
      ` (db: ${Math.round(dbHistoryMs)}ms, embed: ${Math.round(embeddingMs)}ms, search: ${Math.round(memorySearchMs)}ms` +
      ` | ${recentMessages.length} msgs, ${relevantMemories.length} memories)`,
  );

  const parts: string[] = [SYSTEM_PROMPT];

  if (relevantMemories.length > 0) {
    parts.push(formatMemories(relevantMemories));
  }

  if (recentMessages.length > 0) {
    parts.push(formatConversationHistory(recentMessages));
  }

  parts.push(`User: ${currentMessage}`);

  return {
    prompt: parts.join("\n\n"),
    meta: {
      dbHistoryMs,
      embeddingMs,
      memorySearchMs,
      messagesCount: recentMessages.length,
      memoriesCount: relevantMemories.length,
    },
  };
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
