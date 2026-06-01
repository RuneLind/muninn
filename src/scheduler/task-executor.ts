import type { Api } from "grammy";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ScheduledTask } from "../types.ts";
import { updateTaskLastRun } from "../db/scheduled-tasks.ts";
import { activityLog } from "../observability/activity-log.ts";
import { agentStatus, createProgressCallback, setConnectorInfo } from "../observability/agent-status.ts";
import { callHaiku } from "./executor.ts";
import { resolveConnector } from "../ai/connector.ts";
import { buildBriefingPrompt } from "./briefing-prompt.ts";
import { saveMessage } from "../db/messages.ts";
import { getActiveThreadId } from "../db/threads.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { getLog } from "../logging.ts";

const log = getLog("scheduler", "task-executor");

export async function runScheduledTasksFromList(api: Api, config: Config, botConfig: BotConfig, dueTasks: ScheduledTask[]): Promise<void> {
  const tag = botConfig.name;
  for (const task of dueTasks) {
    let requestId: string | undefined;
    try {
      agentStatus.set("running_task", task.title);
      requestId = agentStatus.startRequest(botConfig.name, "running_task");
      setConnectorInfo(requestId, botConfig, config.claudeModel);
      const markdown = await executeTask(task, config, botConfig, requestId);
      agentStatus.set("sending_telegram", task.title);
      agentStatus.updatePhase(requestId, "sending_telegram");
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
      if (requestId) agentStatus.clearRequest(requestId);
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

async function executeTask(task: ScheduledTask, config: Config, botConfig: BotConfig, requestId: string): Promise<string> {
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
      return await generateBriefing(task, config, botConfig, requestId);

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

async function generateBriefing(task: ScheduledTask, config: Config, botConfig: BotConfig, requestId: string): Promise<string> {
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

    const result = await resolveConnector(botConfig)(userPrompt, config, botConfig, systemPrompt, createProgressCallback(requestId, "running_task"));

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
