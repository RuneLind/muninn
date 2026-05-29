import { test, expect, describe, mock, beforeEach } from "bun:test";

const mockCallHaiku = mock(() => Promise.resolve({
  result: '{"has_schedule": false}',
  inputTokens: 50,
  outputTokens: 20,
  model: "claude-haiku-4-5-20251001",
}));

const mockSaveScheduledTask = mock(() => Promise.resolve("task-1"));
const mockFindSimilarTask = mock(() => Promise.resolve(null as any));
const mockUpdateTaskPrompt = mock(() => Promise.resolve());
const mockUpdateScheduledTask = mock(() => Promise.resolve(null as any));

mock.module("../ai/haiku-direct.ts", () => ({
  callHaikuWithFallback: mockCallHaiku,
}));

mock.module("../db/scheduled-tasks.ts", () => ({
  saveScheduledTask: mockSaveScheduledTask,
  findSimilarTask: mockFindSimilarTask,
  updateTaskPrompt: mockUpdateTaskPrompt,
  updateScheduledTask: mockUpdateScheduledTask,
  getScheduledTasksForUser: mock(() => Promise.resolve([])),
  getTasksDueNow: mock(() => Promise.resolve([])),
  updateTaskLastRun: mock(() => Promise.resolve()),
  getAllScheduledTasks: mock(() => Promise.resolve([])),
  disableTask: mock(() => Promise.resolve()),
  enableTask: mock(() => Promise.resolve()),
  deleteTask: mock(() => Promise.resolve()),
  computeNextRun: mock(() => new Date()),
}));

const { extractScheduleAsync, diffScheduleFields } = await import("./detector.ts");

const config = { databaseUrl: "test" } as any;

beforeEach(() => {
  mockCallHaiku.mockClear();
  mockSaveScheduledTask.mockClear();
  mockFindSimilarTask.mockClear();
  mockUpdateTaskPrompt.mockClear();
  mockUpdateScheduledTask.mockClear();
});

const existingTask = (over: Record<string, any> = {}) => ({
  id: "existing-1",
  userId: "u1",
  botName: "testbot",
  title: "Morning briefing",
  taskType: "briefing",
  prompt: "Summarize goals",
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
  ...over,
});

describe("diffScheduleFields", () => {
  test("returns empty object when nothing changed", () => {
    expect(
      diffScheduleFields(
        { scheduleHour: 8, scheduleMinute: 0, scheduleDays: [1, 2], scheduleIntervalMs: null },
        { hour: 8, minute: 0, days: [1, 2], interval_ms: undefined },
      ),
    ).toEqual({});
  });

  test("detects an hour change", () => {
    expect(
      diffScheduleFields(
        { scheduleHour: 8, scheduleMinute: 0, scheduleDays: null, scheduleIntervalMs: null },
        { hour: 9 },
      ),
    ).toEqual({ scheduleHour: 9 });
  });

  test("detects a minute change when restated", () => {
    expect(
      diffScheduleFields(
        { scheduleHour: 8, scheduleMinute: 30, scheduleDays: null, scheduleIntervalMs: null },
        { hour: 8, minute: 0 },
      ),
    ).toEqual({ scheduleMinute: 0 });
  });

  test("omitted minute is left unchanged (no opinion)", () => {
    expect(
      diffScheduleFields(
        { scheduleHour: 8, scheduleMinute: 30, scheduleDays: null, scheduleIntervalMs: null },
        { hour: 8 },
      ),
    ).toEqual({});
  });

  test("omitted days does not clobber existing days", () => {
    expect(
      diffScheduleFields(
        { scheduleHour: 8, scheduleMinute: 0, scheduleDays: [1, 2, 3, 4, 5], scheduleIntervalMs: null },
        { hour: 8, minute: 0 },
      ),
    ).toEqual({});
  });

  test("detects a days change", () => {
    expect(
      diffScheduleFields(
        { scheduleHour: 8, scheduleMinute: 0, scheduleDays: [1, 2, 3, 4, 5], scheduleIntervalMs: null },
        { hour: 8, minute: 0, days: [6, 0] },
      ),
    ).toEqual({ scheduleDays: [6, 0] });
  });

  test("days unchanged when same order", () => {
    expect(
      diffScheduleFields(
        { scheduleHour: 8, scheduleMinute: 0, scheduleDays: [1, 2, 3], scheduleIntervalMs: null },
        { hour: 8, minute: 0, days: [1, 2, 3] },
      ),
    ).toEqual({});
  });

  test("detects an interval change", () => {
    expect(
      diffScheduleFields(
        { scheduleHour: 9, scheduleMinute: 0, scheduleDays: null, scheduleIntervalMs: 7200000 },
        { hour: 9, minute: 0, interval_ms: 3600000 },
      ),
    ).toEqual({ scheduleIntervalMs: 3600000 });
  });

  test("hour omitted in result is left unchanged", () => {
    expect(
      diffScheduleFields(
        { scheduleHour: 8, scheduleMinute: 0, scheduleDays: null, scheduleIntervalMs: null },
        { minute: 0 },
      ),
    ).toEqual({});
  });
});

