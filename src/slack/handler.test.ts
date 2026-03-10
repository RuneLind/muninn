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

mock.module("../db/goals.ts", () => ({
  saveGoal: mock(() => Promise.resolve("g-1")),
  getActiveGoals: mock(() => Promise.resolve([])),
  getGoalById: mock(() => Promise.resolve(null)),
  updateGoalStatus: mock(() => Promise.resolve()),
  updateGoalCheckedAt: mock(() => Promise.resolve()),
  updateGoalReminderSentAt: mock(() => Promise.resolve()),
  getGoalsNeedingReminder: mock(() => Promise.resolve([])),
  getGoalsNeedingCheckin: mock(() => Promise.resolve([])),
  getAllGoals: mock(() => Promise.resolve([])),
}));

mock.module("../scheduler/detector.ts", () => ({
  extractScheduleAsync: mock(),
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

mock.module("../tracing/index.ts", () => ({
  Tracer: class MockTracer {
    traceId = "mock-trace-id";
    start() { return "mock-span-id"; }
    end() { return 0; }
    addChildSpan() {}
    event() {}
    finish() {}
    error() {}
    totalMs() { return 0; }
    summary() { return {}; }
    formatTelegram() { return ""; }
    get context() { return { traceId: "mock-trace-id", parentId: "mock-span-id" }; }
  },
}));

const mockHandleTopicCommand = mock(() => Promise.resolve());
const mockHandleTopicsCommand = mock(() => Promise.resolve());
const mockHandleDelTopicCommand = mock(() => Promise.resolve());

mock.module("../core/topic-commands.ts", () => ({
  handleTopicCommand: mockHandleTopicCommand,
  handleTopicsCommand: mockHandleTopicsCommand,
  handleDelTopicCommand: mockHandleDelTopicCommand,
}));

const { createSlackMessageHandler } = await import("./handler.ts");
const { extractChannelPosts } = await import("../core/message-processor.ts");

const config = {
  claudeModel: "sonnet",
  claudeTimeoutMs: 30000,
  databaseUrl: "test",
} as any;

const botConfig = {
  name: "testbot",
  dir: "/tmp/testbot",
  persona: "Test persona",
  slackAllowedUserIds: ["U123"],
  restrictedTools: undefined,
} as any;

describe("Slack handler", () => {
  let sayMock: ReturnType<typeof mock>;
  let setStatusMock: ReturnType<typeof mock>;

  beforeEach(() => {
    sayMock = mock(() => Promise.resolve());
    setStatusMock = mock(() => Promise.resolve());
    mockExecuteClaudePrompt.mockClear();
    mockBuildPrompt.mockClear();
    mockSaveMessage.mockClear();
    mockActivityPush.mockClear();
    mockHandleTopicCommand.mockClear();
    mockHandleTopicsCommand.mockClear();
    mockHandleDelTopicCommand.mockClear();
  });

  test("processes a message and calls say", async () => {
    const handler = createSlackMessageHandler(config, botConfig);

    await handler({
      text: "hello",
      userId: "U123",
      username: "testuser",
      say: sayMock,
      setStatus: setStatusMock,
    });

    expect(sayMock).toHaveBeenCalledTimes(1);
    expect(mockSaveMessage).toHaveBeenCalledTimes(2); // user + assistant
    expect(mockBuildPrompt).toHaveBeenCalledTimes(1);
    expect(mockExecuteClaudePrompt).toHaveBeenCalledTimes(1);
  });

  test("blocks unauthorized users", async () => {
    const handler = createSlackMessageHandler(config, botConfig);

    await handler({
      text: "hello",
      userId: "UNAUTHORIZED",
      username: "hacker",
      say: sayMock,
      setStatus: setStatusMock,
    });

    expect(sayMock).toHaveBeenCalledWith("Unauthorized.");
    expect(mockBuildPrompt).not.toHaveBeenCalled();
  });

  test("includes recentChannelMessages in system prompt", async () => {
    const handler = createSlackMessageHandler(config, botConfig);

    await handler({
      text: "what do you think?",
      userId: "U123",
      username: "testuser",
      say: sayMock,
      setStatus: setStatusMock,
      postToChannel: mock(() => Promise.resolve()),
      recentChannelMessages: ["alice: Has anyone tried the new API?", "bob: Yeah, it works great"],
      platform: "slack_channel",
    });

    const claudeCall = mockExecuteClaudePrompt.mock.calls[0] as any[];
    const systemPrompt = claudeCall[3] as string;
    expect(systemPrompt).toContain("Channel Context");
    expect(systemPrompt).toContain("alice: Has anyone tried the new API?");
    expect(systemPrompt).toContain("bob: Yeah, it works great");
  });

  test("does not include channel context section when no messages", async () => {
    const handler = createSlackMessageHandler(config, botConfig);

    await handler({
      text: "hello",
      userId: "U123",
      username: "testuser",
      say: sayMock,
      setStatus: setStatusMock,
      platform: "slack_dm",
    });

    const claudeCall = mockExecuteClaudePrompt.mock.calls[0] as any[];
    const systemPrompt = claudeCall[3] as string;
    expect(systemPrompt).not.toContain("Channel Context");
  });

  test("ignores empty text", async () => {
    const handler = createSlackMessageHandler(config, botConfig);

    await handler({
      text: "",
      userId: "U123",
      username: "testuser",
      say: sayMock,
      setStatus: setStatusMock,
    });

    expect(mockBuildPrompt).not.toHaveBeenCalled();
  });

  test("calls setStatus with Thinking", async () => {
    const handler = createSlackMessageHandler(config, botConfig);

    await handler({
      text: "hello",
      userId: "U123",
      username: "testuser",
      say: sayMock,
      setStatus: setStatusMock,
    });

    expect(setStatusMock).toHaveBeenCalledWith("Thinking...");
  });

  test("handles Claude error gracefully", async () => {
    mockExecuteClaudePrompt.mockRejectedValueOnce(new Error("Claude timed out"));

    const handler = createSlackMessageHandler(config, botConfig);

    await handler({
      text: "hello",
      userId: "U123",
      username: "testuser",
      say: sayMock,
      setStatus: setStatusMock,
    });

    // Should send error message
    expect(sayMock).toHaveBeenCalledTimes(1);
    const errorMsg = (sayMock.mock.calls[0] as any[])[0] as string;
    expect(errorMsg).toContain("Something went wrong");
  });

  describe("Slack channel reference normalization", () => {
    test("converts <#ID|name> to #name", async () => {
      const handler = createSlackMessageHandler(config, botConfig);

      await handler({
        text: "post to <#C0ADMP9CYG7|bot-testing>",
        userId: "U123",
        username: "testuser",
        say: sayMock,
        setStatus: setStatusMock,
      });

      // buildPrompt({ currentMessage, ... }) — extract from options object
      const userMessage = (mockBuildPrompt.mock.calls[0] as any[])[0].currentMessage;
      expect(userMessage).toBe("post to #bot-testing");
    });

    test("converts <#ID> without name to #ID", async () => {
      const handler = createSlackMessageHandler(config, botConfig);

      await handler({
        text: "post to <#C0ADMP9CYG7>",
        userId: "U123",
        username: "testuser",
        say: sayMock,
        setStatus: setStatusMock,
      });

      const userMessage = (mockBuildPrompt.mock.calls[0] as any[])[0].currentMessage;
      expect(userMessage).toBe("post to #C0ADMP9CYG7");
    });

    test("converts multiple channel refs in same message", async () => {
      const handler = createSlackMessageHandler(config, botConfig);

      await handler({
        text: "copy from <#C111|general> to <#C222|random>",
        userId: "U123",
        username: "testuser",
        say: sayMock,
        setStatus: setStatusMock,
      });

      const userMessage = (mockBuildPrompt.mock.calls[0] as any[])[0].currentMessage;
      expect(userMessage).toBe("copy from #general to #random");
    });
  });

  describe("postToChannel integration", () => {
    test("calls postToChannel when Claude responds with slack-post tags", async () => {
      mockExecuteClaudePrompt.mockResolvedValueOnce({
        result: 'Sure!\n<slack-post channel="#testing">Hello from bot!</slack-post>\nPosted!',
        costUsd: 0.01, durationMs: 1000, durationApiMs: 800,
        numTurns: 1, model: "sonnet", inputTokens: 100, outputTokens: 50,
        wallClockMs: 1200, startupMs: 200,
      });

      const postToChannelMock = mock(() => Promise.resolve());
      const handler = createSlackMessageHandler(config, botConfig);

      await handler({
        text: "post a greeting to #testing",
        userId: "U123",
        username: "testuser",
        say: sayMock,
        setStatus: setStatusMock,
        postToChannel: postToChannelMock,
      });

      // postToChannel should be called with channel and formatted message
      expect(postToChannelMock).toHaveBeenCalledTimes(1);
      expect((postToChannelMock.mock.calls[0] as any[])[0]).toBe("#testing");
      expect((postToChannelMock.mock.calls[0] as any[])[1]).toContain("Hello from bot!");

      // say() should get the cleaned text (without <slack-post> tags)
      const sentMsg = (sayMock.mock.calls[0] as any[])[0] as string;
      expect(sentMsg).not.toContain("slack-post");
      expect(sentMsg).not.toContain("Hello from bot!");
      expect(sentMsg).toContain("Posted!");
    });

    test("does not extract posts when postToChannel is not provided", async () => {
      mockExecuteClaudePrompt.mockResolvedValueOnce({
        result: '<slack-post channel="#testing">Hello!</slack-post>',
        costUsd: 0.01, durationMs: 1000, durationApiMs: 800,
        numTurns: 1, model: "sonnet", inputTokens: 100, outputTokens: 50,
        wallClockMs: 1200, startupMs: 200,
      });

      const handler = createSlackMessageHandler(config, botConfig);

      await handler({
        text: "hello",
        userId: "U123",
        username: "testuser",
        say: sayMock,
        setStatus: setStatusMock,
        // no postToChannel provided
      });

      // The raw response goes through formatSlackMrkdwn which strips the tags
      expect(sayMock).toHaveBeenCalledTimes(1);
    });

    test("reports failed channel posts back to user", async () => {
      mockExecuteClaudePrompt.mockResolvedValueOnce({
        result: 'Done!\n<slack-post channel="#secret">Message</slack-post>',
        costUsd: 0.01, durationMs: 1000, durationApiMs: 800,
        numTurns: 1, model: "sonnet", inputTokens: 100, outputTokens: 50,
        wallClockMs: 1200, startupMs: 200,
      });

      const postToChannelMock = mock(() => Promise.reject(new Error("channel_not_found")));
      const handler = createSlackMessageHandler(config, botConfig);

      await handler({
        text: "post to #secret",
        userId: "U123",
        username: "testuser",
        say: sayMock,
        setStatus: setStatusMock,
        postToChannel: postToChannelMock,
      });

      const sentMsg = (sayMock.mock.calls[0] as any[])[0] as string;
      expect(sentMsg).toContain("Klarte ikke poste til kanal");
      expect(sentMsg).toContain("channel_not_found");
    });

    test("handles multiple slack-post tags", async () => {
      mockExecuteClaudePrompt.mockResolvedValueOnce({
        result: 'Posting!\n<slack-post channel="#general">Hi general!</slack-post>\n<slack-post channel="#random">Hi random!</slack-post>',
        costUsd: 0.01, durationMs: 1000, durationApiMs: 800,
        numTurns: 1, model: "sonnet", inputTokens: 100, outputTokens: 50,
        wallClockMs: 1200, startupMs: 200,
      });

      const postToChannelMock = mock(() => Promise.resolve());
      const handler = createSlackMessageHandler(config, botConfig);

      await handler({
        text: "post to both channels",
        userId: "U123",
        username: "testuser",
        say: sayMock,
        setStatus: setStatusMock,
        postToChannel: postToChannelMock,
      });

      expect(postToChannelMock).toHaveBeenCalledTimes(2);
      expect((postToChannelMock.mock.calls[0] as any[])[0]).toBe("#general");
      expect((postToChannelMock.mock.calls[1] as any[])[0]).toBe("#random");
    });
  });

  describe("activity log uses cleaned response", () => {
    test("activity log receives text without slack-post tags", async () => {
      mockExecuteClaudePrompt.mockResolvedValueOnce({
        result: 'Confirmed!\n<slack-post channel="#testing">Posted content</slack-post>',
        costUsd: 0.01, durationMs: 1000, durationApiMs: 800,
        numTurns: 1, model: "sonnet", inputTokens: 100, outputTokens: 50,
        wallClockMs: 1200, startupMs: 200,
      });

      const postToChannelMock = mock(() => Promise.resolve());
      const handler = createSlackMessageHandler(config, botConfig);

      await handler({
        text: "post something",
        userId: "U123",
        username: "testuser",
        say: sayMock,
        setStatus: setStatusMock,
        postToChannel: postToChannelMock,
      });

      // Find the message_out activity log call
      const outCall = mockActivityPush.mock.calls.find(
        (c: any[]) => c[0] === "message_out"
      );
      expect(outCall).toBeDefined();
      const loggedText = outCall![1] as string;
      expect(loggedText).not.toContain("slack-post");
      expect(loggedText).not.toContain("Posted content");
      expect(loggedText).toBe("Confirmed!");
    });
  });

  describe("system prompt includes SLACK_POST_CAPABILITY when postToChannel provided", () => {
    test("appends posting capability to system prompt", async () => {
      const postToChannelMock = mock(() => Promise.resolve());
      const handler = createSlackMessageHandler(config, botConfig);

      await handler({
        text: "hello",
        userId: "U123",
        username: "testuser",
        say: sayMock,
        setStatus: setStatusMock,
        postToChannel: postToChannelMock,
      });

      // The system prompt passed to Claude should include slack-post instructions
      const claudeCall = mockExecuteClaudePrompt.mock.calls[0] as any[];
      const systemPrompt = claudeCall[3] as string; // 4th arg is systemPrompt
      expect(systemPrompt).toContain("Slack Channel Posting");
      expect(systemPrompt).toContain("<slack-post");
    });

    test("does not append posting capability when postToChannel is missing", async () => {
      const handler = createSlackMessageHandler(config, botConfig);

      await handler({
        text: "hello",
        userId: "U123",
        username: "testuser",
        say: sayMock,
        setStatus: setStatusMock,
        // no postToChannel
      });

      const claudeCall = mockExecuteClaudePrompt.mock.calls[0] as any[];
      const systemPrompt = claudeCall[3] as string;
      expect(systemPrompt).not.toContain("Slack Channel Posting");
    });
  });
});

describe("Slack topic command interception", () => {
  let sayMock: ReturnType<typeof mock>;
  let setStatusMock: ReturnType<typeof mock>;

  beforeEach(() => {
    sayMock = mock(() => Promise.resolve());
    setStatusMock = mock(() => Promise.resolve());
    mockHandleTopicCommand.mockClear();
    mockHandleTopicsCommand.mockClear();
    mockHandleDelTopicCommand.mockClear();
    mockExecuteClaudePrompt.mockClear();
    mockBuildPrompt.mockClear();
  });

  test("intercepts /topic in slack_dm", async () => {
    const handler = createSlackMessageHandler(config, botConfig);
    await handler({ text: "/topic", userId: "U123", username: "testuser", say: sayMock, setStatus: setStatusMock, platform: "slack_dm" });
    expect(mockHandleTopicCommand).toHaveBeenCalledTimes(1);
    expect(mockBuildPrompt).not.toHaveBeenCalled();
  });

  test("intercepts 'topic' without slash in slack_dm", async () => {
    const handler = createSlackMessageHandler(config, botConfig);
    await handler({ text: "topic", userId: "U123", username: "testuser", say: sayMock, setStatus: setStatusMock, platform: "slack_dm" });
    expect(mockHandleTopicCommand).toHaveBeenCalledTimes(1);
    expect(mockBuildPrompt).not.toHaveBeenCalled();
  });

  test("intercepts 'topic work' without slash in slack_dm", async () => {
    const handler = createSlackMessageHandler(config, botConfig);
    await handler({ text: "topic work", userId: "U123", username: "testuser", say: sayMock, setStatus: setStatusMock, platform: "slack_dm" });
    expect(mockHandleTopicCommand).toHaveBeenCalledTimes(1);
    const call = mockHandleTopicCommand.mock.calls[0] as any[];
    expect(call[2]).toBe("work"); // arg
  });

  test("intercepts /topic in slack_assistant", async () => {
    const handler = createSlackMessageHandler(config, botConfig);
    await handler({ text: "/topic work", userId: "U123", username: "testuser", say: sayMock, setStatus: setStatusMock, platform: "slack_assistant" });
    expect(mockHandleTopicCommand).toHaveBeenCalledTimes(1);
  });

  test("intercepts /topics", async () => {
    const handler = createSlackMessageHandler(config, botConfig);
    await handler({ text: "/topics", userId: "U123", username: "testuser", say: sayMock, setStatus: setStatusMock, platform: "slack_dm" });
    expect(mockHandleTopicsCommand).toHaveBeenCalledTimes(1);
    expect(mockBuildPrompt).not.toHaveBeenCalled();
  });

  test("intercepts 'topics' without slash", async () => {
    const handler = createSlackMessageHandler(config, botConfig);
    await handler({ text: "topics", userId: "U123", username: "testuser", say: sayMock, setStatus: setStatusMock, platform: "slack_dm" });
    expect(mockHandleTopicsCommand).toHaveBeenCalledTimes(1);
  });

  test("intercepts /deltopic name", async () => {
    const handler = createSlackMessageHandler(config, botConfig);
    await handler({ text: "/deltopic work", userId: "U123", username: "testuser", say: sayMock, setStatus: setStatusMock, platform: "slack_dm" });
    expect(mockHandleDelTopicCommand).toHaveBeenCalledTimes(1);
    const call = mockHandleDelTopicCommand.mock.calls[0] as any[];
    expect(call[2]).toBe("work"); // arg
  });

  test("intercepts 'deltopic work' without slash", async () => {
    const handler = createSlackMessageHandler(config, botConfig);
    await handler({ text: "deltopic work", userId: "U123", username: "testuser", say: sayMock, setStatus: setStatusMock, platform: "slack_dm" });
    expect(mockHandleDelTopicCommand).toHaveBeenCalledTimes(1);
    const call = mockHandleDelTopicCommand.mock.calls[0] as any[];
    expect(call[2]).toBe("work");
  });

  test("does NOT intercept topic commands in slack_channel", async () => {
    const handler = createSlackMessageHandler(config, botConfig);
    await handler({ text: "/topic work", userId: "U123", username: "testuser", say: sayMock, setStatus: setStatusMock, platform: "slack_channel" });
    expect(mockHandleTopicCommand).not.toHaveBeenCalled();
    expect(mockBuildPrompt).toHaveBeenCalledTimes(1); // passes through to processMessage
  });

  test("does NOT intercept regular messages in slack_dm", async () => {
    const handler = createSlackMessageHandler(config, botConfig);
    await handler({ text: "hello", userId: "U123", username: "testuser", say: sayMock, setStatus: setStatusMock, platform: "slack_dm" });
    expect(mockHandleTopicCommand).not.toHaveBeenCalled();
    expect(mockBuildPrompt).toHaveBeenCalledTimes(1);
  });

  test("does NOT intercept 'topical discussion' as a command", async () => {
    const handler = createSlackMessageHandler(config, botConfig);
    await handler({ text: "topical discussion about work", userId: "U123", username: "testuser", say: sayMock, setStatus: setStatusMock, platform: "slack_dm" });
    expect(mockHandleTopicCommand).not.toHaveBeenCalled();
    expect(mockBuildPrompt).toHaveBeenCalledTimes(1);
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
    expect(posts[0]!.message).toBe("First");
    expect(posts[1]!.channel).toBe("#b");
    expect(posts[1]!.message).toBe("Second");
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

  test("handles multiline content in tags", () => {
    const input = '<slack-post channel="#general">Line 1\nLine 2\nLine 3</slack-post>';
    const { cleanText, posts } = extractChannelPosts(input);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.message).toBe("Line 1\nLine 2\nLine 3");
    expect(cleanText).toBe("");
  });

  test("returns empty posts array when no tags present", () => {
    const input = "Just a normal response without any tags";
    const { cleanText, posts } = extractChannelPosts(input);

    expect(posts).toHaveLength(0);
    expect(cleanText).toBe("Just a normal response without any tags");
  });

  test("trims whitespace from channel and message", () => {
    const input = '<slack-post channel=" #testing ">  Trimmed message  </slack-post>';
    const { cleanText, posts } = extractChannelPosts(input);

    expect(posts[0]!.channel).toBe("#testing");
    expect(posts[0]!.message).toBe("Trimmed message");
  });

  test("skips incomplete tag with empty content", () => {
    const input = 'Response\n<slack-post channel="#testing">';
    const { cleanText, posts } = extractChannelPosts(input);

    expect(posts).toHaveLength(0);
    expect(cleanText).toBe("Response");
  });

  test("handles mix of complete and incomplete tags", () => {
    const input = '<slack-post channel="#a">First post</slack-post>\nMiddle text\n<slack-post channel="#b">Truncated content';
    const { cleanText, posts } = extractChannelPosts(input);

    expect(posts).toHaveLength(2);
    expect(posts[0]!.channel).toBe("#a");
    expect(posts[0]!.message).toBe("First post");
    expect(posts[1]!.channel).toBe("#b");
    expect(posts[1]!.message).toBe("Truncated content");
    expect(cleanText).toBe("Middle text");
  });
});
