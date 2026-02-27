import { test, expect, describe, mock, beforeEach } from "bun:test";

// Mock all dependencies
const mockExecuteClaudePrompt = mock(() => Promise.resolve({
  result: "Mocked response",
  costUsd: 0.01,
  durationMs: 1000,
  durationApiMs: 800,
  numTurns: 1,
  model: "sonnet",
  inputTokens: 100,
  outputTokens: 50,
  wallClockMs: 1200,
  startupMs: 200,
}));

const mockBuildPrompt = mock(() => Promise.resolve({
  systemPrompt: "You are a test bot",
  userPrompt: "test message",
  meta: {
    dbHistoryMs: 5,
    embeddingMs: 10,
    memorySearchMs: 15,
    messagesCount: 2,
    memoriesCount: 1,
    goalsCount: 0,
    scheduledTasksCount: 0,
    alertsCount: 0,
  },
}));

const mockSaveMessage = mock(() => Promise.resolve("msg-1"));
const mockActivityPush = mock();

mock.module("../ai/connector.ts", () => ({
  resolveConnector: () => mockExecuteClaudePrompt,
}));

mock.module("../ai/prompt-builder.ts", () => ({
  buildPrompt: mockBuildPrompt,
}));

mock.module("../db/messages.ts", () => ({
  saveMessage: mockSaveMessage,
  getRecentMessages: mock(() => Promise.resolve([])),
  getRecentAlerts: mock(() => Promise.resolve([])),
}));

mock.module("../memory/extractor.ts", () => ({
  extractMemoryAsync: mock(),
}));

mock.module("../goals/detector.ts", () => ({
  extractGoalAsync: mock(),
}));

mock.module("../scheduler/detector.ts", () => ({
  extractScheduleAsync: mock(),
}));

mock.module("../dashboard/activity-log.ts", () => ({
  activityLog: { push: mockActivityPush },
}));

mock.module("../dashboard/agent-status.ts", () => ({
  agentStatus: {
    set: mock(),
    startRequest: mock(() => "req_1"),
    updatePhase: mock(),
    completeRequest: mock(),
    clearRequest: mock(),
  },
  createProgressCallback: mock(() => () => {}),
}));

mock.module("../db/prompt-snapshots.ts", () => ({
  savePromptSnapshot: mock(() => Promise.resolve()),
}));

mock.module("../tracing/index.ts", () => ({
  Tracer: class MockTracer {
    traceId = "mock-trace-id";
    start() { return "mock-span-id"; }
    end() { return 0; }
    event() {}
    finish() {}
    error() {}
    totalMs() { return 0; }
    summary() { return {}; }
    formatTelegram() { return "0ms"; }
    get context() { return { traceId: "mock-trace-id", parentId: "mock-span-id" }; }
  },
}));

const { processMessage, extractChannelPosts } = await import("./message-processor.ts");

const config = {
  claudeModel: "sonnet",
  claudeTimeoutMs: 30000,
  databaseUrl: "test",
} as any;

const botConfig = {
  name: "testbot",
  dir: "/tmp/testbot",
  persona: "Test persona",
  slackAllowedUserIds: [],
  restrictedTools: undefined,
} as any;

