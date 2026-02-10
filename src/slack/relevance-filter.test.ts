import { test, expect, describe, mock, beforeEach } from "bun:test";

const mockSpawnHaiku = mock(() => Promise.resolve({
  result: '{"relevant": false}',
  inputTokens: 50,
  outputTokens: 20,
  model: "haiku",
}));

mock.module("../scheduler/executor.ts", () => ({
  spawnHaiku: mockSpawnHaiku,
  callHaiku: mock(() => Promise.resolve("")),
}));

const { RelevanceFilter } = await import("./relevance-filter.ts");

function makeBotConfig(overrides = {}) {
  return {
    name: "testbot",
    dir: "/tmp/testbot",
    persona: "You are a helpful tech assistant that knows about TypeScript, Bun, and web development.",
    telegramBotToken: undefined,
    telegramAllowedUserIds: [],
    slackBotToken: undefined,
    slackAppToken: undefined,
    slackAllowedUserIds: [],
    channelListening: {
      enabled: true,
      cooldownMs: 120000,
      maxResponsesPerHour: 10,
      relevanceThreshold: "medium",
      contextMessages: 10,
      topicHints: ["typescript", "bun"],
    },
    ...overrides,
  } as any;
}

describe("RelevanceFilter", () => {
  beforeEach(() => {
    mockSpawnHaiku.mockClear();
  });

  describe("channel activation", () => {
    test("isChannelActive returns false for unactivated channel", () => {
      const filter = new RelevanceFilter(makeBotConfig());
      expect(filter.isChannelActive("C123")).toBe(false);
    });

    test("activateChannel makes channel active", () => {
      const filter = new RelevanceFilter(makeBotConfig());
      filter.activateChannel("C123");
      expect(filter.isChannelActive("C123")).toBe(true);
    });
  });

  describe("heuristic pre-filters", () => {
    test("rejects messages shorter than 10 chars", async () => {
      const filter = new RelevanceFilter(makeBotConfig());
      const result = await filter.checkRelevance("hi", "user1", "C123", []);
      expect(result.relevant).toBe(false);
      expect(result.skippedReason).toBe("too short");
    });

    test("rejects messages that are only URLs", async () => {
      const filter = new RelevanceFilter(makeBotConfig());
      const result = await filter.checkRelevance("https://example.com", "user1", "C123", []);
      expect(result.relevant).toBe(false);
      expect(result.skippedReason).toBe("only URLs");
    });

    test("rejects messages that are only emoji", async () => {
      const filter = new RelevanceFilter(makeBotConfig());
      const result = await filter.checkRelevance("🎉🎊🎈🎉🎊🎈🎉🎊🎈🎉", "user1", "C123", []);
      expect(result.relevant).toBe(false);
      expect(result.skippedReason).toBe("only emoji");
    });

    test("rejects Slack-style emoji only", async () => {
      const filter = new RelevanceFilter(makeBotConfig());
      const result = await filter.checkRelevance(":thumbsup: :tada: :rocket:", "user1", "C123", []);
      expect(result.relevant).toBe(false);
      expect(result.skippedReason).toBe("only emoji");
    });

    test("passes through substantive messages", async () => {
      const filter = new RelevanceFilter(makeBotConfig());
      mockSpawnHaiku.mockResolvedValueOnce({
        result: '{"relevant": true, "confidence": "high", "reason": "relevant"}',
        inputTokens: 50,
        outputTokens: 20,
        model: "haiku",
      });

      const result = await filter.checkRelevance(
        "How do I set up TypeScript with Bun?",
        "user1", "C123", []
      );
      // Should reach Haiku (not stopped by heuristics)
      expect(mockSpawnHaiku).toHaveBeenCalledTimes(1);
    });
  });

  describe("rate limiting", () => {
    test("enforces per-channel cooldown", async () => {
      const filter = new RelevanceFilter(makeBotConfig({ channelListening: {
        enabled: true,
        cooldownMs: 60000,
        maxResponsesPerHour: 100,
      }}));

      // Record a recent response
      filter.recordResponse("C123");

      const result = await filter.checkRelevance(
        "Another question about something",
        "user1", "C123", []
      );
      expect(result.relevant).toBe(false);
      expect(result.skippedReason).toBe("cooldown");
    });

    test("enforces global hourly rate limit", async () => {
      const filter = new RelevanceFilter(makeBotConfig({ channelListening: {
        enabled: true,
        cooldownMs: 0,
        maxResponsesPerHour: 2,
      }}));

      // Record responses to hit the limit
      filter.recordResponse("C1");
      filter.recordResponse("C2");

      const result = await filter.checkRelevance(
        "Yet another question here",
        "user1", "C3", []
      );
      expect(result.relevant).toBe(false);
      expect(result.skippedReason).toBe("rate limit");
    });
  });

  describe("Haiku relevance check", () => {
    test("returns relevant when Haiku says yes", async () => {
      const filter = new RelevanceFilter(makeBotConfig());
      mockSpawnHaiku.mockResolvedValueOnce({
        result: '{"relevant": true, "confidence": "high", "reason": "Asks about TypeScript setup"}',
        inputTokens: 50,
        outputTokens: 20,
        model: "haiku",
      });

      const result = await filter.checkRelevance(
        "How do I configure TypeScript for Bun?",
        "user1", "C123", []
      );
      expect(result.relevant).toBe(true);
      expect(result.confidence).toBe("high");
      expect(result.reason).toContain("TypeScript");
    });

    test("returns not relevant when Haiku says no", async () => {
      const filter = new RelevanceFilter(makeBotConfig());
      mockSpawnHaiku.mockResolvedValueOnce({
        result: '{"relevant": false}',
        inputTokens: 50,
        outputTokens: 20,
        model: "haiku",
      });

      const result = await filter.checkRelevance(
        "Anyone want to grab lunch?",
        "user1", "C123", []
      );
      expect(result.relevant).toBe(false);
      expect(result.skippedReason).toBe("not relevant");
    });

    test("handles Haiku error gracefully", async () => {
      const filter = new RelevanceFilter(makeBotConfig());
      mockSpawnHaiku.mockRejectedValueOnce(new Error("Haiku timeout"));

      const result = await filter.checkRelevance(
        "Something about TypeScript here",
        "user1", "C123", []
      );
      expect(result.relevant).toBe(false);
      expect(result.skippedReason).toBe("haiku error");
    });

    test("handles unparseable Haiku response", async () => {
      const filter = new RelevanceFilter(makeBotConfig());
      mockSpawnHaiku.mockResolvedValueOnce({
        result: "I'm not sure about the format",
        inputTokens: 50,
        outputTokens: 20,
        model: "haiku",
      });

      const result = await filter.checkRelevance(
        "A reasonable tech question here",
        "user1", "C123", []
      );
      expect(result.relevant).toBe(false);
      expect(result.skippedReason).toBe("parse error");
    });

    test("includes topic hints in prompt", async () => {
      const filter = new RelevanceFilter(makeBotConfig());
      mockSpawnHaiku.mockResolvedValueOnce({
        result: '{"relevant": false}',
        inputTokens: 50,
        outputTokens: 20,
        model: "haiku",
      });

      await filter.checkRelevance(
        "This is a question about something",
        "user1", "C123", ["msg 1", "msg 2"]
      );

      const prompt = mockSpawnHaiku.mock.calls[0]![0] as string;
      expect(prompt).toContain("typescript");
      expect(prompt).toContain("bun");
      expect(prompt).toContain("msg 1");
      expect(prompt).toContain("msg 2");
    });
  });
});
