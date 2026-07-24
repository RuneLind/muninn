import { getLog } from "../logging.ts";
import { getRecentMessages, getRecentAlerts, type AlertMessage } from "../db/messages.ts";
import { searchMemoriesHybrid } from "../db/memories.ts";

const log = getLog("ai", "prompt");
import { getActiveGoals } from "../db/goals.ts";
import { getScheduledTasksForUser } from "../db/scheduled-tasks.ts";
import { generateEmbedding } from "./embeddings.ts";
import type { RestrictedTools } from "../bots/config.ts";
import { getRestrictedToolsForUser, buildToolRestrictionPrompt } from "./tool-restrictions.ts";
import type { ConversationMessage, Goal, Memory, ScheduledTask, UserIdentity } from "../types.ts";
import { COMPONENT_VOCABULARY_RULES } from "../research/answer.ts";

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
    alertsCount: number;
    memoryDetails?: { id: string; summary: string; scope: string }[];
    goalDetails?: { id: string; title: string }[];
  };
}

export interface BuildPromptOptions {
  userId: string;
  currentMessage: string;
  persona: string;
  botName: string;
  restrictedTools?: RestrictedTools;
  userIdentity?: string | UserIdentity;
  threadId?: string;
  /** When true, append the one-line nudge telling the bot to prefer
   *  `research_knowledge` for multi-part questions. Caller sets this from
   *  `botConfig.hasResearchKnowledge`. */
  researchKnowledgeAvailable?: boolean;
  /** When true, append the presentational block-component vocabulary + restraint
   *  block so the bot may emit Callout/Verdict/etc. in chat. Caller sets this
   *  from `botConfig.componentAnswers`. */
  componentAnswersEnabled?: boolean;
}

export const RESEARCH_KNOWLEDGE_NUDGE =
  "For multi-part or comparison questions (e.g. \"how does X differ from Y\", \"what triggers Z and W\"), prefer `research_knowledge` — it decomposes the question and searches each part. For simple single-topic lookups, use `search_knowledge`.";

export async function buildPrompt(opts: BuildPromptOptions): Promise<PromptBuildResult> {
  const { userId, currentMessage, persona, botName, restrictedTools, userIdentity, threadId, researchKnowledgeAvailable, componentAnswersEnabled } = opts;
  const t0 = performance.now();
  let dbHistoryMs = 0;
  let embeddingMs = 0;

  const [recentMessages, queryEmbedding, activeGoals, scheduledTasks, recentAlerts] =
    await Promise.all([
      getRecentMessages(userId, 20, botName, threadId, { excludeProactive: true }).then((r) => {
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
  log.info(
    "prompt_build: {ms}ms" +
      ` (db: ${Math.round(dbHistoryMs)}ms, embed: ${Math.round(embeddingMs)}ms, search: ${Math.round(memorySearchMs)}ms` +
      ` | ${recentMessages.length} msgs, ${relevantMemories.length} memories, ${activeGoals.length} goals, ${scheduledTasks.length} tasks, ${recentAlerts.length} alerts)`,
    { botName, ms: Math.round(totalMs) },
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

  // Placed last so it sits closest to the user turn, where instruction-following
  // is best.
  if (researchKnowledgeAvailable) {
    systemParts.push(RESEARCH_KNOWLEDGE_NUDGE);
  }
  if (componentAnswersEnabled) {
    systemParts.push(COMPONENT_VOCABULARY_RULES);
  }

  // The last message is dropped when it matches `currentMessage` because the
  // caller persisted it before calling buildPrompt — we'd otherwise repeat it
  // verbatim under the `<conversation_history>` block.
  const last = recentMessages.at(-1);
  const history = last && last.role !== "assistant" && last.text === currentMessage
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
      messagesCount: recentMessages.length,
      memoriesCount: relevantMemories.length,
      goalsCount: activeGoals.length,
      scheduledTasksCount: scheduledTasks.length,
      alertsCount: recentAlerts.length,
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

/** Max chars of a single alert's content injected into the prompt. */
const ALERT_CONTENT_MAX = 300;

/** Truncate at a word boundary within the cap and append an ellipsis. */
function truncateAlertContent(content: string): string {
  if (content.length <= ALERT_CONTENT_MAX) return content;
  const slice = content.slice(0, ALERT_CONTENT_MAX);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
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
      const type = a.source.replace(/^(watcher|task|goal):/, "");
      return `- [${time}] ${type}: ${truncateAlertContent(a.content)}`;
    })
    .join("\n");
  return `Recent proactive messages sent to user (last 24h):\n${items}`;
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
