import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { makeMessage } from "../test/fixtures.ts";
import { saveMessage, getRecentMessages, getRecentAlerts, getSimMessages, getSimConversations } from "./messages.ts";
import { createThread } from "./threads.ts";
import { ensureUser } from "./users.ts";

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

  test("getRecentMessages throws when threadId given but botName missing", async () => {
    await expect(getRecentMessages("u1", 10, undefined, "some-thread-id")).rejects.toThrow(
      /botName is required when threadId is provided/,
    );
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

  describe("getRecentMessages excludeProactive", () => {
    test("excludes proactive rows (watcher/task/goal) when flag set", async () => {
      await saveMessage(makeMessage({ userId: "px", botName: "bot1", content: "real convo" }));
      await saveMessage(makeMessage({ userId: "px", botName: "bot1", source: "watcher:email", content: "w" }));
      await saveMessage(makeMessage({ userId: "px", botName: "bot1", source: "task:briefing", content: "t" }));
      await saveMessage(makeMessage({ userId: "px", botName: "bot1", source: "goal:reminder", content: "g" }));

      const filtered = await getRecentMessages("px", 10, "bot1", undefined, { excludeProactive: true });
      expect(filtered.map((m) => m.text)).toEqual(["real convo"]);
    });

    test("keeps NULL-source rows (and non-proactive tags) when flag set", async () => {
      await saveMessage(makeMessage({ userId: "pn", botName: "bot1", content: "null source" }));
      // A hypothetical future non-proactive source tag must NOT vanish from history.
      await saveMessage(makeMessage({ userId: "pn", botName: "bot1", source: "import:archive", content: "tagged but not proactive" }));

      const filtered = await getRecentMessages("pn", 10, "bot1", undefined, { excludeProactive: true });
      expect(filtered.map((m) => m.text)).toEqual(["null source", "tagged but not proactive"]);
    });

    test("flag off (default) keeps proactive rows — current behavior", async () => {
      await saveMessage(makeMessage({ userId: "pd", botName: "bot1", content: "convo" }));
      await saveMessage(makeMessage({ userId: "pd", botName: "bot1", source: "watcher:email", content: "watcher" }));

      const defaulted = await getRecentMessages("pd", 10, "bot1");
      expect(defaulted).toHaveLength(2);

      const explicitOff = await getRecentMessages("pd", 10, "bot1", undefined, { excludeProactive: false });
      expect(explicitOff).toHaveLength(2);
    });

    test("applies in the bare-userId branch (no bot, no thread)", async () => {
      await saveMessage(makeMessage({ userId: "pu", botName: "bot1", content: "keep me" }));
      await saveMessage(makeMessage({ userId: "pu", botName: "bot2", source: "watcher:email", content: "drop me" }));

      const filtered = await getRecentMessages("pu", 10, undefined, undefined, { excludeProactive: true });
      expect(filtered.map((m) => m.text)).toEqual(["keep me"]);
    });

    test("applies in the thread-scoped branch", async () => {
      const thread = await createThread("pt", "bot1", "work");
      await saveMessage(makeMessage({ userId: "pt", botName: "bot1", content: "thread convo", threadId: thread.id }));
      await saveMessage(makeMessage({ userId: "pt", botName: "bot1", source: "goal:checkin", content: "thread proactive", threadId: thread.id }));

      const filtered = await getRecentMessages("pt", 10, "bot1", thread.id, { excludeProactive: true });
      expect(filtered.map((m) => m.text)).toEqual(["thread convo"]);
    });
  });

  describe("getSimMessages", () => {
    test("allPlatforms returns messages across all platforms", async () => {
      const thread = await createThread("u1", "bot1", "cross-platform");
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", platform: "web", content: "web msg", threadId: thread.id }));
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", platform: "slack_assistant", content: "slack msg", threadId: thread.id }));
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", platform: "telegram", content: "tg msg", threadId: thread.id }));

      // Without allPlatforms — only web
      const webOnly = await getSimMessages("u1", "bot1", "web", 50, thread.id);
      expect(webOnly).toHaveLength(1);
      expect(webOnly[0]!.content).toBe("web msg");

      // With allPlatforms — all three
      const all = await getSimMessages("u1", "bot1", "web", 50, thread.id, true);
      expect(all).toHaveLength(3);
      expect(all.map((m) => m.content)).toEqual(["web msg", "slack msg", "tg msg"]);
    });

    test("allPlatforms without threadId returns all messages", async () => {
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", platform: "web", content: "w" }));
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", platform: "telegram", content: "t" }));

      const all = await getSimMessages("u1", "bot1", "web", 50, undefined, true);
      expect(all.length).toBeGreaterThanOrEqual(2);
      const contents = all.map((m) => m.content);
      expect(contents).toContain("w");
      expect(contents).toContain("t");
    });
  });

  describe("getSimConversations", () => {
    test("uses the canonical users.username, not the latest message's label", async () => {
      // The owner's real, canonical name.
      await ensureUser({ id: "vy-1", username: "Vy KI-fagdag", platform: "web" });

      // A human turn (older) followed by a hivemind autorespond assistant turn
      // stamped with the PEER's name — the more recent message. Hydrating from the
      // latest message's username is what used to clobber the owner's name.
      await saveMessage(makeMessage({ userId: "vy-1", botName: "bot1", platform: "web", role: "user", username: "Vy KI-fagdag", content: "hei" }));
      await saveMessage(makeMessage({ userId: "vy-1", botName: "bot1", platform: "web", role: "assistant", username: "claude-hivemind", content: "svar" }));

      const convs = await getSimConversations();
      const conv = convs.find((c) => c.userId === "vy-1" && c.botName === "bot1" && c.platform === "web");
      expect(conv).toBeTruthy();
      expect(conv!.username).toBe("Vy KI-fagdag");
    });

    test("falls back to the message label when no users row exists", async () => {
      await saveMessage(makeMessage({ userId: "orphan-1", botName: "bot1", platform: "web", username: "drifter", content: "hi" }));

      const convs = await getSimConversations();
      const conv = convs.find((c) => c.userId === "orphan-1");
      expect(conv).toBeTruthy();
      expect(conv!.username).toBe("drifter");
    });
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

    test("scopes to the three proactive prefixes, not every non-NULL source", async () => {
      await saveMessage(makeMessage({ userId: "ap", botName: "bot1", source: "watcher:email", content: "w" }));
      await saveMessage(makeMessage({ userId: "ap", botName: "bot1", source: "task:briefing", content: "t" }));
      await saveMessage(makeMessage({ userId: "ap", botName: "bot1", source: "goal:reminder", content: "g" }));
      // Non-proactive tagged rows must NOT surface as alerts.
      await saveMessage(makeMessage({ userId: "ap", botName: "bot1", source: "import:archive", content: "not proactive" }));
      await saveMessage(makeMessage({ userId: "ap", botName: "bot1", content: "plain convo" }));

      const alerts = await getRecentAlerts("ap", "bot1");
      expect(alerts.map((a) => a.content).sort()).toEqual(["g", "t", "w"]);
    });
  });
});
