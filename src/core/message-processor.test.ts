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

const mockExtractMemory = mock();
const mockExtractGoal = mock();
const mockExtractSchedule = mock();

mock.module("../memory/extractor.ts", () => ({
  extractMemoryAsync: mockExtractMemory,
}));

mock.module("../goals/detector.ts", () => ({
  extractGoalAsync: mockExtractGoal,
}));

mock.module("../scheduler/detector.ts", () => ({
  extractScheduleAsync: mockExtractSchedule,
}));

mock.module("../db/users.ts", () => ({
  ensureUser: mock(() => Promise.resolve()),
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
    setConnectorLabel: mock(),
    setModel: mock(),
  },
  createProgressCallback: mock(() => () => {}),
  setConnectorInfo: mock(),
  getConnectorLabel: mock(() => "Claude Code"),
}));

mock.module("../db/prompt-snapshots.ts", () => ({
  savePromptSnapshot: mock(() => Promise.resolve()),
}));

// Captures the most recent addChildSpan call args so tests can assert on them.
const capturedChildSpans: Array<{
  spanId: string;
  parentLabel: string;
  name: string;
  durationMs: number;
  attributes?: Record<string, unknown>;
  startOffsetMs?: number;
}> = [];

const capturedSubSpans: Array<{
  spanId: string;
  parentSpanId: string;
  name: string;
  durationMs: number;
  attributes?: Record<string, unknown>;
  opts?: { startOffsetMs?: number; parentStartedAt?: Date };
}> = [];

let _mockSpanCounter = 0;
const _mockSpanStarts: Record<string, Date> = {};

