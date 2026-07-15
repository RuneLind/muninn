import { test, expect, describe, mock, beforeEach } from "bun:test";
import type { ScheduledTask, Memory, Goal } from "../types.ts";

const mockSearchMemoriesHybrid = mock((..._args: any[]) => Promise.resolve([] as Memory[]));
const mockGenerateEmbedding = mock((..._args: any[]) => Promise.resolve([0.1, 0.2, 0.3] as number[] | null));
const mockGetActiveGoals = mock(() => Promise.resolve([] as Goal[]));
const mockGetScheduledTasksForUser = mock(() => Promise.resolve([] as ScheduledTask[]));
const mockGetRecentAlerts = mock(() => Promise.resolve([] as any[]));

mock.module("../db/memories.ts", () => ({
  searchMemories: mock(() => Promise.resolve([])),
  searchMemoriesHybrid: mockSearchMemoriesHybrid,
  saveMemory: mock(() => Promise.resolve("mem-1")),
  updateMemoryEmbedding: mock(() => Promise.resolve()),
  getRecentMemories: mock(() => Promise.resolve([])),
  getMemoriesWithoutEmbeddings: mock(() => Promise.resolve([])),
}));

mock.module("../ai/embeddings.ts", () => ({
  generateEmbedding: mockGenerateEmbedding,
  warmupEmbeddings: mock(() => Promise.resolve()),
}));

mock.module("../db/goals.ts", () => ({
  saveGoal: mock(() => Promise.resolve("g-1")),
  getActiveGoals: mockGetActiveGoals,
  getGoalById: mock(() => Promise.resolve(null)),
  updateGoalStatus: mock(() => Promise.resolve()),
  getGoalsNeedingReminder: mock(() => Promise.resolve([])),
  getGoalsNeedingCheckin: mock(() => Promise.resolve([])),
  updateGoalReminderSentAt: mock(() => Promise.resolve()),
  updateGoalCheckedAt: mock(() => Promise.resolve()),
  getAllGoals: mock(() => Promise.resolve([])),
}));

mock.module("../db/scheduled-tasks.ts", () => ({
  getScheduledTasksForUser: mockGetScheduledTasksForUser,
  saveScheduledTask: mock(() => Promise.resolve("task-1")),
  getTasksDueNow: mock(() => Promise.resolve([])),
  updateTaskLastRun: mock(() => Promise.resolve()),
  getAllScheduledTasks: mock(() => Promise.resolve([])),
  disableTask: mock(() => Promise.resolve()),
  enableTask: mock(() => Promise.resolve()),
  deleteTask: mock(() => Promise.resolve()),
  findSimilarTask: mock(() => Promise.resolve(null)),
  updateTaskPrompt: mock(() => Promise.resolve()),
  computeNextRun: mock(() => new Date()),
}));

mock.module("../db/messages.ts", () => ({
  getRecentAlerts: mockGetRecentAlerts,
  getRecentMessages: mock(() => Promise.resolve([])),
  saveMessage: mock(() => Promise.resolve("msg-1")),
}));

const { buildBriefingPrompt } = await import("./briefing-prompt.ts");

const baseTask: ScheduledTask = {
  id: "task-1",
  userId: "u1",
  botName: "jarvis",
  title: "Morning Tech Briefing",
  taskType: "briefing",
  prompt: "Search for the latest tech news and summarize them",
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
};

const persona = "You are Jarvis, a personal AI assistant.";

beforeEach(() => {
  mockSearchMemoriesHybrid.mockClear();
  mockGenerateEmbedding.mockClear();
  mockGetActiveGoals.mockClear();
  mockGetScheduledTasksForUser.mockClear();
  mockGetRecentAlerts.mockClear();
});