describe("processMessage", () => {
  let sayMock: ReturnType<typeof mock>;

  beforeEach(() => {
    sayMock = mock(() => Promise.resolve());
    mockExecuteClaudePrompt.mockClear();
    mockBuildPrompt.mockClear();
    mockSaveMessage.mockClear();
    mockActivityPush.mockClear();
  });

  test("processes message and calls say with formatted response", async () => {
    const result = await processMessage({
      text: "hello",
      userId: "U123",
      username: "testuser",
      platform: "slack_dm",
      botConfig,
      config,
      say: sayMock,
    });

    expect(sayMock).toHaveBeenCalledTimes(1);
    expect(mockSaveMessage).toHaveBeenCalledTimes(2); // user + assistant
    expect(mockBuildPrompt).toHaveBeenCalledTimes(1);
    expect(mockExecuteClaudePrompt).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect(result!.traceId).toBe("mock-trace-id");
  });

  test("returns undefined on Claude error and sends error via say", async () => {
    mockExecuteClaudePrompt.mockRejectedValueOnce(new Error("Claude timed out"));

    const result = await processMessage({
      text: "hello",
      userId: "U123",
      username: "testuser",
      platform: "slack_dm",
      botConfig,
      config,
      say: sayMock,
    });

    expect(result).toBeUndefined();
    expect(sayMock).toHaveBeenCalledTimes(1);
    const errorMsg = (sayMock.mock.calls[0] as any[])[0] as string;
    expect(errorMsg).toContain("Something went wrong");
    expect(errorMsg).toContain("Claude timed out");
  });

  test("calls setStatus when provided", async () => {
    const setStatusMock = mock(() => Promise.resolve());

    await processMessage({
      text: "hello",
      userId: "U123",
      username: "testuser",
      platform: "slack_dm",
      botConfig,
      config,
      say: sayMock,
      setStatus: setStatusMock,
    });

    expect(setStatusMock).toHaveBeenCalledWith("Thinking...");
  });

  test("applies Telegram HTML formatting for telegram platform", async () => {
    mockExecuteClaudePrompt.mockResolvedValueOnce({
      result: "Hello **world**",
      costUsd: 0.01, durationMs: 1000, durationApiMs: 800,
      numTurns: 1, model: "sonnet", inputTokens: 100, outputTokens: 50,
      wallClockMs: 1200, startupMs: 200,
    });

    await processMessage({
      text: "hello",
      userId: "U123",
      username: "testuser",
      platform: "telegram",
      botConfig,
      config,
      say: sayMock,
    });

    const sent = (sayMock.mock.calls[0] as any[])[0] as string;
    // Telegram formatting: should contain HTML <i> footer
    expect(sent).toContain("<i>");
  });

  test("applies Slack mrkdwn formatting for slack platform", async () => {
    mockExecuteClaudePrompt.mockResolvedValueOnce({
      result: "Hello world",
      costUsd: 0.01, durationMs: 1000, durationApiMs: 800,
      numTurns: 1, model: "sonnet", inputTokens: 100, outputTokens: 50,
      wallClockMs: 1200, startupMs: 200,
    });

    await processMessage({
      text: "hello",
      userId: "U123",
      username: "testuser",
      platform: "slack_dm",
      botConfig,
      config,
      say: sayMock,
    });

    const sent = (sayMock.mock.calls[0] as any[])[0] as string;
    // Slack formatting: should NOT contain HTML <i> footer
    expect(sent).not.toContain("<i>");
  });

  test("does not call say for empty Slack response", async () => {
    mockExecuteClaudePrompt.mockResolvedValueOnce({
      result: "",
      costUsd: 0.01, durationMs: 1000, durationApiMs: 800,
      numTurns: 1, model: "sonnet", inputTokens: 100, outputTokens: 50,
      wallClockMs: 1200, startupMs: 200,
    });

    await processMessage({
      text: "hello",
      userId: "U123",
      username: "testuser",
      platform: "slack_dm",
      botConfig,
      config,
      say: sayMock,
    });

    expect(sayMock).not.toHaveBeenCalled();
  });

  test("appends Slack post capability when postToChannel provided", async () => {
    const postToChannelMock = mock(() => Promise.resolve());

    await processMessage({
      text: "hello",
      userId: "U123",
      username: "testuser",
      platform: "slack_dm",
      botConfig,
      config,
      say: sayMock,
      postToChannel: postToChannelMock,
    });

    const claudeCall = mockExecuteClaudePrompt.mock.calls[0] as any[];
    const systemPrompt = claudeCall[3] as string;
    expect(systemPrompt).toContain("Slack Channel Posting");
  });

  test("appends channel context to system prompt", async () => {
    await processMessage({
      text: "what do you think?",
      userId: "U123",
      username: "testuser",
      platform: "slack_channel",
      botConfig,
      config,
      say: sayMock,
      postToChannel: mock(() => Promise.resolve()),
      recentChannelMessages: ["alice: Has anyone tried the new API?", "bob: Yeah, it works great"],
    });

    const claudeCall = mockExecuteClaudePrompt.mock.calls[0] as any[];
    const systemPrompt = claudeCall[3] as string;
    expect(systemPrompt).toContain("Channel Context");
    expect(systemPrompt).toContain("alice: Has anyone tried the new API?");
  });

  test("extracts and posts channel directives", async () => {
    mockExecuteClaudePrompt.mockResolvedValueOnce({
      result: 'Sure!\n<slack-post channel="#testing">Hello from bot!</slack-post>\nPosted!',
      costUsd: 0.01, durationMs: 1000, durationApiMs: 800,
      numTurns: 1, model: "sonnet", inputTokens: 100, outputTokens: 50,
      wallClockMs: 1200, startupMs: 200,
    });

    const postToChannelMock = mock(() => Promise.resolve());

    await processMessage({
      text: "post to #testing",
      userId: "U123",
      username: "testuser",
      platform: "slack_dm",
      botConfig,
      config,
      say: sayMock,
      postToChannel: postToChannelMock,
    });

    expect(postToChannelMock).toHaveBeenCalledTimes(1);
    expect((postToChannelMock.mock.calls[0] as any[])[0]).toBe("#testing");

    // say() should get the cleaned text (without <slack-post> tags)
    const sentMsg = (sayMock.mock.calls[0] as any[])[0] as string;
    expect(sentMsg).not.toContain("slack-post");
    expect(sentMsg).toContain("Posted!");
  });

  test("splits long Telegram response with footer only on last chunk", async () => {
    // Generate a response that exceeds 4096 chars when formatted with footer
    const longText = "A".repeat(5000);
    mockExecuteClaudePrompt.mockResolvedValueOnce({
      result: longText,
      costUsd: 0.01, durationMs: 1000, durationApiMs: 800,
      numTurns: 1, model: "sonnet", inputTokens: 100, outputTokens: 50,
      wallClockMs: 1200, startupMs: 200,
    });

    await processMessage({
      text: "hello",
      userId: "U123",
      username: "testuser",
      platform: "telegram",
      botConfig,
      config,
      say: sayMock,
    });

    // Should have been called multiple times (split into chunks)
    expect(sayMock.mock.calls.length).toBeGreaterThan(1);

    // Only the LAST chunk should contain the footer <i> tag
    const calls = sayMock.mock.calls as any[][];
    for (let i = 0; i < calls.length - 1; i++) {
      expect(calls[i]![0]).not.toContain("<i>");
    }
    const lastChunk = calls[calls.length - 1]![0] as string;
    expect(lastChunk).toContain("<i>");

    // Each chunk should be within Telegram's limit
    for (const call of calls) {
      expect((call[0] as string).length).toBeLessThanOrEqual(4096);
    }
  });

  test("saves platform to message DB entries", async () => {
    await processMessage({
      text: "hello",
      userId: "U123",
      username: "testuser",
      platform: "slack_assistant",
      botConfig,
      config,
      say: sayMock,
    });

    // Check that both save calls include platform
    const userSave = (mockSaveMessage.mock.calls[0] as any[])[0];
    expect(userSave.platform).toBe("slack_assistant");
    const assistantSave = (mockSaveMessage.mock.calls[1] as any[])[0];
    expect(assistantSave.platform).toBe("slack_assistant");
  });
});

