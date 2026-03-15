import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { ActivityEvent } from "../types.ts";

// Mock the DB module before importing activity-log
mock.module("../db/activity.ts", () => ({
  saveActivity: mock(() => Promise.resolve()),
  getRecentActivity: mock(() => Promise.resolve([])),
}));

// Mock the logging module
mock.module("../logging.ts", () => ({
  getLog: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Re-import to get a fresh module with mocks applied
const { activityLog } = await import("./activity-log.ts");

// Helper to reset the activity log state between tests.
// Since we only have the singleton, we drain events by creating a fresh-enough state.
function resetLog() {
  // Clear all events by getting them and shifting
  const all = activityLog.getAll();
  // We can't truly reset the singleton, but we can work with it sequentially
}

describe("ActivityLog", () => {
  describe("push()", () => {
    test("adds events and returns them", () => {
      const event = activityLog.push("message_in", "Hello from Alice", {
        username: "alice",
        botName: "jarvis",
      });

      expect(event.id).toBeDefined();
      expect(event.type).toBe("message_in");
      expect(event.text).toBe("Hello from Alice");
      expect(event.username).toBe("alice");
      expect(event.botName).toBe("jarvis");
      expect(event.timestamp).toBeNumber();
    });

    test("assigns unique IDs to each event", () => {
      const e1 = activityLog.push("message_in", "First");
      const e2 = activityLog.push("message_in", "Second");
      expect(e1.id).not.toBe(e2.id);
    });
  });

  describe("getRecent()", () => {
    test("returns last N events", () => {
      // Push enough events to ensure we have some
      for (let i = 0; i < 5; i++) {
        activityLog.push("message_in", `Message ${i}`);
      }

      const recent = activityLog.getRecent(3);
      expect(recent).toHaveLength(3);
      // Should be the last 3
      expect(recent[2]!.text).toBe("Message 4");
      expect(recent[1]!.text).toBe("Message 3");
      expect(recent[0]!.text).toBe("Message 2");
    });

    test("defaults to 50 events", () => {
      const recent = activityLog.getRecent();
      expect(recent.length).toBeLessThanOrEqual(50);
    });
  });

  describe("getAll()", () => {
    test("returns a copy of all events", () => {
      const initialCount = activityLog.getAll().length;
      activityLog.push("system", "Test event");

      const all = activityLog.getAll();
      expect(all.length).toBe(initialCount + 1);

      // Should be a copy, not the internal array
      all.push({
        id: "fake",
        type: "system",
        timestamp: Date.now(),
        text: "injected",
      });
      expect(activityLog.getAll().length).toBe(initialCount + 1);
    });
  });

  describe("subscribe()", () => {
    test("notifies subscriber on new events", () => {
      const received: ActivityEvent[] = [];
      const unsub = activityLog.subscribe((e) => received.push(e));

      activityLog.push("message_in", "Subscribed event");

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe("Subscribed event");

      unsub();
    });

    test("returns unsubscribe function that stops notifications", () => {
      const received: ActivityEvent[] = [];
      const unsub = activityLog.subscribe((e) => received.push(e));

      activityLog.push("message_in", "Before unsub");
      unsub();
      activityLog.push("message_in", "After unsub");

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe("Before unsub");
    });

    test("supports multiple subscribers", () => {
      const received1: ActivityEvent[] = [];
      const received2: ActivityEvent[] = [];
      const unsub1 = activityLog.subscribe((e) => received1.push(e));
      const unsub2 = activityLog.subscribe((e) => received2.push(e));

      activityLog.push("system", "Multi-subscriber event");

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);

      unsub1();
      unsub2();
    });
  });

  describe("ring buffer", () => {
    test("discards oldest events when exceeding 500", () => {
      // First, note how many events already exist
      const existingCount = activityLog.getAll().length;
      const toAdd = 500 - existingCount + 10; // exceed by 10

      for (let i = 0; i < toAdd; i++) {
        activityLog.push("system", `Buffer event ${i}`);
      }

      const all = activityLog.getAll();
      expect(all.length).toBe(500);

      // The oldest events should have been discarded
      // The last event should be the most recent one we pushed
      expect(all[all.length - 1]!.text).toBe(`Buffer event ${toAdd - 1}`);
    });
  });

  describe("stats", () => {
    test("calculates stats from events", () => {
      const stats = activityLog.stats;
      expect(stats).toHaveProperty("messagesToday");
      expect(stats).toHaveProperty("avgResponseTime");
      expect(stats).toHaveProperty("totalCost");
      expect(stats).toHaveProperty("totalEvents");
      expect(typeof stats.messagesToday).toBe("number");
      expect(typeof stats.avgResponseTime).toBe("number");
      expect(typeof stats.totalCost).toBe("number");
      expect(typeof stats.totalEvents).toBe("number");
      expect(stats.totalEvents).toBe(500); // from the ring buffer test
    });

    test("counts messages from today", () => {
      // Push a message_in event (today)
      activityLog.push("message_in", "Today's message");
      const stats = activityLog.stats;
      expect(stats.messagesToday).toBeGreaterThanOrEqual(1);
    });

    test("calculates average response time from message_out events with durationMs", () => {
      activityLog.push("message_out", "Response 1", { durationMs: 100 });
      activityLog.push("message_out", "Response 2", { durationMs: 300 });

      const stats = activityLog.stats;
      expect(stats.avgResponseTime).toBeGreaterThan(0);
    });

    test("sums total cost from all events", () => {
      activityLog.push("message_out", "Costly response", { costUsd: 0.05 });

      const stats = activityLog.stats;
      expect(stats.totalCost).toBeGreaterThanOrEqual(0.05);
    });
  });
});
