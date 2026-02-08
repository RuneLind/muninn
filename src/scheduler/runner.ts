import type { Api } from "grammy";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
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
import { agentStatus } from "../dashboard/agent-status.ts";
import { callHaiku } from "./executor.ts";
import { runWatchers } from "../watchers/runner.ts";

const intervals = new Map<string, ReturnType<typeof setInterval>>();
const tickRunning = new Map<string, boolean>();

export function startScheduler(api: Api, config: Config, botConfig: BotConfig): void {
  if (!config.schedulerEnabled) {
    console.log(`[${botConfig.name}] Scheduler disabled`);
    return;
  }

  const intervalMs = config.schedulerIntervalMs;
  const tag = botConfig.name;
  console.log(
    `[${tag}] Unified scheduler started (interval: ${intervalMs / 1000}s)`,
  );

  const id = setInterval(() => {
    if (tickRunning.get(tag)) return;
    tickRunning.set(tag, true);
    runSchedulerTick(api, config, botConfig)
      .catch((err) => {
        console.error(`[${tag}] Scheduler tick failed:`, err);
      })
      .finally(() => {
        tickRunning.set(tag, false);
      });
  }, intervalMs);

  intervals.set(tag, id);
}

export function stopScheduler(): void {
  for (const [tag, id] of intervals) {
    clearInterval(id);
    console.log(`[${tag}] Scheduler stopped`);
  }
  intervals.clear();
  tickRunning.clear();
}

async function runSchedulerTick(api: Api, config: Config, botConfig: BotConfig): Promise<void> {
  const botName = botConfig.name;

  // 1. Run due scheduled tasks
  await runScheduledTasks(api, botConfig);

  // 2. Goal deadline reminders (24h ahead)
  await runGoalReminders(api, botConfig);

  // 3. Goal check-ins (stale goals, max 1 per tick)
  await runGoalCheckins(api, botConfig);

  // 4. Watchers (email, calendar, etc.)
  await runWatchers(api, botConfig);
}

// --- Scheduled Tasks ---

async function runScheduledTasks(api: Api, botConfig: BotConfig): Promise<void> {
  const tag = botConfig.name;
  const dueTasks = await getTasksDueNow(tag);
  for (const task of dueTasks) {
    try {
      // Update next_run_at FIRST to prevent re-firing on overlapping ticks
      await updateTaskLastRun(task);

      agentStatus.set("running_task", task.title);
      const message = await executeTask(task, botConfig);
      agentStatus.set("sending_telegram", task.title);
      await api.sendMessage(task.userId, message, { parse_mode: "HTML" });
      agentStatus.set("idle");
      activityLog.push(
        "system",
        `Scheduled task fired: ${task.title} (${task.taskType})`,
        { userId: task.userId, botName: tag },
      );
      console.log(
        `[${tag}] Scheduled task fired: "${task.title}" (${task.taskType}) to user ${task.userId}`,
      );
    } catch (err) {
      agentStatus.set("idle");
      console.error(
        `[${tag}] Failed to execute scheduled task ${task.id}:`,
        err,
      );
    }
  }
}

async function executeTask(task: ScheduledTask, botConfig: BotConfig): Promise<string> {
  const cwd = botConfig.dir;
  switch (task.taskType) {
    case "reminder":
      return await callHaiku(
        `Generate a brief, natural Telegram reminder message (2-3 sentences max). Use Telegram HTML formatting (<b>, <i> only). Be helpful, not pushy.\n\nReminder: "${task.title}"${task.prompt ? `\nContext: ${task.prompt}` : ""}`,
        `<b>Reminder:</b> ${task.title}`,
        "reminder",
        cwd,
        botConfig.name,
      );

    case "briefing":
      return await generateBriefing(task, botConfig);

    case "custom":
      if (!task.prompt) return `<b>${task.title}</b>`;
      return await callHaiku(
        `${task.prompt}\n\nRespond using Telegram HTML formatting (<b>, <i> only). Keep it concise.`,
        `<b>${task.title}</b>`,
        "task",
        cwd,
        botConfig.name,
      );
  }
}

async function generateBriefing(task: ScheduledTask, botConfig: BotConfig): Promise<string> {
  // Fetch active goals for context
  let goalsContext = "";
  try {
    const goals = await getActiveGoals(task.userId, task.botName);
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
    "briefing",
    botConfig.dir,
    botConfig.name,
  );
}

function getTimeOfDay(hour: number): string {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

// --- Goal Reminders (moved from goals/scheduler.ts) ---

async function runGoalReminders(api: Api, botConfig: BotConfig): Promise<void> {
  const tag = botConfig.name;
  const reminders = await getGoalsNeedingReminder(24, tag);
  for (const goal of reminders) {
    try {
      agentStatus.set("checking_goals", goal.title);
      const message = await generateReminderMessage(goal, botConfig);
      agentStatus.set("sending_telegram", goal.title);
      await api.sendMessage(goal.userId, message, { parse_mode: "HTML" });
      agentStatus.set("idle");
      await updateGoalReminderSentAt(goal.id);
      activityLog.push(
        "system",
        `Deadline reminder sent for goal: ${goal.title}`,
        { userId: goal.userId, botName: tag },
      );
      console.log(
        `[${tag}] Deadline reminder sent: "${goal.title}" to user ${goal.userId}`,
      );
    } catch (err) {
      agentStatus.set("idle");
      console.error(
        `[${tag}] Failed to send reminder for goal ${goal.id}:`,
        err,
      );
    }
  }
}

async function runGoalCheckins(api: Api, botConfig: BotConfig): Promise<void> {
  const tag = botConfig.name;
  const staleGoals = await getGoalsNeedingCheckin(3, tag);
  if (staleGoals.length > 0) {
    const goal = staleGoals[0]!;
    try {
      agentStatus.set("checking_goals", goal.title);
      const message = await generateCheckinMessage(goal, botConfig);
      agentStatus.set("sending_telegram", goal.title);
      await api.sendMessage(goal.userId, message, { parse_mode: "HTML" });
      agentStatus.set("idle");
      await updateGoalCheckedAt(goal.id);
      activityLog.push(
        "system",
        `Check-in sent for goal: ${goal.title}`,
        { userId: goal.userId, botName: tag },
      );
      console.log(
        `[${tag}] Check-in sent: "${goal.title}" to user ${goal.userId}`,
      );
    } catch (err) {
      agentStatus.set("idle");
      console.error(
        `[${tag}] Failed to send check-in for goal ${goal.id}:`,
        err,
      );
    }
  }
}

async function generateReminderMessage(goal: Goal, botConfig: BotConfig): Promise<string> {
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
    "checkin",
    botConfig.dir,
    botConfig.name,
  );
}

async function generateCheckinMessage(goal: Goal, botConfig: BotConfig): Promise<string> {
  const createdStr = new Date(goal.createdAt).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });

  return await callHaiku(
    `Generate a brief, natural Telegram check-in message (2-3 sentences max) asking about progress on a goal. Use Telegram HTML formatting (<b>, <i> only). Be conversational and supportive, not nagging. Don't use emojis excessively.\n\nGoal: "${goal.title}"\n${goal.description ? `Context: ${goal.description}` : ""}\nSet on: ${createdStr}\nTags: ${goal.tags.join(", ") || "none"}`,
    `📋 <b>Goal check-in:</b> ${goal.title}\nHow's this going?`,
    "checkin",
    botConfig.dir,
    botConfig.name,
  );
}
