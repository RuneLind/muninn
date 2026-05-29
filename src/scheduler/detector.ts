import type { Config } from "../config.ts";
import { saveScheduledTask, findSimilarTask, updateTaskPrompt, updateScheduledTask } from "../db/scheduled-tasks.ts";
import type { TaskType, Platform, ScheduledTask } from "../types.ts";
import { runHaikuExtraction } from "../ai/haiku-extraction.ts";
import type { TraceContext } from "../tracing/index.ts";
import type { ConnectorType } from "../bots/config.ts";
import type { HaikuBackend } from "../ai/haiku-direct.ts";
import { getLog } from "../logging.ts";
import { fillTemplate } from "../utils/fill-template.ts";

const log = getLog("scheduler", "detector");

interface DetectionInput {
  userId: string;
  botName: string;
  botDir?: string;
  userMessage: string;
  assistantResponse: string;
  platform?: Platform;
  connector?: ConnectorType;
  haikuBackend?: HaikuBackend;
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

type ScheduleUpdate = {
  scheduleHour?: number;
  scheduleMinute?: number;
  scheduleDays?: number[] | null;
  scheduleIntervalMs?: number | null;
};

function daysEqual(a: number[] | null, b: number[] | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Compute which schedule fields the detector wants to change on an existing
 * task. Only fields the detector actually restated are compared — an omitted
 * field means "no opinion", not "clear it", so we never clobber an existing
 * days/interval just because the re-detected JSON left it out. Returns only the
 * fields that actually differ, so an unchanged schedule yields an empty object.
 */
export function diffScheduleFields(
  existing: Pick<ScheduledTask, "scheduleHour" | "scheduleMinute" | "scheduleDays" | "scheduleIntervalMs">,
  result: Pick<DetectionResult, "hour" | "minute" | "days" | "interval_ms">,
): ScheduleUpdate {
  const change: ScheduleUpdate = {};
  if (result.hour != null && result.hour !== existing.scheduleHour) {
    change.scheduleHour = result.hour;
  }
  if (result.minute != null && result.minute !== existing.scheduleMinute) {
    change.scheduleMinute = result.minute;
  }
  if (result.days != null && !daysEqual(result.days, existing.scheduleDays)) {
    change.scheduleDays = result.days;
  }
  if (result.interval_ms != null && result.interval_ms !== existing.scheduleIntervalMs) {
    change.scheduleIntervalMs = result.interval_ms;
  }
  return change;
}

export function extractScheduleAsync(
  input: DetectionInput,
  _config: Config,
  traceContext?: TraceContext,
): void {
  const prompt = fillTemplate(DETECTION_PROMPT, {
    USER_MESSAGE: input.userMessage,
    ASSISTANT_RESPONSE: input.assistantResponse,
  });

  runHaikuExtraction<DetectionResult>({
    spanName: "schedule_detection",
    source: "schedule",
    entrypoint: "jarvis-schedule-detector",
    botName: input.botName,
    userId: input.userId,
    prompt,
    cwd: input.botDir,
    connector: input.connector,
    haikuBackend: input.haikuBackend,
    log,
    traceContext,
    onResult: async (result, tracer) => {
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
        // Diff schedule + prompt fields. If only the prompt changed, a cheap
        // updateTaskPrompt suffices; if any schedule field moved, route through
        // updateScheduledTask so next_run_at is recomputed (updateTaskPrompt
        // alone leaves the task firing on the old cadence).
        const scheduleChange = diffScheduleFields(existing, result);
        const newPrompt = result.prompt ?? null;
        const promptChanged = newPrompt !== existing.prompt;

        if (Object.keys(scheduleChange).length > 0) {
          await updateScheduledTask(existing.id, {
            ...scheduleChange,
            ...(promptChanged ? { prompt: newPrompt } : {}),
          });
          log.info("Scheduled task rescheduled (duplicate detected): \"{title}\" ({taskType}, id: {taskId})", { botName: input.botName, title: result.title, taskType, taskId: existing.id });
        } else if (promptChanged) {
          await updateTaskPrompt(existing.id, newPrompt);
          log.info("Scheduled task updated (duplicate detected): \"{title}\" ({taskType}, id: {taskId})", { botName: input.botName, title: result.title, taskType, taskId: existing.id });
        } else {
          log.info("Scheduled task skipped (duplicate): \"{title}\" ({taskType}, id: {taskId})", { botName: input.botName, title: result.title, taskType, taskId: existing.id });
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

      log.info("Scheduled task detected: \"{title}\" ({taskType}, id: {taskId})", { botName: input.botName, title: result.title, taskType, taskId });

      tracer?.finish("ok", { hasSchedule: true, title: result.title, taskType });
    },
  });
}
