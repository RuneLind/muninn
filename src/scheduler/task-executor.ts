import type { Api } from "grammy";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ScheduledTask } from "../types.ts";
import { updateTaskLastRun } from "../db/scheduled-tasks.ts";
import { activityLog } from "../observability/activity-log.ts";
import { agentStatus, createProgressCallback, setConnectorInfo } from "../observability/agent-status.ts";
import { callHaiku, type HaikuUsage } from "./executor.ts";
import { resolveConnector } from "../ai/connector.ts";
import { buildBriefingPrompt } from "./briefing-prompt.ts";
import { saveMessage } from "../db/messages.ts";
import { getActiveThreadId } from "../db/threads.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { attachToolSpans } from "../core/tool-spans.ts";
import { Tracer, type TraceContext } from "../tracing/index.ts";
import { getLog } from "../logging.ts";

const log = getLog("scheduler", "task-executor");

export async function runScheduledTasksFromList(api: Api, config: Config, botConfig: BotConfig, dueTasks: ScheduledTask[], traceContext?: TraceContext): Promise<void> {
  const tag = botConfig.name;
  for (const task of dueTasks) {
    let requestId: string | undefined;
    // Per-task child tracer under the scheduler_tick trace — mirrors the watcher
    // runner's `watcher:<type>` span (child of the tick root). Absent when the
    // caller passes no context (the dashboard manual-trigger path in
    // data-routes.ts), in which case every tracer call is a null-guarded no-op
    // and behavior is byte-identical to before. Created here (not at function
    // entry via a shared span) because each due task is a real run — the tick
    // trace only opens when there IS work, so no phantom span per idle tick.
    let tt: Tracer | undefined;
    if (traceContext) {
      tt = new Tracer(`task:${task.taskType}`, {
        botName: tag,
        userId: task.userId,
        traceId: traceContext.traceId,
        parentId: traceContext.parentId,
      });
    }
    try {
      agentStatus.set("running_task", task.title);
      requestId = agentStatus.startRequest(botConfig.name, "running_task", undefined, {
        kind: "scheduled_task",
        name: task.title,
      });
      setConnectorInfo(requestId, botConfig, config.claudeModel);
      const { markdown, meta } = await executeTask(task, config, botConfig, requestId, tt);
      agentStatus.set("sending_telegram", task.title);
      agentStatus.updatePhase(requestId, "sending_telegram");
      await api.sendMessage(task.userId, formatTelegramHtml(markdown), { parse_mode: "HTML" });
      const threadId = await getActiveThreadId(task.userId, tag);
      await saveMessage({
        userId: task.userId, botName: tag, role: "assistant", content: markdown,
        source: `task:${task.taskType}`, platform: "telegram", threadId,
      });
      await updateTaskLastRun(task);
      agentStatus.completeRequest(requestId, meta);
      agentStatus.set("idle");
      // Settle the task span on success. The `claude`/haiku token attrs land on
      // this span for /traces; Recent stays ring-sourced for scheduled_task (the
      // "never both" rule — task:% is deliberately NOT added to
      // getRecentAgentTraces), so these attrs never double-count.
      tt?.finish("ok", { taskType: task.taskType, ...meta });
      activityLog.push(
        "system",
        `Scheduled task fired: ${task.title} (${task.taskType})`,
        { userId: task.userId, botName: tag },
      );
      log.info("Scheduled task fired: \"{title}\" ({taskType}) to user {userId}", { botName: tag, title: task.title, taskType: task.taskType, userId: task.userId });
    } catch (err) {
      if (requestId) agentStatus.clearRequest(requestId);
      agentStatus.set("idle");
      // Settle the task span on failure so it never leaks unfinished.
      tt?.error(err instanceof Error ? err : String(err));
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

/** Completion metadata threaded out of a task run so the caller can pass real
 *  token/turn counts to `completeRequest` and stamp them onto the `task:<type>`
 *  span. The briefing path has a full `ClaudeExecResult`; the reminder/custom
 *  Haiku paths surface their usage via {@link callHaiku}'s `onUsage` seam. `model`
 *  rides here only for the span attrs — `completeRequest` ignores it (the Recent
 *  card's model comes from `setConnectorInfo`). */
interface TaskResult {
  markdown: string;
  meta: { inputTokens?: number; outputTokens?: number; numTurns?: number; toolCount?: number; model?: string };
}

async function executeTask(task: ScheduledTask, config: Config, botConfig: BotConfig, requestId: string, tracer?: Tracer): Promise<TaskResult> {
  const cwd = botConfig.dir;
  switch (task.taskType) {
    case "reminder":
      return await runHaikuTask(
        `Generate a brief, natural reminder message (2-3 sentences max). Use markdown formatting (**bold**, *italic*). Be helpful, not pushy.\n\nReminder: "${task.title}"${task.prompt ? `\nContext: ${task.prompt}` : ""}`,
        `**Reminder:** ${task.title}`,
        "reminder",
        cwd,
        botConfig.name,
        tracer,
      );

    case "briefing":
      return await generateBriefing(task, config, botConfig, requestId, tracer);

    case "custom":
      if (!task.prompt) return { markdown: `**${task.title}**`, meta: {} };
      return await runHaikuTask(
        `${task.prompt}\n\nRespond using markdown formatting (**bold**, *italic*). Keep it concise.`,
        `**${task.title}**`,
        "task",
        cwd,
        botConfig.name,
        tracer,
      );
  }
}

/**
 * Reminder / custom tasks call Haiku (no `ClaudeExecResult`). Thread the per-task
 * tracer so the `haiku_usage` row joins the trace (the `trace_id` column, #267)
 * and capture the call's token usage via `onUsage` so the coarse `task:<type>`
 * span + the `/agents` card carry real numbers. No `claude` child span is stamped
 * here — these paths run no tools, and the token totals ride on the task span's
 * own attrs (via the caller's `tt.finish`). On a Haiku error `callHaiku` returns
 * the fallback and `onUsage` never fires ⇒ empty meta (byte-identical to before).
 */
async function runHaikuTask(
  prompt: string,
  fallback: string,
  source: string,
  cwd: string | undefined,
  botName: string,
  tracer?: Tracer,
): Promise<TaskResult> {
  let usage: HaikuUsage | undefined;
  const markdown = await callHaiku(prompt, fallback, source, cwd, botName, undefined, {
    tracer,
    onUsage: (u) => { usage = u; },
  });
  return {
    markdown,
    meta: usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.numTurns != null ? { numTurns: usage.numTurns } : {}),
          model: usage.model,
        }
      : {},
  };
}

async function generateBriefing(task: ScheduledTask, config: Config, botConfig: BotConfig, requestId: string, tracer?: Tracer): Promise<TaskResult> {
  const t0 = performance.now();
  const connectorType = botConfig.connector ?? "claude-cli";
  // Guards the catch's `tracer.end("claude")`: if buildBriefingPrompt throws
  // BEFORE the span is opened, ending an unstarted span throws (Timing.end), which
  // would swallow the fallback path. Only end what we started.
  let claudeStarted = false;

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

    // `claude` span around the connector call — mirrors the chat path
    // (message-processor.ts) and the capture path (summarizer-shared.ts): the
    // span carries model/tokens/cost and tool child spans hang off it.
    tracer?.start("claude", { connector: connectorType, requestedModel: botConfig.model ?? config.claudeModel });
    claudeStarted = true;
    const result = await resolveConnector(botConfig)(userPrompt, config, botConfig, systemPrompt, createProgressCallback(requestId, "running_task"));
    const toolCount = result.toolCalls?.length ?? 0;
    tracer?.end("claude", {
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      numTurns: result.numTurns,
      costUsd: result.costUsd,
      toolCount,
    });
    claudeStarted = false;
    if (tracer) await attachToolSpans(tracer, result.toolCalls, !!config.tracingCaptureToolOutputs);

    const totalMs = Math.round(performance.now() - t0);
    log.info("Briefing generated in {ms}ms (model: {model}, input: {input}, output: {output}, turns: {turns})", {
      botName: botConfig.name, ms: totalMs, model: result.model,
      input: result.inputTokens, output: result.outputTokens, turns: result.numTurns,
    });

    return {
      markdown: result.result.trim(),
      meta: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        numTurns: result.numTurns,
        toolCount,
        model: result.model,
      },
    };
  } catch (err) {
    if (claudeStarted) tracer?.end("claude", { error: err instanceof Error ? err.message : String(err) });
    log.error("Briefing generation failed, using fallback: {error}", { botName: botConfig.name, error: err instanceof Error ? err.message : String(err) });
    const timeOfDay = task.scheduleHour < 12 ? "morning" : task.scheduleHour < 17 ? "afternoon" : "evening";
    return {
      markdown: `**Good ${timeOfDay}!**\nI wasn't able to generate your full briefing this time. Check back later!`,
      meta: {},
    };
  }
}