describe("extractScheduleAsync", () => {
  test("calls Haiku with detection prompt", async () => {
    mockCallHaiku.mockResolvedValueOnce({
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

    expect(mockCallHaiku).toHaveBeenCalledTimes(1);
    const prompt = (mockCallHaiku.mock.calls[0] as any[])[0] as string;
    expect(prompt).toContain("remind me every morning at 8");
    expect(prompt).toContain("I'll set that up!");
  });

  test("saves task when schedule detected", async () => {
    mockCallHaiku.mockResolvedValueOnce({
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

    expect(mockFindSimilarTask).toHaveBeenCalledWith("u1", "testbot", "Morning briefing", "briefing");
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
    mockCallHaiku.mockResolvedValueOnce({
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
    mockCallHaiku.mockResolvedValueOnce({
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
    mockCallHaiku.mockResolvedValueOnce({
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
    mockCallHaiku.mockResolvedValueOnce({
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
    mockCallHaiku.mockResolvedValueOnce({
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

  test("skips duplicate task with same prompt", async () => {
    mockFindSimilarTask.mockResolvedValueOnce({
      id: "existing-1",
      userId: "u1",
      botName: "testbot",
      title: "Morning briefing",
      taskType: "briefing",
      prompt: "Summarize goals",
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
    });

    mockCallHaiku.mockResolvedValueOnce({
      result: JSON.stringify({
        has_schedule: true,
        title: "Morning briefing",
        task_type: "briefing",
        hour: 8,
        minute: 0,
        prompt: "Summarize goals",
      }),
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractScheduleAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "give me a morning briefing",
      assistantResponse: "Done!",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockFindSimilarTask).toHaveBeenCalledTimes(1);
    expect(mockSaveScheduledTask).not.toHaveBeenCalled();
    expect(mockUpdateTaskPrompt).not.toHaveBeenCalled();
    expect(mockUpdateScheduledTask).not.toHaveBeenCalled();
  });

  test("reschedules via updateScheduledTask when duplicate schedule changed", async () => {
    mockFindSimilarTask.mockResolvedValueOnce(existingTask() as any);

    mockCallHaiku.mockResolvedValueOnce({
      result: JSON.stringify({
        has_schedule: true,
        title: "Morning briefing",
        task_type: "briefing",
        hour: 9, // moved from 8 → 9
        minute: 0,
        days: [1, 2, 3, 4, 5],
        prompt: "Summarize goals",
      }),
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractScheduleAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "move my morning briefing to 9",
      assistantResponse: "Moved!",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    // Schedule changed but prompt did not — updateScheduledTask carries the new
    // hour and recomputes next_run_at; the prompt-only path is NOT taken.
    expect(mockUpdateScheduledTask).toHaveBeenCalledTimes(1);
    const [id, data] = mockUpdateScheduledTask.mock.calls[0] as any[];
    expect(id).toBe("existing-1");
    expect(data.scheduleHour).toBe(9);
    expect(data.prompt).toBeUndefined();
    expect(mockUpdateTaskPrompt).not.toHaveBeenCalled();
    expect(mockSaveScheduledTask).not.toHaveBeenCalled();
  });

  test("reschedules and updates prompt when both changed", async () => {
    mockFindSimilarTask.mockResolvedValueOnce(existingTask({ prompt: "Old prompt" }) as any);

    mockCallHaiku.mockResolvedValueOnce({
      result: JSON.stringify({
        has_schedule: true,
        title: "Morning briefing",
        task_type: "briefing",
        hour: 7,
        minute: 30,
        days: [1, 2, 3, 4, 5],
        prompt: "New prompt with news",
      }),
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractScheduleAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "move it to 7:30 and add news",
      assistantResponse: "Done!",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockUpdateScheduledTask).toHaveBeenCalledTimes(1);
    const [, data] = mockUpdateScheduledTask.mock.calls[0] as any[];
    expect(data.scheduleHour).toBe(7);
    expect(data.scheduleMinute).toBe(30);
    expect(data.prompt).toBe("New prompt with news");
    expect(mockUpdateTaskPrompt).not.toHaveBeenCalled();
  });

  test("updates prompt when duplicate has different prompt", async () => {
    mockFindSimilarTask.mockResolvedValueOnce({
      id: "existing-1",
      userId: "u1",
      botName: "testbot",
      title: "Morning briefing",
      taskType: "briefing",
      prompt: "Old prompt",
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
    });

    mockCallHaiku.mockResolvedValueOnce({
      result: JSON.stringify({
        has_schedule: true,
        title: "Morning briefing",
        task_type: "briefing",
        hour: 8,
        minute: 0,
        prompt: "New improved prompt with news",
      }),
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractScheduleAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "update my morning briefing to include news",
      assistantResponse: "Updated!",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockFindSimilarTask).toHaveBeenCalledTimes(1);
    expect(mockSaveScheduledTask).not.toHaveBeenCalled();
    expect(mockUpdateTaskPrompt).toHaveBeenCalledWith("existing-1", "New improved prompt with news");
    expect(mockUpdateScheduledTask).not.toHaveBeenCalled();
  });
});
