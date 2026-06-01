import type { Api } from "grammy";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Goal } from "../types.ts";
import {
  updateGoalReminderSentAt,
  updateGoalCheckedAt,
} from "../db/goals.ts";
import { activityLog } from "../observability/activity-log.ts";
import { agentStatus, setConnectorInfo } from "../observability/agent-status.ts";
import { callHaiku } from "./executor.ts";
import { saveMessage } from "../db/messages.ts";
import { getActiveThreadId } from "../db/threads.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { getLog } from "../logging.ts";

const log = getLog("scheduler", "goal-runner");

export async function runGoalRemindersFromList(api: Api, config: Config, botConfig: BotConfig, reminders: Goal[]): Promise<void> {
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

export async function runGoalCheckinsFromList(api: Api, config: Config, botConfig: BotConfig, staleGoals: Goal[]): Promise<void> {
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
