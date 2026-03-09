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
import { agentStatus, createProgressCallback, setConnectorInfo } from "../dashboard/agent-status.ts";
import { callHaiku } from "./executor.ts";
import { resolveConnector } from "../ai/connector.ts";
import { buildBriefingPrompt } from "./briefing-prompt.ts";
import { runWatchers } from "../watchers/runner.ts";
import { Tracer } from "../tracing/index.ts";
import { cleanupOldTraces } from "../db/traces.ts";
import { cleanupOldSnapshots } from "../db/prompt-snapshots.ts";
import { saveMessage } from "../db/messages.ts";
import { getActiveThreadId } from "../db/threads.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { getLog } from "../logging.ts";

const log = getLog("scheduler");

const intervals = new Map<string, ReturnType<typeof setInterval>>();
const tickRunning = new Map<string, boolean>();
let lastCleanupAt = 0;
const TICK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per tick

export function startScheduler(api: Api, config: Config, botConfig: BotConfig): void {
  if (!config.schedulerEnabled) {
    log.info("Scheduler disabled", { botName: botConfig.name });
    return;
  }

  const intervalMs = config.schedulerIntervalMs;
  const tag = botConfig.name;
  log.info("Unified scheduler started (interval: {interval}s)", { botName: tag, interval: intervalMs / 1000 });

  const id = setInterval(() => {
    if (tickRunning.get(tag)) {
      log.warn("Scheduler tick skipped — previous tick still running", { botName: tag });
      return;
    }
    tickRunning.set(tag, true);

    let timeoutId: ReturnType<typeof setTimeout>;
    const tickWithTimeout = Promise.race([
      runSchedulerTick(api, config, botConfig),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Scheduler tick timed out after ${TICK_TIMEOUT_MS}ms`)), TICK_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timeoutId));

    tickWithTimeout
      .catch((err) => {
        log.error("Scheduler tick failed: {error}", { botName: tag, error: err instanceof Error ? err.message : String(err) });
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
    log.info("Scheduler stopped", { botName: tag });
  }
  intervals.clear();
}

export async function waitForPendingTicks(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const anyRunning = [...tickRunning.values()].some(Boolean);
    if (!anyRunning) return;
    await Bun.sleep(200);
  }
  const running = [...tickRunning.entries()].filter(([, v]) => v).map(([k]) => k);
  if (running.length > 0) {
    log.warn("Shutdown: timed out waiting for scheduler ticks: {bots}", { bots: running.join(", ") });
  }
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
      await runGoalRemindersFromList(api, config, botConfig, goalReminders);
      t?.end("goal_reminders", { count: goalReminders.length });
    }

    // 3. Goal check-ins (stale goals, max 1 per tick)
    if (staleGoals.length > 0) {
      t?.start("goal_checkins");
      await runGoalCheckinsFromList(api, config, botConfig, staleGoals);
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
        log.info("Cleaned up {count} old traces", { botName, count: deleted });
      }
      const deletedSnapshots = await cleanupOldSnapshots(config.promptSnapshotsRetentionDays);
      if (deletedSnapshots > 0) {
        log.info("Cleaned up {count} old prompt snapshots", { botName, count: deletedSnapshots });
      }
    } catch (err) {
      log.error("Trace cleanup failed: {error}", { botName, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// --- Scheduled Tasks ---

async function runScheduledTasksFromList(api: Api, config: Config, botConfig: BotConfig, dueTasks: ScheduledTask[]): Promise<void> {
  const tag = botConfig.name;
  for (const task of dueTasks) {
    try {
      agentStatus.set("running_task", task.title);
      const requestId = agentStatus.startRequest(botConfig.name, "running_task");
      setConnectorInfo(botConfig, config.claudeModel);
      const markdown = await executeTask(task, config, botConfig);
      agentStatus.set("sending_telegram", task.title);
      agentStatus.updatePhase("sending_telegram");
      await api.sendMessage(task.userId, formatTelegramHtml(markdown), { parse_mode: "HTML" });
      const threadId = await getActiveThreadId(task.userId, tag);
      await saveMessage({
        userId: task.userId, botName: tag, role: "assistant", content: markdown,
        source: `task:${task.taskType}`, platform: "telegram", threadId,
      });
      await updateTaskLastRun(task);
      agentStatus.completeRequest(requestId, {});
      agentStatus.set("idle");
      activityLog.push(
        "system",
        `Scheduled task fired: ${task.title} (${task.taskType})`,
        { userId: task.userId, botName: tag },
      );
      log.info("Scheduled task fired: \"{title}\" ({taskType}) to user {userId}", { botName: tag, title: task.title, taskType: task.taskType, userId: task.userId });
    } catch (err) {
      agentStatus.clearRequest();
      agentStatus.set("idle");
      log.error("Failed to execute scheduled task {taskId}: {error}", { botName: tag, taskId: task.id, error: err instanceof Error ? err.message : String(err) });

      // Still advance schedule to prevent infinite retry storms (same pattern as watchers)
      try {
        await updateTaskLastRun(task);
      } catch (updateErr) {
        log.error("Failed to update task last_run_at after error: {error}", { botName: tag, taskId: task.id, error: updateErr instanceof Error ? updateErr.message : String(updateErr) });
      }
    }
  }
}

async function executeTask(task: ScheduledTask, config: Config, botConfig: BotConfig): Promise<string> {
  const cwd = botConfig.dir;
  switch (task.taskType) {
    case "reminder":
      return await callHaiku(
        `Generate a brief, natural reminder message (2-3 sentences max). Use markdown formatting (**bold**, *italic*). Be helpful, not pushy.\n\nReminder: "${task.title}"${task.prompt ? `\nContext: ${task.prompt}` : ""}`,
        `**Reminder:** ${task.title}`,
        "reminder",
        cwd,
        botConfig.name,
      );

    case "briefing":
      return await generateBriefing(task, config, botConfig);

    case "custom":
      if (!task.prompt) return `**${task.title}**`;
      return await callHaiku(
        `${task.prompt}\n\nRespond using markdown formatting (**bold**, *italic*). Keep it concise.`,
        `**${task.title}**`,
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

    log.info("Briefing prompt built in {ms}ms ({memoriesCount} memories, {goalsCount} goals, {tasksCount} tasks, {alertsCount} alerts)", {
      botName: botConfig.name, ms: Math.round(meta.buildMs), memoriesCount: meta.memoriesCount,
      goalsCount: meta.goalsCount, tasksCount: meta.scheduledTasksCount, alertsCount: meta.alertsCount,
    });

    const result = await resolveConnector(botConfig)(userPrompt, config, botConfig, systemPrompt, createProgressCallback("running_task"));

    const totalMs = Math.round(performance.now() - t0);
    log.info("Briefing generated in {ms}ms (model: {model}, input: {input}, output: {output}, turns: {turns})", {
      botName: botConfig.name, ms: totalMs, model: result.model,
      input: result.inputTokens, output: result.outputTokens, turns: result.numTurns,
    });

    return result.result.trim();
  } catch (err) {
    log.error("Briefing generation failed, using fallback: {error}", { botName: botConfig.name, error: err instanceof Error ? err.message : String(err) });
    const timeOfDay = task.scheduleHour < 12 ? "morning" : task.scheduleHour < 17 ? "afternoon" : "evening";
    return `**Good ${timeOfDay}!**\nI wasn't able to generate your full briefing this time. Check back later!`;
  }
}

// --- Goal Reminders (moved from goals/scheduler.ts) ---

async function runGoalRemindersFromList(api: Api, config: Config, botConfig: BotConfig, reminders: Goal[]): Promise<void> {
  const tag = botConfig.name;
  for (const goal of reminders) {
    try {
      agentStatus.set("checking_goals", goal.title);
      const requestId = agentStatus.startRequest(botConfig.name, "checking_goals");
      setConnectorInfo(botConfig, config.claudeModel);
      const markdown = await generateReminderMessage(goal, botConfig);
      agentStatus.set("sending_telegram", goal.title);
      agentStatus.updatePhase("sending_telegram");
      await api.sendMessage(goal.userId, formatTelegramHtml(markdown), { parse_mode: "HTML" });
      const threadId = await getActiveThreadId(goal.userId, tag);
      await saveMessage({
        userId: goal.userId, botName: tag, role: "assistant", content: markdown,
        source: "goal:reminder", platform: "telegram", threadId,
      });
      agentStatus.completeRequest(requestId, {});
      agentStatus.set("idle");
      await updateGoalReminderSentAt(goal.id);
      activityLog.push(
        "system",
        `Deadline reminder sent for goal: ${goal.title}`,
        { userId: goal.userId, botName: tag },
      );
      log.info("Deadline reminder sent: \"{title}\" to user {userId}", { botName: tag, title: goal.title, userId: goal.userId });
    } catch (err) {
      agentStatus.clearRequest();
      agentStatus.set("idle");
      log.error("Failed to send reminder for goal {goalId}: {error}", { botName: tag, goalId: goal.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function runGoalCheckinsFromList(api: Api, config: Config, botConfig: BotConfig, staleGoals: Goal[]): Promise<void> {
  const tag = botConfig.name;
  if (staleGoals.length > 0) {
    const goal = staleGoals[0]!;
    try {
      agentStatus.set("checking_goals", goal.title);
      const requestId = agentStatus.startRequest(botConfig.name, "checking_goals");
      setConnectorInfo(botConfig, config.claudeModel);
      const markdown = await generateCheckinMessage(goal, botConfig);
      agentStatus.set("sending_telegram", goal.title);
      agentStatus.updatePhase("sending_telegram");
      await api.sendMessage(goal.userId, formatTelegramHtml(markdown), { parse_mode: "HTML" });
      const ciThreadId = await getActiveThreadId(goal.userId, tag);
      await saveMessage({
        userId: goal.userId, botName: tag, role: "assistant", content: markdown,
        source: "goal:checkin", platform: "telegram", threadId: ciThreadId,
      });
      agentStatus.completeRequest(requestId, {});
      agentStatus.set("idle");
      await updateGoalCheckedAt(goal.id);
      activityLog.push(
        "system",
        `Check-in sent for goal: ${goal.title}`,
        { userId: goal.userId, botName: tag },
      );
      log.info("Check-in sent: \"{title}\" to user {userId}", { botName: tag, title: goal.title, userId: goal.userId });
    } catch (err) {
      agentStatus.clearRequest();
      agentStatus.set("idle");
      log.error("Failed to send check-in for goal {goalId}: {error}", { botName: tag, goalId: goal.id, error: err instanceof Error ? err.message : String(err) });
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
    `Generate a brief, natural reminder message (2-3 sentences max) about an approaching deadline. Use markdown formatting (**bold**, *italic*). Be helpful and motivating, not pushy. Don't use emojis excessively.\n\nGoal: "${goal.title}"\n${goal.description ? `Context: ${goal.description}` : ""}\nDeadline: ${deadlineStr}\nTags: ${goal.tags.join(", ") || "none"}`,
    `**Deadline approaching:** ${goal.title}\nDue: ${deadlineStr}`,
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
    `Generate a brief, natural check-in message (2-3 sentences max) asking about progress on a goal. Use markdown formatting (**bold**, *italic*). Be conversational and supportive, not nagging. Don't use emojis excessively.\n\nGoal: "${goal.title}"\n${goal.description ? `Context: ${goal.description}` : ""}\nSet on: ${createdStr}\nTags: ${goal.tags.join(", ") || "none"}`,
    `**Goal check-in:** ${goal.title}\nHow's this going?`,
    "checkin",
    botConfig.dir,
    botConfig.name,
  );
}
