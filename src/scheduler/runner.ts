import type { Api } from "grammy";
import type { Config } from "../config.ts";
import type { Goal, ScheduledTask } from "../types.ts";
import {
  getGoalsNeedingReminder,
  getGoalsNeedingCheckin,
  updateGoalReminderSentAt,
  updateGoalCheckedAt,
  getActiveGoals,
} from "../db/goals.ts";
import { getTasksDueNow, updateTaskLastRun } from "../db/scheduled-tasks.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { callHaiku } from "./executor.ts";

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startScheduler(api: Api, config: Config): void {
  if (!config.schedulerEnabled) {
    console.log("[Jarvis] Scheduler disabled");
    return;
  }

  const intervalMs = config.schedulerIntervalMs;
  console.log(
    `[Jarvis] Unified scheduler started (interval: ${intervalMs / 1000}s)`,
  );

  intervalId = setInterval(() => {
    runSchedulerTick(api, config).catch((err) => {
      console.error("[Jarvis] Scheduler tick failed:", err);
    });
  }, intervalMs);
}

export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[Jarvis] Scheduler stopped");
  }
}

async function runSchedulerTick(api: Api, config: Config): Promise<void> {
  // 1. Run due scheduled tasks
  await runScheduledTasks(api);

  // 2. Goal deadline reminders (24h ahead)
  await runGoalReminders(api);

  // 3. Goal check-ins (stale goals, max 1 per tick)
  await runGoalCheckins(api);
}

// --- Scheduled Tasks ---

async function runScheduledTasks(api: Api): Promise<void> {
  const dueTasks = await getTasksDueNow();
  for (const task of dueTasks) {
    try {
      const message = await executeTask(task);
      await api.sendMessage(task.userId, message, { parse_mode: "HTML" });
      await updateTaskLastRun(task);
      activityLog.push(
        "system",
        `Scheduled task fired: ${task.title} (${task.taskType})`,
        { userId: task.userId },
      );
      console.log(
        `[Jarvis] Scheduled task fired: "${task.title}" (${task.taskType}) to user ${task.userId}`,
      );
    } catch (err) {
      console.error(
        `[Jarvis] Failed to execute scheduled task ${task.id}:`,
        err,
      );
    }
  }
}

async function executeTask(task: ScheduledTask): Promise<string> {
  switch (task.taskType) {
    case "reminder":
      return await callHaiku(
        `Generate a brief, natural Telegram reminder message (2-3 sentences max). Use Telegram HTML formatting (<b>, <i> only). Be helpful, not pushy.\n\nReminder: "${task.title}"${task.prompt ? `\nContext: ${task.prompt}` : ""}`,
        `<b>Reminder:</b> ${task.title}`,
      );

    case "briefing":
      return await generateBriefing(task);

    case "custom":
      if (!task.prompt) return `<b>${task.title}</b>`;
      return await callHaiku(
        `${task.prompt}\n\nRespond using Telegram HTML formatting (<b>, <i> only). Keep it concise.`,
        `<b>${task.title}</b>`,
      );
  }
}

async function generateBriefing(task: ScheduledTask): Promise<string> {
  // Fetch active goals for context
  let goalsContext = "";
  try {
    const goals = await getActiveGoals(task.userId);
    if (goals.length > 0) {
      goalsContext =
        "\n\nUser's active goals:\n" +
        goals
          .map((g) => {
            let line = `- ${g.title}`;
            if (g.deadline) {
              line += ` (deadline: ${new Date(g.deadline).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })})`;
            }
            return line;
          })
          .join("\n");
    }
  } catch {
    // Non-critical, continue without goals
  }

  const timeOfDay = getTimeOfDay(task.scheduleHour);

  const prompt = `Generate a brief ${timeOfDay} briefing message for the user. Use Telegram HTML formatting (<b>, <i> only). Be warm but concise (3-5 sentences). Include a brief overview of their goals and anything noteworthy.${goalsContext}${task.prompt ? `\n\nAdditional instructions: ${task.prompt}` : ""}`;

  return await callHaiku(
    prompt,
    `<b>Good ${timeOfDay}!</b>\nHere's your briefing. You have ${goalsContext ? "active goals to work on" : "no active goals"} today.`,
  );
}

function getTimeOfDay(hour: number): string {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

// --- Goal Reminders (moved from goals/scheduler.ts) ---

async function runGoalReminders(api: Api): Promise<void> {
  const reminders = await getGoalsNeedingReminder(24);
  for (const goal of reminders) {
    try {
      const message = await generateReminderMessage(goal);
      await api.sendMessage(goal.userId, message, { parse_mode: "HTML" });
      await updateGoalReminderSentAt(goal.id);
      activityLog.push(
        "system",
        `Deadline reminder sent for goal: ${goal.title}`,
        { userId: goal.userId },
      );
      console.log(
        `[Jarvis] Deadline reminder sent: "${goal.title}" to user ${goal.userId}`,
      );
    } catch (err) {
      console.error(
        `[Jarvis] Failed to send reminder for goal ${goal.id}:`,
        err,
      );
    }
  }
}

async function runGoalCheckins(api: Api): Promise<void> {
  const staleGoals = await getGoalsNeedingCheckin(3);
  if (staleGoals.length > 0) {
    const goal = staleGoals[0]!;
    try {
      const message = await generateCheckinMessage(goal);
      await api.sendMessage(goal.userId, message, { parse_mode: "HTML" });
      await updateGoalCheckedAt(goal.id);
      activityLog.push(
        "system",
        `Check-in sent for goal: ${goal.title}`,
        { userId: goal.userId },
      );
      console.log(
        `[Jarvis] Check-in sent: "${goal.title}" to user ${goal.userId}`,
      );
    } catch (err) {
      console.error(
        `[Jarvis] Failed to send check-in for goal ${goal.id}:`,
        err,
      );
    }
  }
}

async function generateReminderMessage(goal: Goal): Promise<string> {
  const deadlineStr = goal.deadline
    ? new Date(goal.deadline).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "soon";

  return await callHaiku(
    `Generate a brief, natural Telegram reminder message (2-3 sentences max) about an approaching deadline. Use Telegram HTML formatting (<b>, <i> only). Be helpful and motivating, not pushy. Don't use emojis excessively.\n\nGoal: "${goal.title}"\n${goal.description ? `Context: ${goal.description}` : ""}\nDeadline: ${deadlineStr}\nTags: ${goal.tags.join(", ") || "none"}`,
    `⏰ <b>Deadline approaching:</b> ${goal.title}\nDue: ${deadlineStr}`,
  );
}

async function generateCheckinMessage(goal: Goal): Promise<string> {
  const createdStr = new Date(goal.createdAt).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });

  return await callHaiku(
    `Generate a brief, natural Telegram check-in message (2-3 sentences max) asking about progress on a goal. Use Telegram HTML formatting (<b>, <i> only). Be conversational and supportive, not nagging. Don't use emojis excessively.\n\nGoal: "${goal.title}"\n${goal.description ? `Context: ${goal.description}` : ""}\nSet on: ${createdStr}\nTags: ${goal.tags.join(", ") || "none"}`,
    `📋 <b>Goal check-in:</b> ${goal.title}\nHow's this going?`,
  );
}
