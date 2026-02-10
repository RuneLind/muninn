import { test, expect, describe, mock } from "bun:test";

// Mock all DB dependencies
mock.module("../db/messages.ts", () => ({
  saveMessage: mock(() => Promise.resolve("msg-1")),
  getRecentMessages: mock(() => Promise.resolve([
    { id: "m1", role: "user", text: "previous question", timestamp: Date.now() - 60000, userId: "u1" },
    { id: "m2", role: "assistant", text: "previous answer", timestamp: Date.now() - 30000, userId: "u1" },
  ])),
  getRecentAlerts: mock(() => Promise.resolve([])),
}));

mock.module("../db/memories.ts", () => ({
  saveMemory: mock(() => Promise.resolve("mem-1")),
  searchMemories: mock(() => Promise.resolve([])),
  searchMemoriesHybrid: mock(() => Promise.resolve([
    {
      id: "mem1",
      userId: "u1",
      content: "User likes TypeScript",
      summary: "Prefers TypeScript over JavaScript",
      tags: ["preferences", "languages"],
      scope: "personal",
      createdAt: Date.now(),
    },
  ])),
  updateMemoryEmbedding: mock(() => Promise.resolve()),
  getRecentMemories: mock(() => Promise.resolve([])),
  getMemoriesWithoutEmbeddings: mock(() => Promise.resolve([])),
}));

mock.module("../db/goals.ts", () => ({
  saveGoal: mock(() => Promise.resolve("g-1")),
  getActiveGoals: mock(() => Promise.resolve([
    {
      id: "g1",
      userId: "u1",
      botName: "testbot",
      title: "Learn Rust",
      description: null,
      status: "active",
      deadline: null,
      tags: ["learning"],
      sourceMessageId: null,
      lastCheckedAt: null,
      reminderSentAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ])),
  getGoalById: mock(() => Promise.resolve(null)),
  updateGoalStatus: mock(() => Promise.resolve()),
  updateGoalCheckedAt: mock(() => Promise.resolve()),
  updateGoalReminderSentAt: mock(() => Promise.resolve()),
  getGoalsNeedingReminder: mock(() => Promise.resolve([])),
  getGoalsNeedingCheckin: mock(() => Promise.resolve([])),
  getAllGoals: mock(() => Promise.resolve([])),
}));

mock.module("../db/scheduled-tasks.ts", () => ({
  saveScheduledTask: mock(() => Promise.resolve("t-1")),
  getScheduledTasksForUser: mock(() => Promise.resolve([
    {
      id: "t1",
      userId: "u1",
      botName: "testbot",
      title: "Morning briefing",
      taskType: "briefing",
      prompt: null,
      scheduleHour: 8,
      scheduleMinute: 0,
      scheduleDays: [1, 2, 3, 4, 5],
      scheduleIntervalMs: null,
      timezone: "Europe/Oslo",
      enabled: true,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ])),
  getTasksDueNow: mock(() => Promise.resolve([])),
  updateTaskLastRun: mock(() => Promise.resolve()),
  getAllScheduledTasks: mock(() => Promise.resolve([])),
  disableTask: mock(() => Promise.resolve()),
  enableTask: mock(() => Promise.resolve()),
  deleteTask: mock(() => Promise.resolve()),
  computeNextRun: mock(() => new Date()),
}));

mock.module("./embeddings.ts", () => ({
  generateEmbedding: mock(() => Promise.resolve(Array.from({ length: 384 }, () => 0.1))),
}));

const { buildPrompt } = await import("./prompt-builder.ts");

describe("buildPrompt", () => {
  test("includes persona in system prompt", async () => {
    const result = await buildPrompt("u1", "hello", "You are Jarvis, a helpful assistant.", "testbot");
    expect(result.systemPrompt).toContain("You are Jarvis, a helpful assistant.");
  });

  test("includes memories in system prompt", async () => {
    const result = await buildPrompt("u1", "hello", "persona", "testbot");
    expect(result.systemPrompt).toContain("Prefers TypeScript over JavaScript");
  });

  test("includes goals in system prompt", async () => {
    const result = await buildPrompt("u1", "hello", "persona", "testbot");
    expect(result.systemPrompt).toContain("Learn Rust");
  });

  test("includes scheduled tasks in system prompt", async () => {
    const result = await buildPrompt("u1", "hello", "persona", "testbot");
    expect(result.systemPrompt).toContain("Morning briefing");
  });

  test("includes conversation history in user prompt", async () => {
    const result = await buildPrompt("u1", "new question", "persona", "testbot");
    expect(result.userPrompt).toContain("previous question");
    expect(result.userPrompt).toContain("previous answer");
  });

  test("includes current message in user prompt", async () => {
    const result = await buildPrompt("u1", "new question", "persona", "testbot");
    expect(result.userPrompt).toContain("new question");
  });

  test("returns metadata", async () => {
    const result = await buildPrompt("u1", "hello", "persona", "testbot");
    expect(result.meta.messagesCount).toBeGreaterThan(0);
    expect(result.meta.memoriesCount).toBeGreaterThan(0);
    expect(result.meta.goalsCount).toBeGreaterThan(0);
    expect(result.meta.scheduledTasksCount).toBeGreaterThan(0);
    expect(result.meta.dbHistoryMs).toBeGreaterThanOrEqual(0);
    expect(result.meta.embeddingMs).toBeGreaterThanOrEqual(0);
    expect(result.meta.memorySearchMs).toBeGreaterThanOrEqual(0);
  });

  test("includes tool restriction prompt when restricted", async () => {
    const restrictedTools = {
      Gmail: { description: "Email access", allowedUsers: ["other-user"] },
    };
    const result = await buildPrompt("u1", "hello", "persona", "testbot", restrictedTools);
    expect(result.systemPrompt).toContain("Verktøyrestriksjoner");
    expect(result.systemPrompt).toContain("Gmail");
  });

  test("does not include restriction prompt when user is allowed", async () => {
    const restrictedTools = {
      Gmail: { description: "Email access", allowedUsers: ["u1"] },
    };
    const result = await buildPrompt("u1", "hello", "persona", "testbot", restrictedTools);
    expect(result.systemPrompt).not.toContain("Verktøyrestriksjoner");
  });
});
