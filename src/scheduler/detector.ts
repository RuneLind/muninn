import type { Config } from "../config.ts";
import { saveScheduledTask, findSimilarTask, updateTaskPrompt } from "../db/scheduled-tasks.ts";
import type { TaskType } from "../types.ts";
import { spawnHaiku } from "./executor.ts";
import { Tracer, type TraceContext } from "../tracing/index.ts";

interface DetectionInput {
  userId: string;
  botName: string;
  userMessage: string;
  assistantResponse: string;
  platform?: string;
}

interface DetectionResult {
  has_schedule: boolean;
  title?: string;
  task_type?: TaskType;
  hour?: number;
  minute?: number;
  days?: number[]; // 0=Sun..6=Sat
  interval_ms?: number;
  prompt?: string;
  timezone?: string;
}

const DETECTION_PROMPT = `You are a schedule detection system. Analyze this conversation and decide if the user wants to set up a recurring scheduled task, reminder, or briefing.

Worth detecting: "remind me every morning at 8", "every Friday send me a summary", "every 2 hours remind me to stretch", "give me a daily briefing at 7am", "send me a weekly report every Monday".
NOT worth detecting: one-time reminders ("remind me in 10 minutes"), questions, vague wishes, or requests that aren't recurring.

For the task_type field:
- "reminder" — simple recurring reminders ("remind me to stretch every 2 hours")
- "briefing" — daily/weekly summaries or briefings ("morning briefing at 8am")
- "custom" — anything else that needs AI processing ("every Friday summarize my week")

For days: use 0=Sunday, 1=Monday, ..., 6=Saturday. Omit for every day.
For interval_ms: use for "every N hours/minutes" patterns instead of specific times. Convert to milliseconds.
hour/minute: use 24h format. For interval tasks, this is the first run time.
timezone: default to "Europe/Oslo" unless the user specifies otherwise.

Respond with ONLY valid JSON (no markdown fences):
{"has_schedule": false}
or
{"has_schedule": true, "title": "Morning briefing", "task_type": "briefing", "hour": 8, "minute": 0, "days": [1,2,3,4,5], "prompt": "Include goals and calendar summary", "timezone": "Europe/Oslo"}
or for interval: {"has_schedule": true, "title": "Stretch reminder", "task_type": "reminder", "hour": 9, "minute": 0, "interval_ms": 7200000}

User said: """
{USER_MESSAGE}
"""

Assistant replied: """
{ASSISTANT_RESPONSE}
"""`;

export function extractScheduleAsync(
  input: DetectionInput,
  config: Config,
  traceContext?: TraceContext,
): void {
  doExtract(input, config, traceContext).catch((err) => {
    console.error("[Jarvis] Schedule detection failed:", err);
  });
}

async function doExtract(
  input: DetectionInput,
  config: Config,
  traceContext?: TraceContext,
): Promise<void> {
  let tracer: Tracer | undefined;
  if (traceContext) {
    tracer = new Tracer("schedule_detection", {
      botName: input.botName,
      userId: input.userId,
      traceId: traceContext.traceId,
      parentId: traceContext.parentId,
    });
  }

  const prompt = DETECTION_PROMPT.replace(
    "{USER_MESSAGE}",
    input.userMessage,
  ).replace("{ASSISTANT_RESPONSE}", input.assistantResponse);

  const haiku = await spawnHaiku(prompt, "schedule", "jarvis-schedule-detector", undefined, input.botName);

  let result: DetectionResult;
  try {
    const cleaned = haiku.result
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/, "");
    result = JSON.parse(cleaned);
  } catch {
    console.error(
      "[Jarvis] Schedule detection: failed to parse result:",
      haiku.result,
    );
    tracer?.finish("error", { error: "parse_failed" });
    return;
  }

  if (!result.has_schedule || !result.title || result.hour == null) {
    tracer?.finish("ok", { hasSchedule: false });
    return;
  }

  const taskType = result.task_type ?? "reminder";

  // Check for existing similar task to avoid duplicates
  const existing = await findSimilarTask(
    input.userId,
    input.botName,
    result.title,
    taskType,
  );

  if (existing) {
    // Update prompt if it changed, otherwise skip
    const newPrompt = result.prompt ?? null;
    if (newPrompt !== existing.prompt) {
      await updateTaskPrompt(existing.id, newPrompt);
      console.log(
        `[Jarvis] Scheduled task updated (duplicate detected): "${result.title}" (${taskType}, id: ${existing.id})`,
      );
    } else {
      console.log(
        `[Jarvis] Scheduled task skipped (duplicate): "${result.title}" (${taskType}, id: ${existing.id})`,
      );
    }
    tracer?.finish("ok", { hasSchedule: true, title: result.title, taskType, duplicate: true });
    return;
  }

  const taskId = await saveScheduledTask({
    userId: input.userId,
    botName: input.botName,
    title: result.title,
    taskType: taskType,
    prompt: result.prompt ?? null,
    scheduleHour: result.hour,
    scheduleMinute: result.minute ?? 0,
    scheduleDays: result.days ?? null,
    scheduleIntervalMs: result.interval_ms ?? null,
    timezone: result.timezone ?? "Europe/Oslo",
    platform: input.platform,
  });

  console.log(
    `[Jarvis] Scheduled task detected: "${result.title}" (${taskType}, id: ${taskId})`,
  );

  tracer?.finish("ok", { hasSchedule: true, title: result.title, taskType });
}
