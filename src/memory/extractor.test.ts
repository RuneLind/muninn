import { test, expect, describe, mock, beforeEach } from "bun:test";

const mockCallHaiku = mock(() => Promise.resolve({
  result: '{"worth_remembering": false}',
  inputTokens: 50,
  outputTokens: 20,
  model: "claude-haiku-4-5-20251001",
}));

const mockSaveMemory = mock(() => Promise.resolve("mem-1"));
const mockGenerateEmbedding = mock(() => Promise.resolve(Array.from({ length: 384 }, () => 0.1)));

mock.module("../ai/haiku-direct.ts", () => ({
  callHaikuWithFallback: mockCallHaiku,
  backendConnector: (b: string) => (b === "cli" ? "claude-cli" : b),
}));

mock.module("../db/memories.ts", () => ({
  saveMemory: mockSaveMemory,
  searchMemories: mock(() => Promise.resolve([])),
  searchMemoriesHybrid: mock(() => Promise.resolve([])),
  updateMemoryEmbedding: mock(() => Promise.resolve()),
  getRecentMemories: mock(() => Promise.resolve([])),
  getMemoriesWithoutEmbeddings: mock(() => Promise.resolve([])),
}));

mock.module("../ai/embeddings.ts", () => ({
  generateEmbedding: mockGenerateEmbedding,
}));

// Import doExtract directly — since extractMemoryAsync is fire-and-forget,
// we need to test the internal function that it wraps.
// We'll do this by triggering extractMemoryAsync and waiting a bit.
const { extractMemoryAsync } = await import("./extractor.ts");

const config = { databaseUrl: "test" } as any;

beforeEach(() => {
  mockCallHaiku.mockClear();
  mockSaveMemory.mockClear();
  mockGenerateEmbedding.mockClear();
});

describe("extractMemoryAsync", () => {
  test("calls Haiku with extraction prompt", async () => {
    mockCallHaiku.mockResolvedValueOnce({
      result: '{"worth_remembering": false}',
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractMemoryAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "I love TypeScript",
      assistantResponse: "TypeScript is great!",
    }, config);

    // Wait for the async fire-and-forget to complete
    await new Promise((r) => setTimeout(r, 100));

    expect(mockCallHaiku).toHaveBeenCalledTimes(1);
    const prompt = (mockCallHaiku.mock.calls[0] as any[])[0] as string;
    expect(prompt).toContain("I love TypeScript");
    expect(prompt).toContain("TypeScript is great!");
  });

  test("saves memory when worth remembering", async () => {
    mockCallHaiku.mockResolvedValueOnce({
      result: JSON.stringify({
        worth_remembering: true,
        summary: "User prefers TypeScript",
        tags: ["preferences", "typescript"],
        scope: "personal",
      }),
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractMemoryAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "I love TypeScript",
      assistantResponse: "Great choice!",
      sourceMessageId: "msg-1",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockGenerateEmbedding).toHaveBeenCalledWith("User prefers TypeScript");
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
    const saveCall = (mockSaveMemory.mock.calls[0] as any[])[0];
    expect(saveCall.userId).toBe("u1");
    expect(saveCall.summary).toBe("User prefers TypeScript");
    expect(saveCall.tags).toEqual(["preferences", "typescript"]);
    expect(saveCall.scope).toBe("personal");
    expect(saveCall.sourceMessageId).toBe("msg-1");
  });

  test("saves a keepable memory even when tags are missing (defaults to [])", async () => {
    mockCallHaiku.mockResolvedValueOnce({
      result: JSON.stringify({
        worth_remembering: true,
        summary: "User lives in Oslo",
        scope: "personal",
        // no tags field
      }),
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractMemoryAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "I live in Oslo",
      assistantResponse: "Got it!",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
    const saveCall = (mockSaveMemory.mock.calls[0] as any[])[0];
    expect(saveCall.summary).toBe("User lives in Oslo");
    expect(saveCall.tags).toEqual([]);
  });

  test("does not save when summary is missing even if worth_remembering", async () => {
    mockCallHaiku.mockResolvedValueOnce({
      result: JSON.stringify({
        worth_remembering: true,
        tags: ["x"],
        scope: "personal",
        // no summary
      }),
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractMemoryAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "test",
      assistantResponse: "test",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  test("does not save when not worth remembering", async () => {
    mockCallHaiku.mockResolvedValueOnce({
      result: '{"worth_remembering": false}',
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractMemoryAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "hello",
      assistantResponse: "hi!",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  test("handles shared scope", async () => {
    mockCallHaiku.mockResolvedValueOnce({
      result: JSON.stringify({
        worth_remembering: true,
        summary: "Team uses Bun runtime",
        tags: ["team", "tooling"],
        scope: "shared",
      }),
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractMemoryAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "Our team uses Bun",
      assistantResponse: "Noted!",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
    const saveCall = (mockSaveMemory.mock.calls[0] as any[])[0];
    expect(saveCall.scope).toBe("shared");
  });

  test("handles markdown-wrapped JSON from Haiku", async () => {
    mockCallHaiku.mockResolvedValueOnce({
      result: '```json\n{"worth_remembering": true, "summary": "test", "tags": ["test"], "scope": "personal"}\n```',
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    extractMemoryAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "test",
      assistantResponse: "test",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
  });

  test("handles invalid JSON from Haiku gracefully", async () => {
    mockCallHaiku.mockResolvedValueOnce({
      result: "not valid json at all",
      inputTokens: 50,
      outputTokens: 20,
      model: "haiku",
    });

    // Should not throw
    extractMemoryAsync({
      userId: "u1",
      botName: "testbot",
      userMessage: "test",
      assistantResponse: "test",
    }, config);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSaveMemory).not.toHaveBeenCalled();
  });
});
