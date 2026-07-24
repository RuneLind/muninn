import { test, expect, describe, mock } from "bun:test";

// Mock all DB dependencies
mock.module("../db/messages.ts", () => ({
  saveMessage: mock(() => Promise.resolve("msg-1")),
  getRecentMessages: mock(() => Promise.resolve([
    { id: "m1", role: "user", text: "previous question", timestamp: Date.now() - 60000, userId: "u1", username: "Rune" },
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
  findSimilarTask: mock(() => Promise.resolve(null)),
  updateTaskPrompt: mock(() => Promise.resolve()),
  computeNextRun: mock(() => new Date()),
}));

mock.module("./embeddings.ts", () => ({
  generateEmbedding: mock(() => Promise.resolve(Array.from({ length: 384 }, () => 0.1))),
}));

const { buildPrompt, formatAlerts, RESEARCH_KNOWLEDGE_NUDGE } = await import("./prompt-builder.ts");
const { COMPONENT_VOCABULARY_RULES } = await import("../research/answer.ts");

const bp = (overrides: Partial<Parameters<typeof buildPrompt>[0]> = {}) =>
  buildPrompt({ userId: "u1", currentMessage: "hello", persona: "persona", botName: "testbot", ...overrides });

describe("buildPrompt", () => {
  test("includes persona in system prompt", async () => {
    const result = await bp({ persona: "You are Jarvis, a helpful assistant." });
    expect(result.systemPrompt).toContain("You are Jarvis, a helpful assistant.");
  });

  test("includes memories in system prompt", async () => {
    const result = await bp();
    expect(result.systemPrompt).toContain("Prefers TypeScript over JavaScript");
  });

  test("includes goals in system prompt", async () => {
    const result = await bp();
    expect(result.systemPrompt).toContain("Learn Rust");
  });

  test("includes scheduled tasks in system prompt", async () => {
    const result = await bp();
    expect(result.systemPrompt).toContain("Morning briefing");
  });

  test("includes conversation history in user prompt", async () => {
    const result = await bp({ currentMessage: "new question" });
    expect(result.userPrompt).toContain("previous question");
    expect(result.userPrompt).toContain("previous answer");
  });

  test("includes current message in user prompt", async () => {
    const result = await bp({ currentMessage: "new question" });
    expect(result.userPrompt).toContain("new question");
  });

  test("returns metadata", async () => {
    const result = await bp();
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
    const result = await bp({ restrictedTools });
    expect(result.systemPrompt).toContain("Verktøyrestriksjoner");
    expect(result.systemPrompt).toContain("Gmail");
  });

  test("does not include restriction prompt when user is allowed", async () => {
    const restrictedTools = {
      Gmail: { description: "Email access", allowedUsers: ["u1"] },
    };
    const result = await bp({ restrictedTools });
    expect(result.systemPrompt).not.toContain("Verktøyrestriksjoner");
  });

  test("includes username in system prompt when provided as string", async () => {
    const result = await bp({ userIdentity: "Rune" });
    expect(result.systemPrompt).toContain("You are currently talking to: Rune");
  });

  test("includes enriched identity when provided as UserIdentity", async () => {
    const result = await bp({
      userIdentity: { name: "Rune Lind", displayName: "rli", title: "Senior Consultant" },
    });
    expect(result.systemPrompt).toContain("You are currently talking to: Rune Lind");
    expect(result.systemPrompt).toContain("Display name: rli");
    expect(result.systemPrompt).toContain("Title: Senior Consultant");
  });

  test("omits missing identity fields", async () => {
    const result = await bp({ userIdentity: { name: "Rune Lind" } });
    expect(result.systemPrompt).toContain("You are currently talking to: Rune Lind");
    expect(result.systemPrompt).not.toContain("Display name");
    expect(result.systemPrompt).not.toContain("Title");
  });

  test("does not include username line when not provided", async () => {
    const result = await bp();
    expect(result.systemPrompt).not.toContain("You are currently talking to");
  });

  test("shows username in conversation history for user messages", async () => {
    const result = await bp({ currentMessage: "new question" });
    // Mock user message has username "Rune", so history should show [user/Rune]
    expect(result.userPrompt).toContain("[user/Rune]");
    // Assistant messages should still show plain [assistant]
    expect(result.userPrompt).toContain("[assistant]");
  });

  test("appends research_knowledge nudge when the bot has the tool", async () => {
    const result = await bp({ researchKnowledgeAvailable: true });
    expect(result.systemPrompt).toContain(RESEARCH_KNOWLEDGE_NUDGE);
  });

  test("omits research_knowledge nudge when the bot doesn't have the tool", async () => {
    const defaultRun = await bp();
    expect(defaultRun.systemPrompt).not.toContain(RESEARCH_KNOWLEDGE_NUDGE);

    const explicitlyOff = await bp({ researchKnowledgeAvailable: false });
    expect(explicitlyOff.systemPrompt).not.toContain(RESEARCH_KNOWLEDGE_NUDGE);
  });

  test("appends the component-vocabulary block when componentAnswers is on", async () => {
    const result = await bp({ componentAnswersEnabled: true });
    expect(result.systemPrompt).toContain(COMPONENT_VOCABULARY_RULES);
    // It sits in the tail region, after the persona/context blocks so it's near
    // the user turn where instruction-following is strongest.
    const blockIdx = result.systemPrompt.indexOf(COMPONENT_VOCABULARY_RULES);
    const personaIdx = result.systemPrompt.indexOf("persona");
    expect(blockIdx).toBeGreaterThan(personaIdx);
    // Chat answers have no [n] citations — the research-only citation sentence
    // must not ride along.
    expect(result.systemPrompt).not.toContain("Keep [n] citations in the surrounding prose");
  });

  test("omits the component-vocabulary block when componentAnswers is off/absent", async () => {
    const offByDefault = await bp();
    expect(offByDefault.systemPrompt).not.toContain(COMPONENT_VOCABULARY_RULES);

    const explicitlyOff = await bp({ componentAnswersEnabled: false });
    expect(explicitlyOff.systemPrompt).not.toContain(COMPONENT_VOCABULARY_RULES);
  });
});

describe("formatAlerts", () => {
  const ts = Date.parse("2026-07-15T10:30:00Z");

  test("uses the honest proactive-messages label", () => {
    const out = formatAlerts([{ id: "a1", source: "watcher:email", content: "hi", timestamp: ts }]);
    expect(out).toContain("Recent proactive messages sent to user (last 24h):");
    expect(out).not.toContain("watcher alerts");
  });

  test("strips all three proactive prefixes from the type label", () => {
    const out = formatAlerts([
      { id: "a1", source: "watcher:email", content: "w", timestamp: ts },
      { id: "a2", source: "task:briefing", content: "t", timestamp: ts },
      { id: "a3", source: "goal:reminder", content: "g", timestamp: ts },
    ]);
    expect(out).toContain("email: w");
    expect(out).toContain("briefing: t");
    expect(out).toContain("reminder: g");
    expect(out).not.toContain("watcher:");
    expect(out).not.toContain("task:");
    expect(out).not.toContain("goal:");
  });

  test("leaves a short alert content untouched", () => {
    const out = formatAlerts([{ id: "a1", source: "watcher:email", content: "short and sweet", timestamp: ts }]);
    expect(out).toContain("short and sweet");
    expect(out).not.toContain("…");
  });

  test("caps a long alert at a word boundary with an ellipsis", () => {
    const content = "word ".repeat(200).trim(); // ~1000 chars, all whole words
    const out = formatAlerts([{ id: "a1", source: "watcher:email", content, timestamp: ts }]);
    const line = out.split("\n").at(-1)!;
    // content portion after the "] email: " prefix
    const rendered = line.slice(line.indexOf("email: ") + "email: ".length);
    expect(rendered.endsWith("…")).toBe(true);
    // The visible content (minus ellipsis) is within the cap and ends on a whole word.
    const visible = rendered.slice(0, -1);
    expect(visible.length).toBeLessThanOrEqual(300);
    expect(visible.endsWith("word")).toBe(true);
    expect(visible).not.toContain("wor…");
  });
});
