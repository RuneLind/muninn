import { getRecentMessages } from "../db/messages.ts";
import { searchMemoriesHybrid } from "../db/memories.ts";
import { getActiveGoals } from "../db/goals.ts";
import { getScheduledTasksForUser } from "../db/scheduled-tasks.ts";
import { generateEmbedding } from "./embeddings.ts";
import type { ConversationMessage, Goal, Memory, ScheduledTask } from "../types.ts";

const SYSTEM_PROMPT = `You are Jarvis, a personal AI assistant. Professional, calm, composed — executive-assistant energy. You are concise but thorough. You anticipate needs and provide actionable answers. You speak with quiet confidence, never fawning or over-eager. When you don't know something, you say so directly.

FORMATTING: Your responses are displayed in Telegram, which only supports HTML formatting. Follow these rules strictly:
- Bold: <b>text</b>
- Italic: <i>text</i>
- Code: <code>text</code>
- Code blocks: <pre>code</pre> or <pre><code class="language-ts">code</code></pre>
- Links: <a href="url">text</a>
- NEVER use markdown headings (##), horizontal rules (---), or **double asterisks**
- NEVER wrap your response in code fences (\`\`\`). Write HTML tags directly in your response text, not inside code blocks.
- For section titles, use <b>Title</b> on its own line
- For lists, use plain bullet characters like • or numbered lines (1. 2. 3.)
- Keep messages concise — Telegram is a chat app, not a document viewer

You track the user's active goals and can reference them naturally. When a user completes a goal, acknowledge it. When goals have approaching deadlines, be aware of the urgency.

You can see the user's scheduled tasks (recurring reminders, briefings, etc). When a user wants to cancel, modify, or list their scheduled tasks, acknowledge them. You don't manage the tasks directly — the system handles that — but you're aware of them.`;

export interface PromptBuildResult {
  systemPrompt: string;
  userPrompt: string;
  meta: {
    dbHistoryMs: number;
    embeddingMs: number;
    memorySearchMs: number;
    messagesCount: number;
    memoriesCount: number;
    goalsCount: number;
    scheduledTasksCount: number;
  };
}

export async function buildPrompt(
  userId: number,
  currentMessage: string,
): Promise<PromptBuildResult> {
  const t0 = performance.now();
  let dbHistoryMs = 0;
  let embeddingMs = 0;

  const [recentMessages, queryEmbedding, activeGoals, scheduledTasks] =
    await Promise.all([
      getRecentMessages(userId, 20).then((r) => {
        dbHistoryMs = performance.now() - t0;
        return r;
      }),
      generateEmbedding(currentMessage).then((r) => {
        embeddingMs = performance.now() - t0;
        return r;
      }),
      getActiveGoals(userId),
      getScheduledTasksForUser(userId),
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
      ` | ${recentMessages.length} msgs, ${relevantMemories.length} memories, ${activeGoals.length} goals, ${scheduledTasks.length} tasks)`,
  );

  // System prompt: persona + context (memories, goals)
  const systemParts: string[] = [SYSTEM_PROMPT];

  if (relevantMemories.length > 0) {
    systemParts.push(formatMemories(relevantMemories));
  }

  if (activeGoals.length > 0) {
    systemParts.push(formatGoals(activeGoals));
  }

  if (scheduledTasks.length > 0) {
    systemParts.push(formatScheduledTasks(scheduledTasks));
  }

  // User prompt: conversation history + current message
  const userParts: string[] = [];

  if (recentMessages.length > 0) {
    userParts.push(formatConversationHistory(recentMessages));
  }

  userParts.push(currentMessage);

  return {
    systemPrompt: systemParts.join("\n\n"),
    userPrompt: userParts.join("\n\n"),
    meta: {
      dbHistoryMs,
      embeddingMs,
      memorySearchMs,
      messagesCount: recentMessages.length,
      memoriesCount: relevantMemories.length,
      goalsCount: activeGoals.length,
      scheduledTasksCount: scheduledTasks.length,
    },
  };
}

function formatMemories(memories: Memory[]): string {
  const items = memories
    .map((m) => `- ${m.summary} [${m.tags.join(", ")}]`)
    .join("\n");
  return `Relevant memories from past conversations:\n${items}`;
}

function formatGoals(goals: Goal[]): string {
  const items = goals
    .map((g) => {
      let line = `- ${g.title}`;
      if (g.deadline) {
        const d = new Date(g.deadline);
        line += ` (deadline: ${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })})`;
      }
      if (g.tags.length > 0) {
        line += ` [${g.tags.join(", ")}]`;
      }
      return line;
    })
    .join("\n");
  return `User's active goals:\n${items}`;
}

function formatScheduledTasks(tasks: ScheduledTask[]): string {
  const items = tasks
    .map((t) => {
      const time = `${String(t.scheduleHour).padStart(2, "0")}:${String(t.scheduleMinute).padStart(2, "0")}`;
      let schedule: string;
      if (t.scheduleIntervalMs) {
        const hours = t.scheduleIntervalMs / 3_600_000;
        schedule = hours >= 1 ? `every ${hours}h` : `every ${t.scheduleIntervalMs / 60_000}min`;
      } else if (t.scheduleDays && t.scheduleDays.length > 0 && t.scheduleDays.length < 7) {
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const days = t.scheduleDays.map((d) => dayNames[d]).join(", ");
        schedule = `${days} at ${time}`;
      } else {
        schedule = `daily at ${time}`;
      }
      return `- ${t.title} (${t.taskType}, ${schedule})`;
    })
    .join("\n");
  return `User's scheduled tasks:\n${items}`;
}

function formatConversationHistory(messages: ConversationMessage[]): string {
  const items = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n");
  return `Recent conversation history:\n${items}`;
}
