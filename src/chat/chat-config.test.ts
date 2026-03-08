import { test, expect, describe, beforeEach } from "bun:test";
import { loadChatConfig, addChatUser } from "./chat-config.ts";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "../db/client.ts";

setupTestDb();

describe("loadChatConfig (DB-backed)", () => {
  test("returns null when no users exist for bot", async () => {
    const result = await loadChatConfig("nonexistent-bot");
    expect(result).toBeNull();
  });

  test("returns users with thread bindings", async () => {
    await addChatUser({ id: "test-chat-1", name: "Alice", bot: "jarvis" });
    const result = await loadChatConfig("jarvis");
    expect(result).not.toBeNull();
    const alice = result!.users.find((u) => u.id === "test-chat-1");
    expect(alice).toBeDefined();
    expect(alice!.name).toBe("Alice");
    expect(alice!.bot).toBe("jarvis");
  });

  test("filters by bot when botName provided", async () => {
    await addChatUser({ id: "test-chat-2", name: "Bob", bot: "jarvis" });
    await addChatUser({ id: "test-chat-3", name: "Charlie", bot: "jira-assistant" });

    const jarvisUsers = await loadChatConfig("jarvis");
    const jarvisIds = (jarvisUsers?.users ?? []).map((u) => u.id);
    expect(jarvisIds).toContain("test-chat-2");
    expect(jarvisIds).not.toContain("test-chat-3");
  });

  test("returns all users when no bot filter", async () => {
    await addChatUser({ id: "test-chat-4", name: "Dave", bot: "jarvis" });
    const result = await loadChatConfig();
    expect(result).not.toBeNull();
    const dave = result!.users.find((u) => u.id === "test-chat-4");
    expect(dave).toBeDefined();
  });
});

describe("addChatUser", () => {
  test("creates user in DB and ensures default thread", async () => {
    await addChatUser({ id: "test-chat-5", name: "Eve", bot: "jarvis" });

    const sql = getDb();
    const [user] = await sql`SELECT * FROM users WHERE id = 'test-chat-5'`;
    expect(user).toBeDefined();
    expect(user!.username).toBe("Eve");
    expect(user!.platform).toBe("web");

    const [thread] = await sql`SELECT * FROM threads WHERE user_id = 'test-chat-5' AND bot_name = 'jarvis' AND name = 'main'`;
    expect(thread).toBeDefined();
  });

  test("updates username on re-add", async () => {
    await addChatUser({ id: "test-chat-6", name: "Frank", bot: "jarvis" });
    await addChatUser({ id: "test-chat-6", name: "Franklin", bot: "jarvis" });

    const sql = getDb();
    const [user] = await sql`SELECT * FROM users WHERE id = 'test-chat-6'`;
    expect(user!.username).toBe("Franklin");
  });
});
