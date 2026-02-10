import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { makeMessage } from "../test/fixtures.ts";
import { saveMessage, getRecentMessages, getRecentAlerts } from "./messages.ts";

setupTestDb();

describe("messages", () => {
  test("saveMessage returns an id", async () => {
    const id = await saveMessage(makeMessage());
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  test("saveMessage stores all fields", async () => {
    const id = await saveMessage(makeMessage({
      userId: "u1",
      botName: "bot1",
      username: "alice",
      role: "assistant",
      content: "Hello there",
      costUsd: 0.01,
      durationMs: 500,
      model: "sonnet",
      inputTokens: 100,
      outputTokens: 50,
      source: "watcher:email",
      platform: "telegram",
    }));
    expect(id).toBeTruthy();
  });

  test("getRecentMessages returns messages in chronological order", async () => {
    await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "first" }));
    await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "second" }));
    await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "third" }));

    const messages = await getRecentMessages("u1", 10, "bot1");
    expect(messages).toHaveLength(3);
    expect(messages[0]!.text).toBe("first");
    expect(messages[2]!.text).toBe("third");
  });

  test("getRecentMessages respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: `msg-${i}` }));
    }

    const messages = await getRecentMessages("u1", 2, "bot1");
    expect(messages).toHaveLength(2);
    // Should get the 2 most recent messages
    expect(messages[0]!.text).toBe("msg-3");
    expect(messages[1]!.text).toBe("msg-4");
  });

  test("getRecentMessages filters by userId", async () => {
    await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "for u1" }));
    await saveMessage(makeMessage({ userId: "u2", botName: "bot1", content: "for u2" }));

    const messages = await getRecentMessages("u1", 10, "bot1");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe("for u1");
  });

  test("getRecentMessages filters by botName", async () => {
    await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "bot1 msg" }));
    await saveMessage(makeMessage({ userId: "u1", botName: "bot2", content: "bot2 msg" }));

    const messages = await getRecentMessages("u1", 10, "bot1");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe("bot1 msg");
  });

  test("getRecentMessages returns all bots when botName not specified", async () => {
    await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "bot1 msg" }));
    await saveMessage(makeMessage({ userId: "u1", botName: "bot2", content: "bot2 msg" }));

    const messages = await getRecentMessages("u1", 10);
    expect(messages).toHaveLength(2);
  });

  test("getRecentMessages maps fields correctly", async () => {
    await saveMessage(makeMessage({
      userId: "u1",
      botName: "bot1",
      username: "alice",
      role: "assistant",
      content: "response",
      costUsd: 0.005,
      durationMs: 1000,
      model: "opus",
    }));

    const [msg] = await getRecentMessages("u1", 1, "bot1");
    expect(msg!.role).toBe("assistant");
    expect(msg!.text).toBe("response");
    expect(msg!.userId).toBe("u1");
    expect(msg!.username).toBe("alice");
    expect(msg!.costUsd).toBe(0.005);
    expect(msg!.durationMs).toBe(1000);
    expect(msg!.model).toBe("opus");
    expect(msg!.timestamp).toBeGreaterThan(0);
  });

  describe("getRecentAlerts", () => {
    test("returns messages with source field", async () => {
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", source: "watcher:email", content: "New email" }));
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "regular msg" }));

      const alerts = await getRecentAlerts("u1", "bot1");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.source).toBe("watcher:email");
      expect(alerts[0]!.content).toBe("New email");
    });

    test("returns alerts in chronological order", async () => {
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", source: "watcher:email", content: "alert 1" }));
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", source: "watcher:email", content: "alert 2" }));

      const alerts = await getRecentAlerts("u1", "bot1");
      expect(alerts[0]!.content).toBe("alert 1");
      expect(alerts[1]!.content).toBe("alert 2");
    });

    test("respects limit", async () => {
      for (let i = 0; i < 5; i++) {
        await saveMessage(makeMessage({ userId: "u1", botName: "bot1", source: "watcher:email", content: `alert-${i}` }));
      }

      const alerts = await getRecentAlerts("u1", "bot1", 24, 2);
      expect(alerts).toHaveLength(2);
    });
  });
});
