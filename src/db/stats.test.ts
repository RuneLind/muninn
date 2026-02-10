import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { makeMessage, makeMemory, makeGoal, makeScheduledTask, makeWatcher } from "../test/fixtures.ts";
import { saveMessage } from "./messages.ts";
import { saveMemory } from "./memories.ts";
import { saveGoal, updateGoalStatus } from "./goals.ts";
import { saveScheduledTask } from "./scheduled-tasks.ts";
import { getDashboardStats } from "./stats.ts";

setupTestDb();

describe("stats", () => {
  test("getDashboardStats returns zeros for empty DB", async () => {
    const stats = await getDashboardStats();
    expect(stats.totalMessages).toBe(0);
    expect(stats.messagesToday).toBe(0);
    expect(stats.memoriesCount).toBe(0);
    expect(stats.activeGoalsCount).toBe(0);
    expect(stats.completedGoalsCount).toBe(0);
    expect(stats.scheduledTasksCount).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.tokensToday).toBe(0);
    expect(stats.avgResponseMs).toBe(0);
  });

  test("getDashboardStats counts messages", async () => {
    await saveMessage(makeMessage({ content: "msg 1" }));
    await saveMessage(makeMessage({ content: "msg 2" }));

    const stats = await getDashboardStats();
    expect(stats.totalMessages).toBe(2);
    expect(stats.messagesToday).toBe(2);
  });

  test("getDashboardStats counts tokens", async () => {
    await saveMessage(makeMessage({ inputTokens: 100, outputTokens: 50, role: "assistant" }));

    const stats = await getDashboardStats();
    expect(stats.totalTokens).toBeGreaterThanOrEqual(150);
    expect(stats.tokensToday).toBeGreaterThanOrEqual(150);
  });

  test("getDashboardStats counts memories", async () => {
    await saveMemory(makeMemory());
    await saveMemory(makeMemory());

    const stats = await getDashboardStats();
    expect(stats.memoriesCount).toBe(2);
  });

  test("getDashboardStats counts goals by status", async () => {
    await saveGoal(makeGoal({ title: "active goal 1" }));
    await saveGoal(makeGoal({ title: "active goal 2" }));
    const id3 = await saveGoal(makeGoal({ title: "completed goal" }));
    await updateGoalStatus(id3, "completed");

    const stats = await getDashboardStats();
    expect(stats.activeGoalsCount).toBe(2);
    expect(stats.completedGoalsCount).toBe(1);
  });

  test("getDashboardStats counts scheduled tasks", async () => {
    await saveScheduledTask(makeScheduledTask());

    const stats = await getDashboardStats();
    expect(stats.scheduledTasksCount).toBe(1);
  });

  test("getDashboardStats calculates avg response time", async () => {
    await saveMessage(makeMessage({ role: "assistant", durationMs: 1000 }));
    await saveMessage(makeMessage({ role: "assistant", durationMs: 2000 }));

    const stats = await getDashboardStats();
    expect(stats.avgResponseMs).toBe(1500);
  });

  test("getDashboardStats includes messagesByDay array", async () => {
    const stats = await getDashboardStats();
    expect(stats.messagesByDay).toBeArray();
    expect(stats.messagesByDay.length).toBe(7);
    expect(stats.messagesByDay[0]!).toHaveProperty("date");
    expect(stats.messagesByDay[0]!).toHaveProperty("count");
  });

  test("getDashboardStats includes tokensByDay array", async () => {
    const stats = await getDashboardStats();
    expect(stats.tokensByDay).toBeArray();
    expect(stats.tokensByDay.length).toBe(7);
    expect(stats.tokensByDay[0]!).toHaveProperty("date");
    expect(stats.tokensByDay[0]!).toHaveProperty("mainTokens");
    expect(stats.tokensByDay[0]!).toHaveProperty("haikuTokens");
  });

  test("getDashboardStats filters by botName", async () => {
    await saveMessage(makeMessage({ botName: "bot1", content: "bot1 msg" }));
    await saveMessage(makeMessage({ botName: "bot2", content: "bot2 msg" }));

    const stats = await getDashboardStats("bot1");
    expect(stats.totalMessages).toBe(1);
  });
});
