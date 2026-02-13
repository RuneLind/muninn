import type { Api } from "grammy";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Goal, ScheduledTask } from "../types.ts";
import {
  getGoalsNeedingReminder,
  getGoalsNeedingCheckin,
  updateGoalReminderSentAt,
  updateGoalCheckedAt,
} from "../db/goals.ts";
import { getTasksDueNow, updateTaskLastRun } from "../db/scheduled-tasks.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { agentStatus } from "../dashboard/agent-status.ts";
import { callHaiku } from "./executor.ts";
import { executeClaudePrompt } from "../ai/executor.ts";
import { buildBriefingPrompt } from "./briefing-prompt.ts";
import { runWatchers } from "../watchers/runner.ts";
import { Tracer } from "../tracing/index.ts";
import { cleanupOldTraces } from "../db/traces.ts";
import { cleanupOldSnapshots } from "../db/prompt-snapshots.ts";

const intervals = new Map<string, ReturnType<typeof setInterval>>();
const tickRunning = new Map<string, boolean>();
let lastCleanupAt = 0;

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

  // Check if there's anything to do before creating a trace
  const dueTasks = await getTasksDueNow(botName);
  const goalReminders = await getGoalsNeedingReminder(24, botName);
  const staleGoals = await getGoalsNeedingCheckin(3, botName);
  const hasWork = dueTasks.length > 0 || goalReminders.length > 0 || staleGoals.length > 0;

  // Only create a trace if something will actually run (watchers always checked)
  let t: Tracer | undefined;
  if (hasWork) {
    t = new Tracer("scheduler_tick", { botName, platform: "scheduler" });
  }

  try {
    // 1. Run due scheduled tasks
    if (dueTasks.length > 0) {
      t?.start("scheduled_tasks");
      await runScheduledTasksFromList(api, config, botConfig, dueTasks);
      t?.end("scheduled_tasks", { count: dueTasks.length });
    }

    // 2. Goal deadline reminders (24h ahead)
    if (goalReminders.length > 0) {
      t?.start("goal_reminders");
      await runGoalRemindersFromList(api, botConfig, goalReminders);
      t?.end("goal_reminders", { count: goalReminders.length });
    }

    // 3. Goal check-ins (stale goals, max 1 per tick)
    if (staleGoals.length > 0) {
      t?.start("goal_checkins");
      await runGoalCheckinsFromList(api, botConfig, staleGoals);
      t?.end("goal_checkins", { count: Math.min(staleGoals.length, 1) });
    }

    // 4. Watchers (email, calendar, etc.)
    await runWatchers(api, botConfig, t?.context);

    t?.finish("ok");
  } catch (err) {
    t?.error(err instanceof Error ? err : String(err));
    throw err;
  }

  // 5. Retention cleanup — once per hour
  const now = Date.now();
  if (now - lastCleanupAt > 3_600_000) {
    lastCleanupAt = now;
    try {
      const deleted = await cleanupOldTraces(config.tracingRetentionDays);
      if (deleted > 0) {
        console.log(`[${botName}] Cleaned up ${deleted} old traces`);
      }
      const deletedSnapshots = await cleanupOldSnapshots(config.promptSnapshotsRetentionDays);
      if (deletedSnapshots > 0) {
        console.log(`[${botName}] Cleaned up ${deletedSnapshots} old prompt snapshots`);
      }
    } catch (err) {
      console.error(`[${botName}] Trace cleanup failed:`, err);
    }
  }
}

// --- Scheduled Tasks ---

async function runScheduledTasksFromList(api: Api, config: Config, botConfig: BotConfig, dueTasks: ScheduledTask[]): Promise<void> {
  const tag = botConfig.name;
  for (const task of dueTasks) {
    try {
      // Update next_run_at FIRST to prevent re-firing on overlapping ticks
      await updateTaskLastRun(task);

      agentStatus.set("running_task", task.title);
      const message = await executeTask(task, config, botConfig);
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

async function executeTask(task: ScheduledTask, config: Config, botConfig: BotConfig): Promise<string> {
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
      return await generateBriefing(task, config, botConfig);

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

async function generateBriefing(task: ScheduledTask, config: Config, botConfig: BotConfig): Promise<string> {
  const t0 = performance.now();

  try {
    const { systemPrompt, userPrompt, meta } = await buildBriefingPrompt(
      task,
      botConfig.persona,
      botConfig.name,
    );

    console.log(
      `[${botConfig.name}] Briefing prompt built in ${Math.round(meta.buildMs)}ms` +
        ` (${meta.memoriesCount} memories, ${meta.goalsCount} goals, ${meta.scheduledTasksCount} tasks, ${meta.alertsCount} alerts)`,
    );

    const result = await executeClaudePrompt(userPrompt, config, botConfig, systemPrompt);

    const totalMs = Math.round(performance.now() - t0);
    console.log(
      `[${botConfig.name}] Briefing generated in ${totalMs}ms` +
        ` (model: ${result.model}, input: ${result.inputTokens}, output: ${result.outputTokens}, turns: ${result.numTurns})`,
    );

    return result.result.trim();
  } catch (err) {
    console.error(`[${botConfig.name}] Briefing generation failed, using fallback:`, err);
    const timeOfDay = task.scheduleHour < 12 ? "morning" : task.scheduleHour < 17 ? "afternoon" : "evening";
    return `<b>Good ${timeOfDay}!</b>\nI wasn't able to generate your full briefing this time. Check back later!`;
  }
}

// --- Goal Reminders (moved from goals/scheduler.ts) ---

async function runGoalRemindersFromList(api: Api, botConfig: BotConfig, reminders: Goal[]): Promise<void> {
  const tag = botConfig.name;
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

async function runGoalCheckinsFromList(api: Api, botConfig: BotConfig, staleGoals: Goal[]): Promise<void> {
  const tag = botConfig.name;
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
