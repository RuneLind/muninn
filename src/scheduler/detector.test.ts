import { test, expect, describe, mock, beforeEach } from "bun:test";

const mockSpawnHaiku = mock(() => Promise.resolve({
  result: '{"has_schedule": false}',
  inputTokens: 50,
  outputTokens: 20,
  model: "claude-haiku-4-5-20251001",
}));

const mockSaveScheduledTask = mock(() => Promise.resolve("task-1"));

mock.module("./executor.ts", () => ({
  spawnHaiku: mockSpawnHaiku,
  callHaiku: mock(() => Promise.resolve("")),
}));

mock.module("../db/scheduled-tasks.ts", () => ({
  saveScheduledTask: mockSaveScheduledTask,
  getScheduledTasksForUser: mock(() => Promise.resolve([])),
  getTasksDueNow: mock(() => Promise.resolve([])),
  updateTaskLastRun: mock(() => Promise.resolve()),
  getAllScheduledTasks: mock(() => Promise.resolve([])),
  disableTask: mock(() => Promise.resolve()),
  enableTask: mock(() => Promise.resolve()),
  deleteTask: mock(() => Promise.resolve()),
  computeNextRun: mock(() => new Date()),
}));

const { extractScheduleAsync } = await import("./detector.ts");

const config = { databaseUrl: "test" } as any;

beforeEach(() => {
  mockSpawnHaiku.mockClear();
  mockSaveScheduledTask.mockClear();
});

describe("extractScheduleAsync", () => {
  test("calls spawnHaiku with detection prompt", async () => {
    mockSpawnHaiku.mockResolvedValueOnce({
      result: '{"has_schedule": false}',
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractScheduleAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "remind me every morning at 8",
      assistantResponse: "I'll set that up!",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSpawnHaiku).toHaveBeenCalledTimes(1);
    const prompt = (mockSpawnHaiku.mock.calls[0] as any[])[0] as string;
    expect(prompt).toContain("remind me every morning at 8");
    expect(prompt).toContain("I'll set that up!");
  });

  test("saves task when schedule detected", async () => {
    mockSpawnHaiku.mockResolvedValueOnce({
      result: JSON.stringify({
        has_schedule: true,
        title: "Morning briefing",
        task_type: "briefing",
        hour: 8,
        minute: 0,
        days: [1, 2, 3, 4, 5],
        prompt: "Summarize goals and calendar",
        timezone: "Europe/Oslo",
      }),
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractScheduleAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "give me a morning briefing on weekdays",
      assistantResponse: "Done!",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSaveScheduledTask).toHaveBeenCalledTimes(1);
    const saveCall = (mockSaveScheduledTask.mock.calls[0] as any[])[0];
    expect(saveCall.userId).toBe("u1");
    expect(saveCall.botName).toBe("testbot");
    expect(saveCall.title).toBe("Morning briefing");
    expect(saveCall.taskType).toBe("briefing");
    expect(saveCall.scheduleHour).toBe(8);
    expect(saveCall.scheduleDays).toEqual([1, 2, 3, 4, 5]);
  });

  test("does not save when no schedule detected", async () => {
    mockSpawnHaiku.mockResolvedValueOnce({
      result: '{"has_schedule": false}',
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractScheduleAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "what time is it?",
      assistantResponse: "It's 3pm.",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSaveScheduledTask).not.toHaveBeenCalled();
  });

  test("saves interval-style task", async () => {
    mockSpawnHaiku.mockResolvedValueOnce({
      result: JSON.stringify({
        has_schedule: true,
        title: "Stretch reminder",
        task_type: "reminder",
        hour: 9,
        minute: 0,
        interval_ms: 7200000,
      }),
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractScheduleAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "remind me to stretch every 2 hours",
      assistantResponse: "Will do!",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSaveScheduledTask).toHaveBeenCalledTimes(1);
    const saveCall = (mockSaveScheduledTask.mock.calls[0] as any[])[0];
    expect(saveCall.scheduleIntervalMs).toBe(7200000);
  });

  test("handles markdown-wrapped JSON", async () => {
    mockSpawnHaiku.mockResolvedValueOnce({
      result: '```json\n{"has_schedule": true, "title": "Test", "task_type": "reminder", "hour": 9}\n```',
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractScheduleAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "test",
      assistantResponse: "test",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSaveScheduledTask).toHaveBeenCalledTimes(1);
  });

  test("handles invalid JSON gracefully", async () => {
    mockSpawnHaiku.mockResolvedValueOnce({
      result: "invalid json",
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractScheduleAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "test",
      assistantResponse: "test",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSaveScheduledTask).not.toHaveBeenCalled();
  });

  test("defaults task_type to reminder", async () => {
    mockSpawnHaiku.mockResolvedValueOnce({
      result: JSON.stringify({
        has_schedule: true,
        title: "No type specified",
        hour: 10,
      }),
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractScheduleAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "test",
      assistantResponse: "test",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSaveScheduledTask).toHaveBeenCalledTimes(1);
    const saveCall = (mockSaveScheduledTask.mock.calls[0] as any[])[0];
    expect(saveCall.taskType).toBe("reminder");
  });
});
