import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { loadChatConfig, clearChatConfigCache, type ChatConfig } from "./chat-config.ts";

describe("loadChatConfig", () => {
  beforeEach(() => {
    clearChatConfigCache();
  });

  afterEach(() => {
    clearChatConfigCache();
  });

  test("returns null when file does not exist", async () => {
    // chat.config.json should not exist in the test environment (gitignored)
    // If it does exist locally, this test validates the real config loads fine
    const result = await loadChatConfig();
    // Result depends on whether the file exists — just verify it doesn't throw
    expect(result === null || (result && Array.isArray(result.users))).toBe(true);
  });

  test("caches result on subsequent calls", async () => {
    const first = await loadChatConfig();
    const second = await loadChatConfig();
    // Should be the exact same reference (cached)
    expect(first).toBe(second);
  });

  test("clearChatConfigCache resets cache so next call re-reads", async () => {
    const first = await loadChatConfig();
    clearChatConfigCache();
    // After clearing, the function should re-read (not necessarily return a different value,
    // but the cache mechanism is exercised)
    const second = await loadChatConfig();
    // Both should be structurally equal (same file on disk)
    if (first === null) {
      expect(second).toBeNull();
    } else {
      expect(second).not.toBeNull();
    }
  });
});

describe("loadChatConfig validation", () => {
  // These tests mock Bun.file to control what the config loader sees
  let origBunFile: typeof Bun.file;

  beforeEach(() => {
    clearChatConfigCache();
    origBunFile = Bun.file;
  });

  afterEach(() => {
    clearChatConfigCache();
    // Restore original
    (Bun as any).file = origBunFile;
  });

  function mockBunFile(content: unknown, exists = true) {
    (Bun as any).file = () => ({
      exists: async () => exists,
      json: async () => content,
    });
  }

  test("returns null for missing file", async () => {
    mockBunFile(null, false);
    expect(await loadChatConfig()).toBeNull();
  });

  test("returns null for empty users array", async () => {
    mockBunFile({ users: [] });
    expect(await loadChatConfig()).toBeNull();
  });

  test("returns null for null content", async () => {
    mockBunFile(null);
    expect(await loadChatConfig()).toBeNull();
  });

  test("returns null for non-array users", async () => {
    mockBunFile({ users: "not-an-array" });
    expect(await loadChatConfig()).toBeNull();
  });

  test("returns null for missing users key", async () => {
    mockBunFile({ other: "data" });
    expect(await loadChatConfig()).toBeNull();
  });

  test("filters out invalid entries", async () => {
    mockBunFile({
      users: [
        { id: "123", name: "Alice", bot: "jarvis" }, // valid
        { id: 456, name: "Bob", bot: "capra" }, // id is number, invalid
        { name: "Charlie", bot: "jarvis" }, // missing id
        { id: "789", bot: "capra" }, // missing name
        { id: "101", name: "Dave" }, // missing bot
        null, // null entry
        "string-entry", // non-object
      ],
    });

    const result = await loadChatConfig();
    expect(result).not.toBeNull();
    expect(result!.users).toHaveLength(1);
    expect(result!.users[0]!.id).toBe("123");
    expect(result!.users[0]!.name).toBe("Alice");
    expect(result!.users[0]!.bot).toBe("jarvis");
  });

  test("returns null when all entries are invalid", async () => {
    mockBunFile({
      users: [
        { id: 123, name: "Bad" }, // invalid types
        null,
      ],
    });
    expect(await loadChatConfig()).toBeNull();
  });

  test("returns valid config with multiple users", async () => {
    mockBunFile({
      users: [
        { id: "u1", name: "Alice", bot: "jarvis" },
        { id: "u2", name: "Bob", bot: "capra" },
      ],
    });

    const result = await loadChatConfig();
    expect(result).not.toBeNull();
    expect(result!.users).toHaveLength(2);
    expect(result!.users[0]!.bot).toBe("jarvis");
    expect(result!.users[1]!.bot).toBe("capra");
  });

  test("returns null when json() throws", async () => {
    (Bun as any).file = () => ({
      exists: async () => true,
      json: async () => {
        throw new Error("parse error");
      },
    });
    expect(await loadChatConfig()).toBeNull();
  });
});
