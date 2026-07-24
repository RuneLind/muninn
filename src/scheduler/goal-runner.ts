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
import { callHaiku, type HaikuUsage } from "./executor.ts";
import { saveMessage } from "../db/messages.ts";
import { getActiveThreadId } from "../db/threads.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { Tracer } from "../tracing/index.ts";
import { getLog } from "../logging.ts";

const log = getLog("scheduler", "goal-runner");

/** Root-span meta for a goal Haiku run. `spawnHaiku` (via `callHaiku`) ALWAYS
 *  spawns `claude -p`, so the honest connector is the literal `"claude-cli"`
 *  (never `botConfig.connector`) — mirrors task-executor's reminder/custom path.
 *  `model` is captured from `callHaiku`'s `onUsage`; a Haiku error returns the
 *  fallback and fires no `onUsage`, so `usage` stays undefined and we stamp only
 *  the status (the root row stays blank-backend, as it was before this tracer). */
function goalRunMeta(usage: HaikuUsage | undefined): Record<string, unknown> {
  if (!usage) return {};
  return {
    connector: "claude-cli",
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.numTurns != null ? { numTurns: usage.numTurns } : {}),
    ...(usage.costUsd != null ? { costUsd: usage.costUsd } : {}),
  };
}

export async function runGoalRemindersFromList(api: Api, config: Config, botConfig: BotConfig, reminders: Goal[]): Promise<void> {
  const tag = botConfig.name;
  for (const goal of reminders) {
    let requestId: string | undefined;
    // Per-run ROOT tracer — goal reminders had NO tracer before, so their
    // `haiku_usage` rows wrote a NULL trace_id (a telemetry black hole) and never
    // appeared on /traces. This mints a `goal_reminder` root; `callHaiku`'s
    // telemetry threads it into `spawnHaiku` (join #267) and captures usage for
    // the root-span meta stamp below.
    const tracer = new Tracer("goal_reminder", { botName: tag, userId: goal.userId, platform: "telegram" });
    let usage: HaikuUsage | undefined;
    try {
      agentStatus.set("checking_goals", goal.title);
      requestId = agentStatus.startRequest(botConfig.name, "checking_goals", undefined, {
        kind: "scheduled_task",
        name: `Goal reminder: ${goal.title}`,
      });
      setConnectorInfo(requestId, botConfig, config.claudeModel);
      const markdown = await generateReminderMessage(goal, botConfig, { tracer, onUsage: (u) => { usage = u; } });
      agentStatus.set("sending_telegram", goal.title);
      agentStatus.updatePhase(requestId, "sending_telegram");
      await api.sendMessage(goal.userId, formatTelegramHtml(markdown), { parse_mode: "HTML" });
      const threadId = await getActiveThreadId(goal.userId, tag);
      await saveMessage({
        userId: goal.userId, botName: tag, role: "assistant", content: markdown,
        source: "goal:reminder", platform: "telegram", threadId,
      });
      agentStatus.completeRequest(requestId, { traceId: tracer.traceId });
      agentStatus.set("idle");
      await updateGoalReminderSentAt(goal.id);
      activityLog.push(
        "system",
        `Deadline reminder sent for goal: ${goal.title}`,
        { userId: goal.userId, botName: tag },
      );
      log.info("Deadline reminder sent: \"{title}\" to user {userId}", { botName: tag, title: goal.title, userId: goal.userId });
      // Stamp the honest connector + captured model/tokens onto the ROOT span so
      // getRecentTraces renders a non-blank backend (mapRow gives root-own attrs
      // precedence). `spawnHaiku` stamps no connector/model span of its own, so
      // without this the new root row would be blank-backend. Settle LAST — after
      // the post-send DB write + activity log — so a throw from those error-settles
      // exactly ONCE via the catch, instead of a second settle flipping an
      // already-ok root to error even though the user got the message.
      tracer.finish("ok", goalRunMeta(usage));
    } catch (err) {
      if (requestId) agentStatus.clearRequest(requestId);
      agentStatus.set("idle");
      // Settle the root span on failure so it never leaks unfinished.
      tracer.error(err instanceof Error ? err : String(err));
      log.error("Failed to send reminder for goal {goalId}: {error}", { botName: tag, goalId: goal.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export async function runGoalCheckinsFromList(api: Api, config: Config, botConfig: BotConfig, staleGoals: Goal[]): Promise<void> {
  const tag = botConfig.name;
  if (staleGoals.length > 0) {
    const goal = staleGoals[0]!;
    let requestId: string | undefined;
    // Per-run ROOT tracer — same rationale as the reminder path above.
    const tracer = new Tracer("goal_checkin", { botName: tag, userId: goal.userId, platform: "telegram" });
    let usage: HaikuUsage | undefined;
    try {
      agentStatus.set("checking_goals", goal.title);
      requestId = agentStatus.startRequest(botConfig.name, "checking_goals", undefined, {
        kind: "scheduled_task",
        name: `Goal check-in: ${goal.title}`,
      });
      setConnectorInfo(requestId, botConfig, config.claudeModel);
      const markdown = await generateCheckinMessage(goal, botConfig, { tracer, onUsage: (u) => { usage = u; } });
      agentStatus.set("sending_telegram", goal.title);
      agentStatus.updatePhase(requestId, "sending_telegram");
      await api.sendMessage(goal.userId, formatTelegramHtml(markdown), { parse_mode: "HTML" });
      const ciThreadId = await getActiveThreadId(goal.userId, tag);
      await saveMessage({
        userId: goal.userId, botName: tag, role: "assistant", content: markdown,
        source: "goal:checkin", platform: "telegram", threadId: ciThreadId,
      });
      agentStatus.completeRequest(requestId, { traceId: tracer.traceId });
      agentStatus.set("idle");
      await updateGoalCheckedAt(goal.id);
      activityLog.push(
        "system",
        `Check-in sent for goal: ${goal.title}`,
        { userId: goal.userId, botName: tag },
      );
      log.info("Check-in sent: \"{title}\" to user {userId}", { botName: tag, title: goal.title, userId: goal.userId });
      // Settle LAST (same rationale as the reminder path) so a post-send DB
      // failure error-settles once via the catch instead of double-settling an
      // already-ok root.
      tracer.finish("ok", goalRunMeta(usage));
    } catch (err) {
      if (requestId) agentStatus.clearRequest(requestId);
      agentStatus.set("idle");
      tracer.error(err instanceof Error ? err : String(err));
      log.error("Failed to send check-in for goal {goalId}: {error}", { botName: tag, goalId: goal.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function generateReminderMessage(
  goal: Goal,
  botConfig: BotConfig,
  telemetry?: { tracer?: Tracer; onUsage?: (u: HaikuUsage) => void },
): Promise<string> {
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
    undefined,
    telemetry,
  );
}

async function generateCheckinMessage(
  goal: Goal,
  botConfig: BotConfig,
  telemetry?: { tracer?: Tracer; onUsage?: (u: HaikuUsage) => void },
): Promise<string> {
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
    undefined,
    telemetry,
  );
}
