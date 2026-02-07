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

export async function getAllScheduledTasks(): Promise<ScheduledTask[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM scheduled_tasks
    ORDER BY enabled DESC, schedule_hour, schedule_minute
  `;
  return rows.map(mapRow);
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
  // Get current date parts in the task's timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((p) => [p.type, p.value]),
  );
  const nowHour = Number(parts.hour);
  const nowMinute = Number(parts.minute);

  // Start with today's date in the target timezone
  let year = Number(parts.year);
  let month = Number(parts.month);
  let day = Number(parts.day);

  // If the target time already passed today, move to tomorrow
  if (nowHour > hour || (nowHour === hour && nowMinute >= minute)) {
    const tmp = new Date(year, month - 1, day + 1);
    year = tmp.getFullYear();
    month = tmp.getMonth() + 1;
    day = tmp.getDate();
  }

  // If days filter is set, find the next matching day
  if (days && days.length > 0) {
    for (let i = 0; i < 7; i++) {
      const tmp = new Date(year, month - 1, day);
      if (days.includes(tmp.getDay())) break;
      const next = new Date(year, month - 1, day + 1);
      year = next.getFullYear();
      month = next.getMonth() + 1;
      day = next.getDate();
    }
  }

  // Build an ISO-like string and parse it as the target timezone
  // Format: "YYYY-MM-DDTHH:MM:00" interpreted in the given timezone
  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;

  // Use a reliable method: compute UTC offset for the target date/timezone
  // by comparing the formatted date in UTC vs the target timezone
  const candidateApprox = new Date(dateStr + "Z"); // treat as UTC initially
  const utcStr = candidateApprox.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = candidateApprox.toLocaleString("en-US", { timeZone: timezone });
  const offsetMs = new Date(utcStr).getTime() - new Date(tzStr).getTime();

  return new Date(candidateApprox.getTime() + offsetMs);
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
