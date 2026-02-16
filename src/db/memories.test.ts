import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { makeMemory } from "../test/fixtures.ts";
import {
  saveMemory,
  searchMemories,
  searchMemoriesHybrid,
  updateMemoryEmbedding,
  getRecentMemories,
  getMemoriesWithoutEmbeddings,
  getMemoriesByUser,
  getMemoriesForUser,
} from "./memories.ts";

setupTestDb();

describe("memories", () => {
  test("saveMemory returns an id", async () => {
    const id = await saveMemory(makeMemory());
    expect(id).toBeTruthy();
  });

  test("saveMemory stores personal scope by default", async () => {
    const id = await saveMemory(makeMemory({ summary: "personal test" }));
    const memories = await getRecentMemories(10, "testbot");
    const found = memories.find((m) => m.id === id);
    expect(found?.scope).toBe("personal");
  });

  test("saveMemory stores shared scope", async () => {
    const id = await saveMemory(makeMemory({ scope: "shared", summary: "shared knowledge" }));
    const memories = await getRecentMemories(10, "testbot");
    const found = memories.find((m) => m.id === id);
    expect(found?.scope).toBe("shared");
  });

  test("saveMemory with embedding", async () => {
    const embedding = Array.from({ length: 384 }, () => Math.random());
    const id = await saveMemory(makeMemory({ embedding }));
    expect(id).toBeTruthy();

    // Should not appear in "without embeddings" list
    const missing = await getMemoriesWithoutEmbeddings();
    expect(missing.find((m) => m.id === id)).toBeUndefined();
  });

  test("searchMemories finds by full-text search", async () => {
    await saveMemory(makeMemory({
      userId: "u1",
      botName: "testbot",
      summary: "User loves TypeScript and Bun runtime",
      content: "Detailed content about TypeScript preferences",
    }));
    await saveMemory(makeMemory({
      userId: "u1",
      botName: "testbot",
      summary: "User prefers dark mode in editors",
      content: "Detailed content about editor settings",
    }));

    const results = await searchMemories("u1", "TypeScript", 5, "testbot");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.summary).toContain("TypeScript");
  });

  test("searchMemories filters by userId for personal scope", async () => {
    await saveMemory(makeMemory({
      userId: "u1",
      botName: "testbot",
      summary: "User one likes coffee",
      scope: "personal",
    }));
    await saveMemory(makeMemory({
      userId: "u2",
      botName: "testbot",
      summary: "User two likes coffee too",
      scope: "personal",
    }));

    const results = await searchMemories("u1", "coffee", 10, "testbot");
    // When botName is specified, it filters by scope: personal for this user OR shared
    // u1 should only see their own personal memories
    const userIds = results.map((m) => m.userId);
    expect(userIds.every((id) => id === "u1")).toBe(true);
  });

  test("searchMemories includes shared memories", async () => {
    await saveMemory(makeMemory({
      userId: "u2",
      botName: "testbot",
      summary: "Company uses Bun for all projects",
      scope: "shared",
    }));

    // u1 should see u2's shared memory
    const results = await searchMemories("u1", "Bun projects", 10, "testbot");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("getRecentMemories returns in reverse chronological order", async () => {
    await saveMemory(makeMemory({ summary: "first memory" }));
    await saveMemory(makeMemory({ summary: "second memory" }));

    const memories = await getRecentMemories(10, "testbot");
    expect(memories).toHaveLength(2);
    // Most recent first
    expect(memories[0]!.summary).toBe("second memory");
  });

  test("getRecentMemories filters by botName", async () => {
    await saveMemory(makeMemory({ botName: "bot1", summary: "bot1 memory" }));
    await saveMemory(makeMemory({ botName: "bot2", summary: "bot2 memory" }));

    const memories = await getRecentMemories(10, "bot1");
    expect(memories).toHaveLength(1);
    expect(memories[0]!.summary).toBe("bot1 memory");
  });

  test("getMemoriesWithoutEmbeddings returns only missing", async () => {
    await saveMemory(makeMemory({ summary: "no embedding" }));
    const embedding = Array.from({ length: 384 }, () => Math.random());
    await saveMemory(makeMemory({ summary: "has embedding", embedding }));

    const missing = await getMemoriesWithoutEmbeddings();
    expect(missing.length).toBeGreaterThanOrEqual(1);
    const summaries = missing.map((m) => m.summary);
    expect(summaries).toContain("no embedding");
    expect(summaries).not.toContain("has embedding");
  });

  test("updateMemoryEmbedding sets the embedding", async () => {
    const id = await saveMemory(makeMemory({ summary: "will get embedding" }));

    // Should initially be in missing list
    let missing = await getMemoriesWithoutEmbeddings();
    expect(missing.find((m) => m.id === id)).toBeTruthy();

    // Update embedding
    const embedding = Array.from({ length: 384 }, () => Math.random());
    await updateMemoryEmbedding(id, embedding);

    // Should no longer be in missing list
    missing = await getMemoriesWithoutEmbeddings();
    expect(missing.find((m) => m.id === id)).toBeUndefined();
  });

  test("searchMemoriesHybrid falls back to FTS when no embedding", async () => {
    await saveMemory(makeMemory({
      userId: "u1",
      botName: "testbot",
      summary: "User works with Kubernetes clusters",
    }));

    const results = await searchMemoriesHybrid("u1", "Kubernetes", null, 5, "testbot");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("searchMemoriesHybrid with embedding combines FTS and vector", async () => {
    const embedding = Array.from({ length: 384 }, () => Math.random());
    await saveMemory(makeMemory({
      userId: "u1",
      botName: "testbot",
      summary: "Kubernetes deployment patterns",
      embedding,
    }));

    const queryEmbedding = Array.from({ length: 384 }, () => Math.random());
    const results = await searchMemoriesHybrid("u1", "Kubernetes", queryEmbedding, 5, "testbot");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  describe("getMemoriesByUser", () => {
    test("groups memories by user with scope counts", async () => {
      await saveMemory(makeMemory({ userId: "u1", botName: "testbot", scope: "personal", summary: "u1 personal" }));
      await saveMemory(makeMemory({ userId: "u1", botName: "testbot", scope: "shared", summary: "u1 shared" }));
      await saveMemory(makeMemory({ userId: "u2", botName: "testbot", scope: "personal", summary: "u2 personal" }));

      const users = await getMemoriesByUser("testbot");
      expect(users.length).toBeGreaterThanOrEqual(2);

      const u1 = users.find((u) => u.userId === "u1");
      expect(u1).toBeDefined();
      expect(u1!.personalCount).toBe(1);
      expect(u1!.sharedCount).toBe(1);
      expect(u1!.totalCount).toBe(2);
    });

    test("filters by botName", async () => {
      await saveMemory(makeMemory({ userId: "u1", botName: "bot1", summary: "bot1 mem" }));
      await saveMemory(makeMemory({ userId: "u1", botName: "bot2", summary: "bot2 mem" }));

      const users = await getMemoriesByUser("bot1");
      expect(users).toHaveLength(1);
      expect(users[0]!.totalCount).toBe(1);
    });

    test("returns all users when no botName specified", async () => {
      await saveMemory(makeMemory({ userId: "u1", botName: "bot1", summary: "some mem" }));
      await saveMemory(makeMemory({ userId: "u2", botName: "bot2", summary: "other mem" }));

      const users = await getMemoriesByUser();
      expect(users.length).toBeGreaterThanOrEqual(2);
    });

    test("includes recent tags", async () => {
      await saveMemory(makeMemory({ userId: "u1", botName: "testbot", tags: ["work", "kotlin"], summary: "tagged mem" }));

      const users = await getMemoriesByUser("testbot");
      const u1 = users.find((u) => u.userId === "u1");
      expect(u1).toBeDefined();
      expect(u1!.recentTags).toContain("work");
      expect(u1!.recentTags).toContain("kotlin");
    });
  });

  describe("getMemoriesForUser", () => {
    test("returns memories for a specific user", async () => {
      await saveMemory(makeMemory({ userId: "u1", botName: "testbot", summary: "u1 mem" }));
      await saveMemory(makeMemory({ userId: "u2", botName: "testbot", summary: "u2 mem" }));

      const memories = await getMemoriesForUser("u1", 10, "testbot");
      expect(memories).toHaveLength(1);
      expect(memories[0]!.summary).toBe("u1 mem");
    });

    test("respects limit parameter", async () => {
      await saveMemory(makeMemory({ userId: "u1", botName: "testbot", summary: "mem1" }));
      await saveMemory(makeMemory({ userId: "u1", botName: "testbot", summary: "mem2" }));
      await saveMemory(makeMemory({ userId: "u1", botName: "testbot", summary: "mem3" }));

      const memories = await getMemoriesForUser("u1", 2, "testbot");
      expect(memories).toHaveLength(2);
    });

    test("orders by created_at DESC", async () => {
      await saveMemory(makeMemory({ userId: "u1", botName: "testbot", summary: "first" }));
      await saveMemory(makeMemory({ userId: "u1", botName: "testbot", summary: "second" }));

      const memories = await getMemoriesForUser("u1", 10, "testbot");
      expect(memories[0]!.summary).toBe("second");
    });

    test("filters by botName", async () => {
      await saveMemory(makeMemory({ userId: "u1", botName: "bot1", summary: "bot1 mem" }));
      await saveMemory(makeMemory({ userId: "u1", botName: "bot2", summary: "bot2 mem" }));

      const memories = await getMemoriesForUser("u1", 10, "bot1");
      expect(memories).toHaveLength(1);
      expect(memories[0]!.summary).toBe("bot1 mem");
    });

    test("returns all bots when no botName specified", async () => {
      await saveMemory(makeMemory({ userId: "u1", botName: "bot1", summary: "bot1 mem" }));
      await saveMemory(makeMemory({ userId: "u1", botName: "bot2", summary: "bot2 mem" }));

      const memories = await getMemoriesForUser("u1", 10);
      expect(memories).toHaveLength(2);
    });
  });
});
