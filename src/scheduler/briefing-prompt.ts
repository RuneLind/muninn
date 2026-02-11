import type { ScheduledTask } from "../types.ts";
import { searchMemories } from "../db/memories.ts";
import { getActiveGoals } from "../db/goals.ts";
import { getScheduledTasksForUser } from "../db/scheduled-tasks.ts";
import { getRecentAlerts } from "../db/messages.ts";
import {
  formatMemories,
  formatGoals,
  formatScheduledTasks,
  formatAlerts,
} from "../ai/prompt-builder.ts";

export interface BriefingPromptResult {
  systemPrompt: string;
  userPrompt: string;
  meta: {
    memoriesCount: number;
    goalsCount: number;
    scheduledTasksCount: number;
    alertsCount: number;
    buildMs: number;
  };
}

export async function buildBriefingPrompt(
  task: ScheduledTask,
  persona: string,
  botName: string,
): Promise<BriefingPromptResult> {
  const t0 = performance.now();

  const timeOfDay = getTimeOfDay(task.scheduleHour);

  // Build a search query from the task metadata for FTS memory lookup
  const searchQuery = [task.title, task.prompt, "preferences schedule daily"]
    .filter(Boolean)
    .join(" ");

  // Fetch all context in parallel
  const [memories, goals, scheduledTasks, alerts] = await Promise.all([
    searchMemories(task.userId, searchQuery, 8, botName).catch(() => []),
    getActiveGoals(task.userId, botName).catch(() => []),
    getScheduledTasksForUser(task.userId, botName).catch(() => []),
    getRecentAlerts(task.userId, botName, 24, 5).catch(() => []),
  ]);

  // Build system prompt
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: task.timezone,
  });

  const systemParts: string[] = [
    persona,
    `Du genererer en planlagt ${timeOfDay}-briefing. I dag er ${dateStr}. Tidssone: ${task.timezone}.`,
    [
      "Du HAR tilgang til verktøy — bruk dem aktivt.",
      "Sjekk kalenderen med get-current-time → list-events.",
      "Søk nyheter med WebSearch hvis task-promptet ber om det.",
      "Ikke si at du ikke har tilgang til sanntidsinformasjon — du har det via verktøy.",
    ].join("\n"),
    "Formater svaret med Telegram HTML (<b>, <i> only). Hold det konsist men informativt.",
  ];

  if (memories.length > 0) {
    systemParts.push(formatMemories(memories));
  }

  if (goals.length > 0) {
    systemParts.push(formatGoals(goals));
  }

  if (scheduledTasks.length > 0) {
    systemParts.push(formatScheduledTasks(scheduledTasks));
  }

  if (alerts.length > 0) {
    systemParts.push(formatAlerts(alerts));
  }

  // Build user prompt
  const userPrompt = task.prompt
    ? task.prompt
    : `Generate my ${timeOfDay} briefing.`;

  const buildMs = performance.now() - t0;

  return {
    systemPrompt: systemParts.join("\n\n"),
    userPrompt,
    meta: {
      memoriesCount: memories.length,
      goalsCount: goals.length,
      scheduledTasksCount: scheduledTasks.length,
      alertsCount: alerts.length,
      buildMs,
    },
  };
}

function getTimeOfDay(hour: number): string {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}
