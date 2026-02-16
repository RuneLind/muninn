import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import {
  handleTopicCommand,
  handleTopicsCommand,
  handleDelTopicCommand,
  formatThreadList,
  formatTimeAgo,
} from "./topic-commands.ts";
import { switchThread, listThreads } from "../db/threads.ts";
import { saveMessage } from "../db/messages.ts";
import { makeMessage } from "../test/fixtures.ts";

setupTestDb();

function mockReply() {
  const messages: string[] = [];
  const reply = async (msg: string) => { messages.push(msg); };
  return { reply, messages };
}

describe("core/topic-commands", () => {
  describe("handleTopicCommand", () => {
    test("shows 'no topics yet' when no threads exist", async () => {
      const { reply, messages } = mockReply();
      await handleTopicCommand("u1", "bot1", "", reply);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("No topics yet");
      expect(messages[0]).toContain("`/topic name`");
    });

    test("shows current topic when threads exist", async () => {
      await switchThread("u1", "bot1", "work");
      const { reply, messages } = mockReply();
      await handleTopicCommand("u1", "bot1", "", reply);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("Current topic: *work*");
    });

    test("switches to a new topic", async () => {
      const { reply, messages } = mockReply();
      await handleTopicCommand("u1", "bot1", "work", reply);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("Created and switched to topic: *work*");
    });

    test("switches to an existing topic with message count", async () => {
      const thread = await switchThread("u1", "bot1", "work");
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "msg1", threadId: thread.id }));
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "msg2", threadId: thread.id }));

      // Switch away then back
      await switchThread("u1", "bot1", "other");
      const { reply, messages } = mockReply();
      await handleTopicCommand("u1", "bot1", "work", reply);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("Switched to topic: *work*");
      expect(messages[0]).toContain("2 messages");
    });
  });

  describe("handleTopicsCommand", () => {
    test("shows 'no topics yet' when empty", async () => {
      const { reply, messages } = mockReply();
      await handleTopicsCommand("u1", "bot1", reply);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("No topics yet");
    });

    test("lists all threads", async () => {
      await switchThread("u1", "bot1", "work");
      await switchThread("u1", "bot1", "play");
      const { reply, messages } = mockReply();
      await handleTopicsCommand("u1", "bot1", reply);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("*work*");
      expect(messages[0]).toContain("*play*");
    });
  });

  describe("handleDelTopicCommand", () => {
    test("shows usage when no arg", async () => {
      const { reply, messages } = mockReply();
      await handleDelTopicCommand("u1", "bot1", "", reply);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("Usage:");
    });

    test("refuses to delete main", async () => {
      const { reply, messages } = mockReply();
      await handleDelTopicCommand("u1", "bot1", "main", reply);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("Cannot delete");
    });

    test("deletes an existing topic", async () => {
      await switchThread("u1", "bot1", "work");
      const { reply, messages } = mockReply();
      await handleDelTopicCommand("u1", "bot1", "work", reply);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("Deleted topic: *work*");

      const threads = await listThreads("u1", "bot1");
      expect(threads.find((t) => t.name === "work")).toBeUndefined();
    });

    test("reports not found for non-existent topic", async () => {
      const { reply, messages } = mockReply();
      await handleDelTopicCommand("u1", "bot1", "nope", reply);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("Topic not found");
    });
  });

  describe("formatTimeAgo", () => {
    test("returns 'just now' for recent timestamps", () => {
      expect(formatTimeAgo(Date.now())).toBe("just now");
      expect(formatTimeAgo(Date.now() - 30_000)).toBe("just now");
    });

    test("returns minutes", () => {
      expect(formatTimeAgo(Date.now() - 5 * 60_000)).toBe("5m ago");
    });

    test("returns hours", () => {
      expect(formatTimeAgo(Date.now() - 3 * 60 * 60_000)).toBe("3h ago");
    });

    test("returns days", () => {
      expect(formatTimeAgo(Date.now() - 2 * 24 * 60 * 60_000)).toBe("2d ago");
    });
  });

  describe("formatThreadList", () => {
    test("formats active and inactive threads", () => {
      const threads = [
        { id: "1", userId: "u1", botName: "bot1", name: "work", isActive: true, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 5 },
        { id: "2", userId: "u1", botName: "bot1", name: "play", isActive: false, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
      ];
      const result = formatThreadList(threads);
      expect(result).toContain("▶️ *work*");
      expect(result).toContain("○ *play*");
      expect(result).toContain("5 msgs");
      expect(result).toContain("0 msgs");
    });
  });
});
