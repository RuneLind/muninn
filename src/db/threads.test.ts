import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { makeMessage } from "../test/fixtures.ts";
import { saveMessage, getRecentMessages } from "./messages.ts";
import {
  ensureDefaultThread,
  getActiveThread,
  getActiveThreadId,
  switchThread,
  listThreads,
  deleteThread,
  getOrCreateSlackThread,
  getAllThreadsForBot,
} from "./threads.ts";

setupTestDb();

describe("threads", () => {
  describe("ensureDefaultThread", () => {
    test("creates a main thread if none exists", async () => {
      const id = await ensureDefaultThread("u1", "bot1");
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");

      const active = await getActiveThread("u1", "bot1");
      expect(active).not.toBeNull();
      expect(active!.name).toBe("main");
      expect(active!.isActive).toBe(true);
    });

    test("returns existing main thread id", async () => {
      const id1 = await ensureDefaultThread("u1", "bot1");
      const id2 = await ensureDefaultThread("u1", "bot1");
      expect(id1).toBe(id2);
    });

    test("isolates threads by bot", async () => {
      const id1 = await ensureDefaultThread("u1", "bot1");
      const id2 = await ensureDefaultThread("u1", "bot2");
      expect(id1).not.toBe(id2);
    });

    test("isolates threads by user", async () => {
      const id1 = await ensureDefaultThread("u1", "bot1");
      const id2 = await ensureDefaultThread("u2", "bot1");
      expect(id1).not.toBe(id2);
    });
  });

  describe("getActiveThreadId", () => {
    test("creates main thread on first call", async () => {
      const id = await getActiveThreadId("u1", "bot1");
      expect(id).toBeTruthy();

      const thread = await getActiveThread("u1", "bot1");
      expect(thread!.name).toBe("main");
    });

    test("returns active thread if one exists", async () => {
      const thread = await switchThread("u1", "bot1", "work");
      const id = await getActiveThreadId("u1", "bot1");
      expect(id).toBe(thread.id);
    });
  });

  describe("switchThread", () => {
    test("creates and activates a new thread", async () => {
      const thread = await switchThread("u1", "bot1", "work");
      expect(thread.name).toBe("work");
      expect(thread.isActive).toBe(true);

      const active = await getActiveThread("u1", "bot1");
      expect(active!.id).toBe(thread.id);
    });

    test("normalizes thread names to lowercase", async () => {
      const thread = await switchThread("u1", "bot1", "Work Stuff");
      expect(thread.name).toBe("work stuff");
    });

    test("rejects empty thread names", async () => {
      await expect(switchThread("u1", "bot1", "")).rejects.toThrow("Thread name cannot be empty");
      await expect(switchThread("u1", "bot1", "   ")).rejects.toThrow("Thread name cannot be empty");
    });

    test("rejects thread names over 50 characters", async () => {
      const longName = "a".repeat(51);
      await expect(switchThread("u1", "bot1", longName)).rejects.toThrow("Thread name too long");
    });

    test("rejects thread names with newlines", async () => {
      await expect(switchThread("u1", "bot1", "line1\nline2")).rejects.toThrow("cannot contain newlines");
    });

    test("switches between existing threads", async () => {
      const t1 = await switchThread("u1", "bot1", "work");
      const t2 = await switchThread("u1", "bot1", "play");

      // t2 should be active, t1 should not
      const active = await getActiveThread("u1", "bot1");
      expect(active!.id).toBe(t2.id);

      // Switch back to work
      const t1Again = await switchThread("u1", "bot1", "work");
      expect(t1Again.id).toBe(t1.id);
      expect(t1Again.isActive).toBe(true);
    });

    test("deactivates previous thread when switching", async () => {
      await ensureDefaultThread("u1", "bot1");
      await switchThread("u1", "bot1", "work");

      const threads = await listThreads("u1", "bot1");
      const activeThreads = threads.filter((t) => t.isActive);
      expect(activeThreads).toHaveLength(1);
      expect(activeThreads[0]!.name).toBe("work");
    });
  });

  describe("listThreads", () => {
    test("returns empty array when no threads exist", async () => {
      const threads = await listThreads("u1", "bot1");
      expect(threads).toHaveLength(0);
    });

    test("lists all threads for a user+bot", async () => {
      await switchThread("u1", "bot1", "main");
      await switchThread("u1", "bot1", "work");
      await switchThread("u1", "bot1", "play");

      const threads = await listThreads("u1", "bot1");
      expect(threads).toHaveLength(3);
      const names = threads.map((t) => t.name).sort();
      expect(names).toEqual(["main", "play", "work"]);
    });

    test("includes message counts", async () => {
      const thread = await switchThread("u1", "bot1", "work");
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "msg1", threadId: thread.id }));
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "msg2", threadId: thread.id }));

      const threads = await listThreads("u1", "bot1");
      const workThread = threads.find((t) => t.name === "work");
      expect(workThread!.messageCount).toBe(2);
    });

    test("does not include other users' threads", async () => {
      await switchThread("u1", "bot1", "work");
      await switchThread("u2", "bot1", "play");

      const threads = await listThreads("u1", "bot1");
      expect(threads).toHaveLength(1);
      expect(threads[0]!.name).toBe("work");
    });
  });

  describe("deleteThread", () => {
    test("deletes a thread by name", async () => {
      await switchThread("u1", "bot1", "work");
      const result = await deleteThread("u1", "bot1", "work");
      expect(result).toBe(true);

      const threads = await listThreads("u1", "bot1");
      expect(threads.find((t) => t.name === "work")).toBeUndefined();
    });

    test("cannot delete the main thread", async () => {
      await ensureDefaultThread("u1", "bot1");
      const result = await deleteThread("u1", "bot1", "main");
      expect(result).toBe(false);

      const threads = await listThreads("u1", "bot1");
      expect(threads.find((t) => t.name === "main")).toBeDefined();
    });

    test("returns false for non-existent thread", async () => {
      const result = await deleteThread("u1", "bot1", "nonexistent");
      expect(result).toBe(false);
    });

    test("switches to main when deleting active thread", async () => {
      await ensureDefaultThread("u1", "bot1");
      await switchThread("u1", "bot1", "work");
      await deleteThread("u1", "bot1", "work");

      const active = await getActiveThread("u1", "bot1");
      expect(active).not.toBeNull();
      expect(active!.name).toBe("main");
    });

    test("orphans messages when thread is deleted", async () => {
      const thread = await switchThread("u1", "bot1", "work");
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "in work thread", threadId: thread.id }));

      await deleteThread("u1", "bot1", "work");

      // Message should still exist but without thread_id
      const messages = await getRecentMessages("u1", 10, "bot1");
      expect(messages).toHaveLength(1);
      expect(messages[0]!.text).toBe("in work thread");
    });

    test("does not affect other threads", async () => {
      await switchThread("u1", "bot1", "work");
      await switchThread("u1", "bot1", "play");
      await switchThread("u1", "bot1", "main");

      await deleteThread("u1", "bot1", "work");

      const threads = await listThreads("u1", "bot1");
      const names = threads.map((t) => t.name).sort();
      expect(names).toEqual(["main", "play"]);
    });
  });

  describe("getOrCreateSlackThread", () => {
    test("creates a new thread on first call", async () => {
      const id = await getOrCreateSlackThread("u1", "bot1", "C123", "1737000000.000001");
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });

    test("returns same id on subsequent calls (upsert)", async () => {
      const id1 = await getOrCreateSlackThread("u1", "bot1", "C123", "1737000000.000001");
      const id2 = await getOrCreateSlackThread("u1", "bot1", "C123", "1737000000.000001");
      expect(id1).toBe(id2);
    });

    test("different channel+threadTs creates different threads", async () => {
      const id1 = await getOrCreateSlackThread("u1", "bot1", "C123", "1737000000.000001");
      const id2 = await getOrCreateSlackThread("u1", "bot1", "C456", "1737000000.000001");
      const id3 = await getOrCreateSlackThread("u1", "bot1", "C123", "1737000000.000002");
      expect(id1).not.toBe(id2);
      expect(id1).not.toBe(id3);
      expect(id2).not.toBe(id3);
    });

    test("creates thread with is_active=false", async () => {
      await getOrCreateSlackThread("u1", "bot1", "C123", "1737000000.000001");
      const threads = await listThreads("u1", "bot1");
      const slackThread = threads.find((t) => t.name.startsWith("slack:"));
      expect(slackThread).toBeDefined();
      expect(slackThread!.isActive).toBe(false);
      expect(slackThread!.name).toBe("slack:C123:1737000000.000001");
    });

    test("does not interfere with active thread", async () => {
      await switchThread("u1", "bot1", "work");
      await getOrCreateSlackThread("u1", "bot1", "C123", "1737000000.000001");
      const active = await getActiveThread("u1", "bot1");
      expect(active).not.toBeNull();
      expect(active!.name).toBe("work");
    });
  });

  describe("getAllThreadsForBot", () => {
    test("returns empty array when no threads exist", async () => {
      const threads = await getAllThreadsForBot("bot1");
      expect(threads).toHaveLength(0);
    });

    test("returns threads for a specific bot", async () => {
      await switchThread("u1", "bot1", "work");
      await switchThread("u1", "bot1", "play");
      await switchThread("u2", "bot1", "research");
      await switchThread("u1", "bot2", "other");

      const threads = await getAllThreadsForBot("bot1");
      expect(threads).toHaveLength(3);
      const names = threads.map((t) => t.name).sort();
      expect(names).toEqual(["play", "research", "work"]);
    });

    test("returns all threads when no botName specified", async () => {
      await switchThread("u1", "bot1", "work");
      await switchThread("u1", "bot2", "play");

      const threads = await getAllThreadsForBot();
      expect(threads.length).toBeGreaterThanOrEqual(2);
    });

    test("includes message counts", async () => {
      const thread = await switchThread("u1", "bot1", "work");
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "msg1", threadId: thread.id }));
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "msg2", threadId: thread.id }));

      const threads = await getAllThreadsForBot("bot1");
      const workThread = threads.find((t) => t.name === "work");
      expect(workThread!.messageCount).toBe(2);
    });

    test("includes username from latest message", async () => {
      const thread = await switchThread("u1", "bot1", "work");
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", username: "alice", content: "hello", threadId: thread.id }));

      const threads = await getAllThreadsForBot("bot1");
      const workThread = threads.find((t) => t.name === "work");
      expect(workThread!.username).toBe("alice");
    });

    test("returns threads with updatedAt timestamps", async () => {
      await switchThread("u1", "bot1", "first");
      await switchThread("u1", "bot1", "second");

      const threads = await getAllThreadsForBot("bot1");
      // All threads should have valid updatedAt timestamps
      threads.forEach((t) => {
        expect(t.updatedAt).toBeGreaterThan(0);
      });
    });
  });

  describe("thread-scoped messages", () => {
    test("getRecentMessages filters by threadId", async () => {
      const t1 = await switchThread("u1", "bot1", "work");
      const t2 = await switchThread("u1", "bot1", "play");

      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "work msg", threadId: t1.id }));
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "play msg", threadId: t2.id }));

      const workMsgs = await getRecentMessages("u1", 10, "bot1", t1.id);
      expect(workMsgs).toHaveLength(1);
      expect(workMsgs[0]!.text).toBe("work msg");

      const playMsgs = await getRecentMessages("u1", 10, "bot1", t2.id);
      expect(playMsgs).toHaveLength(1);
      expect(playMsgs[0]!.text).toBe("play msg");
    });

    test("pre-thread messages (NULL thread_id) are included only in main thread", async () => {
      const mainThread = await switchThread("u1", "bot1", "main");
      const workThread = await switchThread("u1", "bot1", "work");

      // Save a message without threadId (pre-thread era)
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "old msg" }));
      // Save a message in each thread
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "main msg", threadId: mainThread.id }));
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "work msg", threadId: workThread.id }));

      // Main thread includes pre-migration (NULL) messages
      const mainMsgs = await getRecentMessages("u1", 10, "bot1", mainThread.id);
      expect(mainMsgs).toHaveLength(2);
      expect(mainMsgs.map((m) => m.text).sort()).toEqual(["main msg", "old msg"]);

      // Non-main threads do NOT include pre-migration messages
      const workMsgs = await getRecentMessages("u1", 10, "bot1", workThread.id);
      expect(workMsgs).toHaveLength(1);
      expect(workMsgs[0]!.text).toBe("work msg");

      // Without threadId, all messages are returned
      const allMsgs = await getRecentMessages("u1", 10, "bot1");
      expect(allMsgs).toHaveLength(3);
    });

    test("messages from other threads are excluded in thread-scoped queries", async () => {
      const t1 = await switchThread("u1", "bot1", "work");
      const t2 = await switchThread("u1", "bot1", "play");

      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "work msg", threadId: t1.id }));
      await saveMessage(makeMessage({ userId: "u1", botName: "bot1", content: "play msg", threadId: t2.id }));

      const workMsgs = await getRecentMessages("u1", 10, "bot1", t1.id);
      expect(workMsgs).toHaveLength(1);
      expect(workMsgs[0]!.text).toBe("work msg");
    });
  });
});
