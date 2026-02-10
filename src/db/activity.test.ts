import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { makeActivity } from "../test/fixtures.ts";
import { saveActivity, getRecentActivity } from "./activity.ts";

setupTestDb();

describe("activity", () => {
  test("saveActivity stores an event", async () => {
    await saveActivity(makeActivity({ text: "test event" }));
    const events = await getRecentActivity(10);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.text === "test event")).toBe(true);
  });

  test("saveActivity with all fields", async () => {
    await saveActivity(makeActivity({
      type: "message_out",
      userId: "u1",
      username: "alice",
      botName: "bot1",
      text: "full event",
      durationMs: 1500,
      costUsd: 0.01,
    }));

    const events = await getRecentActivity(10);
    const event = events.find((e) => e.text === "full event")!;
    expect(event.type).toBe("message_out");
    expect(event.userId).toBe("u1");
    expect(event.username).toBe("alice");
    expect(event.botName).toBe("bot1");
    expect(event.durationMs).toBe(1500);
    expect(event.costUsd).toBe(0.01);
  });

  test("getRecentActivity returns in chronological order", async () => {
    await saveActivity(makeActivity({ text: "first" }));
    await saveActivity(makeActivity({ text: "second" }));
    await saveActivity(makeActivity({ text: "third" }));

    const events = await getRecentActivity(10);
    expect(events[0]!.text).toBe("first");
    expect(events[2]!.text).toBe("third");
  });

  test("getRecentActivity respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await saveActivity(makeActivity({ text: `event-${i}` }));
    }

    const events = await getRecentActivity(2);
    expect(events).toHaveLength(2);
  });

  test("getRecentActivity filters by botName", async () => {
    await saveActivity(makeActivity({ botName: "bot1", text: "bot1 event" }));
    await saveActivity(makeActivity({ botName: "bot2", text: "bot2 event" }));

    const events = await getRecentActivity(10, "bot1");
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toBe("bot1 event");
  });

  test("getRecentActivity returns all bots when botName not specified", async () => {
    await saveActivity(makeActivity({ botName: "bot1", text: "bot1" }));
    await saveActivity(makeActivity({ botName: "bot2", text: "bot2" }));

    const events = await getRecentActivity(10);
    expect(events).toHaveLength(2);
  });

  test("saveActivity with metadata", async () => {
    await saveActivity({
      type: "message_out",
      text: "with metadata",
      metadata: { totalMs: 1500, model: "sonnet", inputTokens: 100, outputTokens: 50 },
    });

    const events = await getRecentActivity(10);
    const event = events.find((e) => e.text === "with metadata")!;
    expect(event.metadata).toBeTruthy();
    // metadata is stored as JSON.stringify then JSONB — may be returned as string or object
    const meta = typeof event.metadata === "string" ? JSON.parse(event.metadata) : event.metadata;
    expect(meta.model).toBe("sonnet");
    expect(meta.totalMs).toBe(1500);
  });
});
