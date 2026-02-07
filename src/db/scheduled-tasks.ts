import { getDb } from "./client.ts";
import type { ScheduledTask, TaskType } from "../types.ts";

interface SaveScheduledTaskParams {
  userId: number;
  title: string;
  taskType: TaskType;
  prompt?: string | null;
  scheduleHour: number;
  scheduleMinute?: number;
  scheduleDays?: number[] | null;
  scheduleIntervalMs?: number | null;
  timezone?: string;
}

export async function saveScheduledTask(
  params: SaveScheduledTaskParams,
): Promise<string> {
  const sql = getDb();
  const nextRunAt = computeNextRunFromParams(params);

  const [row] = await sql`
    INSERT INTO scheduled_tasks (
      user_id, title, task_type, prompt,
      schedule_hour, schedule_minute, schedule_days,
      schedule_interval_ms, timezone, next_run_at
    )
    VALUES (
      ${params.userId},
      ${params.title},
      ${params.taskType},
      ${params.prompt ?? null},
      ${params.scheduleHour},
      ${params.scheduleMinute ?? 0},
      ${params.scheduleDays ?? null},
      ${params.scheduleIntervalMs ?? null},
      ${params.timezone ?? "Europe/Oslo"},
      ${nextRunAt}
    )
    RETURNING id
  `;
  return row!.id;
}

export async function getScheduledTasksForUser(
  userId: number,
): Promise<ScheduledTask[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM scheduled_tasks
    WHERE user_id = ${userId} AND enabled = true
    ORDER BY schedule_hour, schedule_minute
  `;
  return rows.map(mapRow);
}

export async function getTasksDueNow(): Promise<ScheduledTask[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM scheduled_tasks
    WHERE enabled = true
      AND next_run_at IS NOT NULL
      AND next_run_at <= now()
    ORDER BY next_run_at ASC
  `;
  return rows.map(mapRow);
}

export async function updateTaskLastRun(task: ScheduledTask): Promise<void> {
  const sql = getDb();
  const nextRunAt = computeNextRun(task);
  await sql`
    UPDATE scheduled_tasks
    SET last_run_at = now(), next_run_at = ${nextRunAt}
    WHERE id = ${task.id}
  `;
}

export async function disableTask(id: string): Promise<void> {
  const sql = getDb();
  await sql`UPDATE scheduled_tasks SET enabled = false WHERE id = ${id}`;
}

export async function enableTask(id: string): Promise<void> {
  const sql = getDb();
  await sql`UPDATE scheduled_tasks SET enabled = true WHERE id = ${id}`;
}

export async function deleteTask(id: string): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM scheduled_tasks WHERE id = ${id}`;
}

/**
 * Compute the next run time for a task.
 * Two modes:
 * - Interval-style: next = now + interval_ms
 * - Cron-style: next occurrence of hour:minute on matching day
 */
export function computeNextRun(task: ScheduledTask): Date {
  if (task.scheduleIntervalMs) {
    return new Date(Date.now() + task.scheduleIntervalMs);
  }
  return computeNextCronRun(
    task.scheduleHour,
    task.scheduleMinute,
    task.scheduleDays,
    task.timezone,
  );
}

function computeNextRunFromParams(params: SaveScheduledTaskParams): Date {
  if (params.scheduleIntervalMs) {
    // For interval tasks, first run at specified hour:minute today or tomorrow
    return computeNextCronRun(
      params.scheduleHour,
      params.scheduleMinute ?? 0,
      null, // first run ignores days filter
      params.timezone ?? "Europe/Oslo",
    );
  }
  return computeNextCronRun(
    params.scheduleHour,
    params.scheduleMinute ?? 0,
    params.scheduleDays ?? null,
    params.timezone ?? "Europe/Oslo",
  );
}

function computeNextCronRun(
  hour: number,
  minute: number,
  days: number[] | null,
  timezone: string,
): Date {
  // Get current time in the task's timezone
  const now = new Date();
  const nowInTz = new Date(
    now.toLocaleString("en-US", { timeZone: timezone }),
  );

  // Build candidate: today at hour:minute in task's timezone
  const candidate = new Date(nowInTz);
  candidate.setHours(hour, minute, 0, 0);

  // If candidate is in the past (already passed today), start from tomorrow
  if (candidate <= nowInTz) {
    candidate.setDate(candidate.getDate() + 1);
  }

  // If days filter is set, find the next matching day
  if (days && days.length > 0) {
    for (let i = 0; i < 7; i++) {
      const dayOfWeek = candidate.getDay();
      if (days.includes(dayOfWeek)) break;
      candidate.setDate(candidate.getDate() + 1);
    }
  }

  // Convert back from timezone-local to UTC
  // We construct a date string and parse it as the target timezone
  const tzOffset = getTimezoneOffsetMs(candidate, timezone);
  return new Date(candidate.getTime() + tzOffset);
}

/**
 * Get the offset in ms needed to convert a "fake local" Date
 * (one constructed from toLocaleString) back to real UTC.
 */
function getTimezoneOffsetMs(fakeLocal: Date, timezone: string): number {
  // Get what UTC thinks this time is
  const utcStr = fakeLocal.toLocaleString("en-US", { timeZone: "UTC" });
  const utcDate = new Date(utcStr);

  // Get what the target timezone thinks this time is
  const tzStr = fakeLocal.toLocaleString("en-US", { timeZone: timezone });
  const tzDate = new Date(tzStr);

  return utcDate.getTime() - tzDate.getTime();
}

function mapRow(r: Record<string, any>): ScheduledTask {
  return {
    id: r.id,
    userId: Number(r.user_id),
    title: r.title,
    taskType: r.task_type as TaskType,
    prompt: r.prompt ?? null,
    scheduleHour: r.schedule_hour,
    scheduleMinute: r.schedule_minute,
    scheduleDays: r.schedule_days ?? null,
    scheduleIntervalMs: r.schedule_interval_ms
      ? Number(r.schedule_interval_ms)
      : null,
    timezone: r.timezone,
    enabled: r.enabled,
    lastRunAt: r.last_run_at ? new Date(r.last_run_at).getTime() : null,
    nextRunAt: r.next_run_at ? new Date(r.next_run_at).getTime() : null,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  };
}