describe("extractChannelPosts", () => {
  test("extracts a single complete tag", () => {
    const input = 'Hello!\n<slack-post channel="#general">Post content</slack-post>\nDone!';
    const { cleanText, posts } = extractChannelPosts(input);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.channel).toBe("#general");
    expect(posts[0]!.message).toBe("Post content");
    expect(cleanText).toBe("Hello!\n\nDone!");
  });

  test("extracts multiple complete tags", () => {
    const input = '<slack-post channel="#a">First</slack-post>\n<slack-post channel="#b">Second</slack-post>';
    const { cleanText, posts } = extractChannelPosts(input);

    expect(posts).toHaveLength(2);
    expect(posts[0]!.channel).toBe("#a");
    expect(posts[1]!.channel).toBe("#b");
    expect(cleanText).toBe("");
  });

  test("extracts incomplete tag (no closing tag)", () => {
    const input = 'Sure!\n<slack-post channel="#testing">This is the posted content';
    const { cleanText, posts } = extractChannelPosts(input);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.channel).toBe("#testing");
    expect(posts[0]!.message).toBe("This is the posted content");
    expect(cleanText).toBe("Sure!");
  });

  test("returns empty posts array when no tags present", () => {
    const input = "Just a normal response without any tags";
    const { cleanText, posts } = extractChannelPosts(input);

    expect(posts).toHaveLength(0);
    expect(cleanText).toBe("Just a normal response without any tags");
  });
});
