import { getRecentMessages, getRecentAlerts, type AlertMessage } from "../db/messages.ts";
import { searchMemoriesHybrid } from "../db/memories.ts";
import { getActiveGoals } from "../db/goals.ts";
import { getScheduledTasksForUser } from "../db/scheduled-tasks.ts";
import { generateEmbedding } from "./embeddings.ts";
import { searchKnowledge, formatKnowledgeResults } from "./knowledge-search.ts";
import type { RestrictedTools } from "../bots/config.ts";
import { getRestrictedToolsForUser, buildToolRestrictionPrompt } from "./tool-restrictions.ts";
import type { ConversationMessage, Goal, Memory, ScheduledTask, UserIdentity } from "../types.ts";

export interface PromptBuildResult {
  systemPrompt: string;
  userPrompt: string;
  meta: {
    dbHistoryMs: number;
    embeddingMs: number;
    memorySearchMs: number;
    knowledgeSearchMs: number;
    messagesCount: number;
    memoriesCount: number;
    goalsCount: number;
    scheduledTasksCount: number;
    alertsCount: number;
    knowledgeCount: number;
    memoryDetails?: { id: string; summary: string; scope: string }[];
    goalDetails?: { id: string; title: string }[];
  };
}

export async function buildPrompt(
  userId: string,
  currentMessage: string,
  persona: string,
  botName: string,
  restrictedTools?: RestrictedTools,
  userIdentity?: string | UserIdentity,
  knowledgeCollections?: string[],
): Promise<PromptBuildResult> {
  const t0 = performance.now();
  let dbHistoryMs = 0;
  let embeddingMs = 0;

  const [recentMessages, queryEmbedding, activeGoals, scheduledTasks, recentAlerts, knowledgeResult] =
    await Promise.all([
      getRecentMessages(userId, 20, botName).then((r) => {
        dbHistoryMs = performance.now() - t0;
        return r;
      }),
      generateEmbedding(currentMessage).then((r) => {
        embeddingMs = performance.now() - t0;
        return r;
      }),
      getActiveGoals(userId, botName),
      getScheduledTasksForUser(userId, botName),
      getRecentAlerts(userId, botName, 24, 5),
      knowledgeCollections?.length
        ? searchKnowledge(currentMessage, knowledgeCollections)
        : Promise.resolve({ results: [], searchMs: 0 }),
    ]);

  const searchStart = performance.now();
  const relevantMemories = await searchMemoriesHybrid(
    userId,
    currentMessage,
    queryEmbedding,
    5,
    botName,
  );
  const memorySearchMs = performance.now() - searchStart;

  const totalMs = performance.now() - t0;
  console.log(
    `[${botName}] prompt_build: ${Math.round(totalMs)}ms` +
      ` (db: ${Math.round(dbHistoryMs)}ms, embed: ${Math.round(embeddingMs)}ms, search: ${Math.round(memorySearchMs)}ms` +
      (knowledgeResult.results.length > 0 ? `, knowledge: ${Math.round(knowledgeResult.searchMs)}ms` : "") +
      ` | ${recentMessages.length} msgs, ${relevantMemories.length} memories, ${activeGoals.length} goals, ${scheduledTasks.length} tasks, ${recentAlerts.length} alerts` +
      (knowledgeResult.results.length > 0 ? `, ${knowledgeResult.results.length} knowledge` : "") +
      `)`,
  );

  // System prompt: persona + user identity + tool restrictions + context (memories, goals)
  const systemParts: string[] = [persona];

  if (userIdentity) {
    const identity = typeof userIdentity === "string" ? { name: userIdentity } : userIdentity;
    const lines = [`You are currently talking to: ${identity.name}`];
    if (identity.displayName) lines.push(`- Display name: ${identity.displayName}`);
    if (identity.title) lines.push(`- Title: ${identity.title}`);
    systemParts.push(lines.join("\n"));
  }

  const deniedGroups = getRestrictedToolsForUser(userId, restrictedTools);
  const restrictionPrompt = buildToolRestrictionPrompt(deniedGroups);
  if (restrictionPrompt) {
    systemParts.push(restrictionPrompt);
  }

  if (relevantMemories.length > 0) {
    systemParts.push(formatMemories(relevantMemories));
  }

  if (activeGoals.length > 0) {
    systemParts.push(formatGoals(activeGoals));
  }

  if (scheduledTasks.length > 0) {
    systemParts.push(formatScheduledTasks(scheduledTasks));
  }

  if (recentAlerts.length > 0) {
    systemParts.push(formatAlerts(recentAlerts));
  }

  if (knowledgeResult.results.length > 0) {
    systemParts.push(formatKnowledgeResults(knowledgeResult.results));
  }

  // User prompt: conversation history + current message
  // Drop the last message if it's the current user message (already saved to DB before buildPrompt)
  const history = recentMessages.at(-1)?.role === "user" && recentMessages.at(-1)?.text === currentMessage
    ? recentMessages.slice(0, -1)
    : recentMessages;

  const userParts: string[] = [];

  if (history.length > 0) {
    userParts.push(formatConversationHistory(history));
  }

  userParts.push(currentMessage);

  return {
    systemPrompt: systemParts.join("\n\n"),
    userPrompt: userParts.join("\n\n"),
    meta: {
      dbHistoryMs,
      embeddingMs,
      memorySearchMs,
      knowledgeSearchMs: knowledgeResult.searchMs,
      messagesCount: recentMessages.length,
      memoriesCount: relevantMemories.length,
      goalsCount: activeGoals.length,
      scheduledTasksCount: scheduledTasks.length,
      alertsCount: recentAlerts.length,
      knowledgeCount: knowledgeResult.results.length,
      memoryDetails: relevantMemories.map((m) => ({ id: m.id, summary: m.summary, scope: m.scope ?? "personal" })),
      goalDetails: activeGoals.map((g) => ({ id: g.id, title: g.title })),
    },
  };
}

export function formatMemories(memories: Memory[]): string {
  const personal = memories.filter((m) => m.scope !== "shared");
  const shared = memories.filter((m) => m.scope === "shared");
  const parts: string[] = [];
  if (personal.length > 0) {
    parts.push(
      `Your memories about this user:\n${personal.map((m) => `- ${m.summary} [${m.tags.join(", ")}]`).join("\n")}`,
    );
  }
  if (shared.length > 0) {
    parts.push(
      `Shared team knowledge:\n${shared.map((m) => `- ${m.summary} [${m.tags.join(", ")}]`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

export function formatGoals(goals: Goal[]): string {
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

export function formatScheduledTasks(tasks: ScheduledTask[]): string {
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

export function formatAlerts(alerts: AlertMessage[]): string {
  const items = alerts
    .map((a) => {
      const time = new Date(a.timestamp).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Europe/Oslo",
      });
      const type = a.source.replace("watcher:", "");
      return `- [${time}] ${type}: ${a.content}`;
    })
    .join("\n");
  return `Recent watcher alerts sent to user (last 24h):\n${items}`;
}

function formatConversationHistory(messages: ConversationMessage[]): string {
  const items = messages
    .map((m) => {
      const label = m.role === "user" && m.username ? `user/${m.username}` : m.role;
      return `[${label}] ${m.text}`;
    })
    .join("\n\n");
  return `<conversation_history>\n${items}\n</conversation_history>`;
}
