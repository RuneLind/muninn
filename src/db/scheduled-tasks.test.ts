import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { makeScheduledTask } from "../test/fixtures.ts";
import {
  saveScheduledTask,
  getScheduledTasksForUser,
  getTasksDueNow,
  updateTaskLastRun,
  getAllScheduledTasks,
  disableTask,
  enableTask,
  deleteTask,
  computeNextRun,
} from "./scheduled-tasks.ts";
import { getDb } from "./client.ts";

setupTestDb();

describe("scheduled-tasks", () => {
  test("saveScheduledTask returns an id", async () => {
    const id = await saveScheduledTask(makeScheduledTask());
    expect(id).toBeTruthy();
  });

  test("getScheduledTasksForUser returns enabled tasks", async () => {
    await saveScheduledTask(makeScheduledTask({ userId: "u1", botName: "bot1", title: "morning briefing" }));
    await saveScheduledTask(makeScheduledTask({ userId: "u1", botName: "bot1", title: "evening check" }));

    const tasks = await getScheduledTasksForUser("u1", "bot1");
    expect(tasks).toHaveLength(2);
  });

  test("getScheduledTasksForUser filters by userId", async () => {
    await saveScheduledTask(makeScheduledTask({ userId: "u1", botName: "bot1" }));
    await saveScheduledTask(makeScheduledTask({ userId: "u2", botName: "bot1" }));

    const tasks = await getScheduledTasksForUser("u1", "bot1");
    expect(tasks).toHaveLength(1);
  });

  test("getScheduledTasksForUser excludes disabled tasks", async () => {
    const id = await saveScheduledTask(makeScheduledTask({ userId: "u1", botName: "bot1" }));
    await disableTask(id);

    const tasks = await getScheduledTasksForUser("u1", "bot1");
    expect(tasks).toHaveLength(0);
  });

  test("disableTask and enableTask toggle enabled", async () => {
    const id = await saveScheduledTask(makeScheduledTask({ userId: "u1", botName: "bot1" }));

    await disableTask(id);
    let all = await getAllScheduledTasks("bot1");
    let task = all.find((t) => t.id === id);
    expect(task!.enabled).toBe(false);

    await enableTask(id);
    all = await getAllScheduledTasks("bot1");
    task = all.find((t) => t.id === id);
    expect(task!.enabled).toBe(true);
  });

  test("deleteTask removes the task", async () => {
    const id = await saveScheduledTask(makeScheduledTask({ userId: "u1", botName: "bot1" }));
    await deleteTask(id);

    const all = await getAllScheduledTasks("bot1");
    expect(all.find((t) => t.id === id)).toBeUndefined();
  });

  test("getTasksDueNow returns tasks with past next_run_at", async () => {
    const id = await saveScheduledTask(makeScheduledTask({
      userId: "u1",
      botName: "bot1",
      scheduleHour: 0,
      scheduleMinute: 0,
    }));

    // Force next_run_at to the past
    const sql = getDb();
    await sql`UPDATE scheduled_tasks SET next_run_at = now() - interval '1 hour' WHERE id = ${id}`;

    const due = await getTasksDueNow("bot1");
    expect(due.length).toBeGreaterThanOrEqual(1);
    expect(due.some((t) => t.id === id)).toBe(true);
  });

  test("getTasksDueNow excludes disabled tasks", async () => {
    const id = await saveScheduledTask(makeScheduledTask({ userId: "u1", botName: "bot1" }));
    const sql = getDb();
    await sql`UPDATE scheduled_tasks SET next_run_at = now() - interval '1 hour' WHERE id = ${id}`;
    await disableTask(id);

    const due = await getTasksDueNow("bot1");
    expect(due.find((t) => t.id === id)).toBeUndefined();
  });

  test("updateTaskLastRun updates last_run_at and next_run_at", async () => {
    const id = await saveScheduledTask(makeScheduledTask({ userId: "u1", botName: "bot1", scheduleHour: 10 }));

    const all = await getAllScheduledTasks("bot1");
    const task = all.find((t) => t.id === id)!;
    expect(task.lastRunAt).toBeNull();

    await updateTaskLastRun(task);

    const updated = await getAllScheduledTasks("bot1");
    const updatedTask = updated.find((t) => t.id === id)!;
    expect(updatedTask.lastRunAt).not.toBeNull();
    expect(updatedTask.nextRunAt).not.toBeNull();
  });

  test("getAllScheduledTasks sorts enabled first", async () => {
    const id1 = await saveScheduledTask(makeScheduledTask({ userId: "u1", botName: "bot1", title: "disabled" }));
    await disableTask(id1);
    await saveScheduledTask(makeScheduledTask({ userId: "u1", botName: "bot1", title: "enabled" }));

    const all = await getAllScheduledTasks("bot1");
    expect(all[0]!.enabled).toBe(true);
  });

  test("saveScheduledTask with interval_ms", async () => {
    const id = await saveScheduledTask(makeScheduledTask({
      userId: "u1",
      botName: "bot1",
      scheduleIntervalMs: 7200000, // 2 hours
    }));

    const all = await getAllScheduledTasks("bot1");
    const task = all.find((t) => t.id === id)!;
    expect(task.scheduleIntervalMs).toBe(7200000);
  });

  test("saveScheduledTask with scheduleDays", async () => {
    const id = await saveScheduledTask(makeScheduledTask({
      userId: "u1",
      botName: "bot1",
      scheduleDays: [1, 2, 3, 4, 5], // Mon-Fri
    }));

    const all = await getAllScheduledTasks("bot1");
    const task = all.find((t) => t.id === id)!;
    expect(task.scheduleDays).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("computeNextRun", () => {
  test("interval-style returns now + interval", () => {
    const task = {
      id: "test",
      userId: "u1",
      botName: "bot1",
      title: "test",
      taskType: "reminder" as const,
      prompt: null,
      scheduleHour: 8,
      scheduleMinute: 0,
      scheduleDays: null,
      scheduleIntervalMs: 3600000,
      timezone: "Europe/Oslo",
      enabled: true,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const next = computeNextRun(task);
    const diff = next.getTime() - Date.now();
    // Should be approximately 1 hour from now
    expect(diff).toBeGreaterThan(3500000);
    expect(diff).toBeLessThan(3700000);
  });

  test("cron-style returns a future date", () => {
    const task = {
      id: "test",
      userId: "u1",
      botName: "bot1",
      title: "test",
      taskType: "briefing" as const,
      prompt: null,
      scheduleHour: 8,
      scheduleMinute: 30,
      scheduleDays: null,
      scheduleIntervalMs: null,
      timezone: "Europe/Oslo",
      enabled: true,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const next = computeNextRun(task);
    // Should be in the future (either today or tomorrow at 08:30 Oslo time)
    expect(next.getTime()).toBeGreaterThan(Date.now() - 60000);
  });
});