mock.module("../tracing/index.ts", () => ({
  Tracer: class MockTracer {
    traceId = "mock-trace-id";
    start(label: string) {
      const id = "mock-span-" + ++_mockSpanCounter;
      _mockSpanStarts[label] = new Date(2026, 0, 1, 0, 0, 0);
      return id;
    }
    end() { return 0; }
    addChildSpan(
      parentLabel: string,
      name: string,
      durationMs: number,
      attributes?: Record<string, unknown>,
      startOffsetMs?: number,
    ) {
      const spanId = "mock-child-" + ++_mockSpanCounter;
      capturedChildSpans.push({ spanId, parentLabel, name, durationMs, attributes, startOffsetMs });
      return spanId;
    }
    addSubSpan(
      parentSpanId: string,
      name: string,
      durationMs: number,
      attributes?: Record<string, unknown>,
      opts?: { startOffsetMs?: number; parentStartedAt?: Date },
    ) {
      const spanId = "mock-sub-" + ++_mockSpanCounter;
      capturedSubSpans.push({ spanId, parentSpanId, name, durationMs, attributes, opts });
      return spanId;
    }
    spanStartedAt(label: string) { return _mockSpanStarts[label]; }
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
    mockExtractMemory.mockClear();
    mockExtractGoal.mockClear();
    mockExtractSchedule.mockClear();
    capturedChildSpans.length = 0;
    capturedSubSpans.length = 0;
    _mockSpanCounter = 0;
    for (const k of Object.keys(_mockSpanStarts)) delete _mockSpanStarts[k];
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

  test("skips extraction pipelines for research prompts", async () => {
    await processMessage({
      text: "<!-- research:jira -->\nAnalyse this Jira task...",
      userId: "U123",
      username: "testuser",
      platform: "web",
      botConfig,
      config,
      say: sayMock,
    });

    expect(mockExtractMemory).not.toHaveBeenCalled();
    expect(mockExtractGoal).not.toHaveBeenCalled();
    expect(mockExtractSchedule).not.toHaveBeenCalled();
  });

  test("runs extraction pipelines for normal messages", async () => {
    await processMessage({
      text: "hello",
      userId: "U123",
      username: "testuser",
      platform: "slack_dm",
      botConfig,
      config,
      say: sayMock,
    });

    expect(mockExtractMemory).toHaveBeenCalledTimes(1);
    expect(mockExtractGoal).toHaveBeenCalledTimes(1);
    expect(mockExtractSchedule).toHaveBeenCalledTimes(1);
  });

  test("skips extraction pipelines when skipExtractions is true", async () => {
    await processMessage({
      text: "hello",
      userId: "U123",
      username: "testuser",
      platform: "web",
      botConfig,
      config,
      say: sayMock,
      skipExtractions: true,
    });

    expect(mockExtractMemory).not.toHaveBeenCalled();
    expect(mockExtractGoal).not.toHaveBeenCalled();
    expect(mockExtractSchedule).not.toHaveBeenCalled();
  });

  test("extracts Huginn search trace from tool output and stores under attributes.searchTrace", async () => {
    const trace = { query: { raw: "hello" }, schemaVersion: 1, totalMs: 71 };
    const rawOutput =
      "Found 3 documents:\n- Doc A\n- Doc B\n- Doc C\n\n" +
      "```huginn-trace\n" + JSON.stringify(trace) + "\n```";

    mockExecuteClaudePrompt.mockResolvedValueOnce({
      result: "Here you go.",
      costUsd: 0.01, durationMs: 1000, durationApiMs: 800,
      numTurns: 2, model: "sonnet", inputTokens: 100, outputTokens: 50,
      wallClockMs: 1200, startupMs: 200,
      toolCalls: [{
        id: "toolu_01",
        name: "mcp__knowledge__search_knowledge",
        displayName: "search_knowledge (knowledge)",
        durationMs: 80,
        startOffsetMs: 50,
        input: '{"query":"hello"}',
        output: rawOutput,
      }],
    } as any);

    await processMessage({
      text: "search for hello",
      userId: "U123",
      username: "testuser",
      platform: "web",
      botConfig,
      config: { ...config, tracingCaptureToolOutputs: true } as any,
      say: sayMock,
    });

    const toolSpan = capturedChildSpans.find((s) => s.parentLabel === "claude");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attributes!.searchTrace).toEqual(trace);
    expect(toolSpan!.attributes!.output).toBe("Found 3 documents:\n- Doc A\n- Doc B\n- Doc C");
    expect(toolSpan!.attributes!.output).not.toContain("huginn-trace");
  });

  test("synthesizes per-stage child spans under the search tool span", async () => {
    const trace = {
      schemaVersion: 1,
      query: { raw: "hello" },
      collections: [
        {
          name: "jira-issues",
          indexer: "hybrid",
          fetchK: 10,
          candidates: [{ kept: true }, { kept: false }],
          confidence: { lowConfidence: false, bestScore: -2 },
          timingsMs: { indexFetch: 80, chunkLoad: 20, rerank: 1400, titleBoost: 0, assembly: 1, total: 1501 },
        },
      ],
      totalMs: 1501,
    };
    const rawOutput =
      "result body\n\n```huginn-trace\n" + JSON.stringify(trace) + "\n```";

    mockExecuteClaudePrompt.mockResolvedValueOnce({
      result: "ok",
      costUsd: 0.01, durationMs: 1500, durationApiMs: 1400,
      numTurns: 2, model: "sonnet", inputTokens: 100, outputTokens: 50,
      wallClockMs: 1600, startupMs: 100,
      toolCalls: [{
        id: "toolu_03",
        name: "mcp__knowledge__search_knowledge",
        displayName: "search_knowledge (knowledge)",
        durationMs: 1501,
        startOffsetMs: 50,
        input: '{"query":"hello"}',
        output: rawOutput,
      }],
    } as any);

    await processMessage({
      text: "search",
      userId: "U123",
      username: "testuser",
      platform: "web",
      botConfig,
      config: { ...config, tracingCaptureToolOutputs: true } as any,
      say: sayMock,
    });

    const toolSpan = capturedChildSpans.find((s) => s.parentLabel === "claude");
    expect(toolSpan).toBeDefined();

    // Three non-zero stages: indexFetch, chunkLoad, rerank, assembly (4)
    const subSpans = capturedSubSpans.filter((s) => s.parentSpanId === toolSpan!.spanId);
    expect(subSpans.map((s) => s.name)).toEqual([
      "index.fetch",
      "chunk.load",
      "rerank.ce",
      "assemble",
    ]);

    // First sub-span has startOffsetMs=0 and walks forward
    expect(subSpans[0]!.opts?.startOffsetMs).toBe(0);
    expect(subSpans[1]!.opts?.startOffsetMs).toBe(80);
    expect(subSpans[2]!.opts?.startOffsetMs).toBe(100);

    // Collection-level summary attached
    expect(subSpans[2]!.attributes).toMatchObject({
      collection: "jira-issues",
      indexer: "hybrid",
      candidateCount: 2,
      droppedCount: 1,
      synthesized: true,
      stage: "rerank",
    });
  });

  test("does not synthesize stage spans for non-Huginn tool calls", async () => {
    mockExecuteClaudePrompt.mockResolvedValueOnce({
      result: "ok",
      costUsd: 0.01, durationMs: 100, durationApiMs: 80,
      numTurns: 1, model: "sonnet", inputTokens: 10, outputTokens: 5,
      wallClockMs: 110, startupMs: 10,
      toolCalls: [{
        id: "toolu_04",
        name: "mcp__gmail__search",
        displayName: "search (gmail)",
        durationMs: 50,
        startOffsetMs: 5,
        input: '{}',
        output: "no trace here",
      }],
    } as any);

    await processMessage({
      text: "x",
      userId: "U123",
      username: "testuser",
      platform: "web",
      botConfig,
      config: { ...config, tracingCaptureToolOutputs: true } as any,
      say: sayMock,
    });

    expect(capturedSubSpans).toHaveLength(0);
  });

  test("leaves non-Huginn tool outputs untouched", async () => {
    mockExecuteClaudePrompt.mockResolvedValueOnce({
      result: "Done.",
      costUsd: 0.01, durationMs: 1000, durationApiMs: 800,
      numTurns: 2, model: "sonnet", inputTokens: 100, outputTokens: 50,
      wallClockMs: 1200, startupMs: 200,
      toolCalls: [{
        id: "toolu_02",
        name: "mcp__gmail__search_emails",
        displayName: "search_emails (gmail)",
        durationMs: 50,
        startOffsetMs: 10,
        input: '{"query":"x"}',
        output: "regular tool output, no trace fence",
      }],
    } as any);

    await processMessage({
      text: "check email",
      userId: "U123",
      username: "testuser",
      platform: "web",
      botConfig,
      config: { ...config, tracingCaptureToolOutputs: true } as any,
      say: sayMock,
    });

    const toolSpan = capturedChildSpans.find((s) => s.parentLabel === "claude");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attributes!.searchTrace).toBeUndefined();
    expect(toolSpan!.attributes!.output).toBe("regular tool output, no trace fence");
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