describe("buildBriefingPrompt", () => {
  test("includes persona in system prompt", async () => {
    const { systemPrompt } = await buildBriefingPrompt(baseTask, persona, "jarvis");
    expect(systemPrompt).toContain("You are Jarvis, a personal AI assistant.");
  });

  test("includes tool instructions in system prompt", async () => {
    const { systemPrompt } = await buildBriefingPrompt(baseTask, persona, "jarvis");
    expect(systemPrompt).toContain("Du HAR tilgang til verktøy");
    expect(systemPrompt).toContain("get-current-time");
    expect(systemPrompt).toContain("WebSearch");
  });

  test("includes date and timezone context", async () => {
    const { systemPrompt } = await buildBriefingPrompt(baseTask, persona, "jarvis");
    expect(systemPrompt).toContain("Europe/Oslo");
    expect(systemPrompt).toContain("morning-briefing");
  });

  test("includes formatting instructions", async () => {
    const { systemPrompt } = await buildBriefingPrompt(baseTask, persona, "jarvis");
    expect(systemPrompt).toContain("markdown");
  });

  test("uses task prompt as user prompt", async () => {
    const { userPrompt } = await buildBriefingPrompt(baseTask, persona, "jarvis");
    expect(userPrompt).toBe("Search for the latest tech news and summarize them");
  });

  test("generates default user prompt when task has no prompt", async () => {
    const taskNoPrompt = { ...baseTask, prompt: null };
    const { userPrompt } = await buildBriefingPrompt(taskNoPrompt, persona, "jarvis");
    expect(userPrompt).toContain("morning briefing");
  });

  test("includes memories when available", async () => {
    const memories: Memory[] = [
      {
        id: "m1",
        userId: "u1",
        content: "User prefers TypeScript",
        summary: "User prefers TypeScript",
        tags: ["preferences"],
        scope: "personal",
        createdAt: Date.now(),
      },
    ];
    mockSearchMemoriesHybrid.mockResolvedValueOnce(memories);

    const { systemPrompt, meta } = await buildBriefingPrompt(baseTask, persona, "jarvis");
    expect(systemPrompt).toContain("User prefers TypeScript");
    expect(meta.memoriesCount).toBe(1);
  });

  test("includes goals when available", async () => {
    const goals: Goal[] = [
      {
        id: "g1",
        userId: "u1",
        botName: "jarvis",
        title: "Learn Rust",
        description: null,
        status: "active",
        deadline: Date.now() + 86400000,
        tags: ["learning"],
        sourceMessageId: null,
        lastCheckedAt: null,
        reminderSentAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
    mockGetActiveGoals.mockResolvedValueOnce(goals);

    const { systemPrompt, meta } = await buildBriefingPrompt(baseTask, persona, "jarvis");
    expect(systemPrompt).toContain("Learn Rust");
    expect(systemPrompt).toContain("active goals");
    expect(meta.goalsCount).toBe(1);
  });

  test("includes scheduled tasks in context", async () => {
    const tasks: ScheduledTask[] = [baseTask];
    mockGetScheduledTasksForUser.mockResolvedValueOnce(tasks);

    const { systemPrompt, meta } = await buildBriefingPrompt(baseTask, persona, "jarvis");
    expect(systemPrompt).toContain("Morning Tech Briefing");
    expect(systemPrompt).toContain("scheduled tasks");
    expect(meta.scheduledTasksCount).toBe(1);
  });

  test("includes alerts in context", async () => {
    mockGetRecentAlerts.mockResolvedValueOnce([
      { source: "watcher:email", content: "New email from boss", timestamp: Date.now() },
    ]);

    const { systemPrompt, meta } = await buildBriefingPrompt(baseTask, persona, "jarvis");
    expect(systemPrompt).toContain("email");
    expect(systemPrompt).toContain("New email from boss");
    expect(meta.alertsCount).toBe(1);
  });

  test("handles DB errors gracefully", async () => {
    mockSearchMemoriesHybrid.mockRejectedValueOnce(new Error("DB down"));
    mockGetActiveGoals.mockRejectedValueOnce(new Error("DB down"));
    mockGetScheduledTasksForUser.mockRejectedValueOnce(new Error("DB down"));
    mockGetRecentAlerts.mockRejectedValueOnce(new Error("DB down"));

    const { systemPrompt, meta } = await buildBriefingPrompt(baseTask, persona, "jarvis");
    // Should still include persona and tool instructions
    expect(systemPrompt).toContain("You are Jarvis");
    expect(systemPrompt).toContain("Du HAR tilgang til verktøy");
    expect(meta.memoriesCount).toBe(0);
    expect(meta.goalsCount).toBe(0);
  });

  test("searches memories via hybrid search with the generated embedding", async () => {
    await buildBriefingPrompt(baseTask, persona, "jarvis");

    // Embedding is generated from the same title + prompt query
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
    const [embedQuery] = mockGenerateEmbedding.mock.calls[0] as any[];
    expect(embedQuery).toContain("Morning Tech Briefing");
    expect(embedQuery).toContain("Search for the latest tech news");

    // Hybrid search receives that embedding and query
    expect(mockSearchMemoriesHybrid).toHaveBeenCalledTimes(1);
    const [userId, query, embedding, limit, botName] =
      mockSearchMemoriesHybrid.mock.calls[0] as any[];
    expect(userId).toBe("u1");
    expect(query).toContain("Morning Tech Briefing");
    expect(query).toContain("Search for the latest tech news");
    expect(embedding).toEqual([0.1, 0.2, 0.3]);
    expect(limit).toBe(8);
    expect(botName).toBe("jarvis");
  });

  test("query no longer carries the FTS keyword suffix", async () => {
    await buildBriefingPrompt(baseTask, persona, "jarvis");
    const [, query] = mockSearchMemoriesHybrid.mock.calls[0] as any[];
    expect(query).not.toContain("preferences schedule daily");
  });

  test("still returns memories when embedding generation fails (null)", async () => {
    mockGenerateEmbedding.mockResolvedValueOnce(null);
    const memories: Memory[] = [
      {
        id: "m1",
        userId: "u1",
        content: "User prefers TypeScript",
        summary: "User prefers TypeScript",
        tags: ["preferences"],
        scope: "personal",
        createdAt: Date.now(),
      },
    ];
    // searchMemoriesHybrid delegates to FTS internally on null embedding; here we
    // only assert the briefing call site passes null through and surfaces results.
    mockSearchMemoriesHybrid.mockResolvedValueOnce(memories);

    const { systemPrompt, meta } = await buildBriefingPrompt(baseTask, persona, "jarvis");
    const [, , embedding] = mockSearchMemoriesHybrid.mock.calls[0] as any[];
    expect(embedding).toBeNull();
    expect(systemPrompt).toContain("User prefers TypeScript");
    expect(meta.memoriesCount).toBe(1);
  });

  test("returns correct time of day for evening", async () => {
    const eveningTask = { ...baseTask, scheduleHour: 20 };
    const { systemPrompt, userPrompt } = await buildBriefingPrompt(
      { ...eveningTask, prompt: null },
      persona,
      "jarvis",
    );
    expect(systemPrompt).toContain("evening");
    expect(userPrompt).toContain("evening briefing");
  });

  test("meta includes buildMs timing", async () => {
    const { meta } = await buildBriefingPrompt(baseTask, persona, "jarvis");
    expect(meta.buildMs).toBeGreaterThanOrEqual(0);
  });
});
