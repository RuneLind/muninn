/**
 * Run-level watcher health + the failure escalation's delivery.
 *
 * ⚠️ PLACEMENT IS LOAD-BEARING: this file calls `mock.module`, which invalidates the
 * target module for the whole `bun test` process graph — so it gets its OWN link in
 * package.json's test chain (`&& bun test src/watchers/run-health.test.ts`) rather
 * than riding along in a chunk with files that import the real `db/*` modules.
 */
import { test, expect, describe, mock, beforeEach } from "bun:test";
import type { Watcher, WatcherAlert } from "../types.ts";

const snapshots = new Map<string, unknown>();
let snapshotGetThrows = false;
let snapshotSetThrows = false;
let savedMessages: unknown[] = [];
let saveMessageThrows = false;

mock.module("../db/watchers.ts", () => ({
  getWatcherSnapshot: async (_id: string, key: string) => {
    if (snapshotGetThrows) throw new Error("db down");
    return snapshots.has(key) ? snapshots.get(key) : null;
  },
  setWatcherSnapshot: async (_id: string, key: string, value: unknown) => {
    if (snapshotSetThrows) throw new Error("db down");
    if (value === null || value === undefined) snapshots.delete(key);
    else snapshots.set(key, value);
  },
  getWatchersDueNow: async () => [],
  updateWatcherLastRun: async () => {},
}));

mock.module("../db/messages.ts", () => ({
  saveMessage: async (m: unknown) => {
    if (saveMessageThrows) throw new Error("messages table gone");
    savedMessages.push(m);
  },
  PROACTIVE_SOURCE_PREFIXES: ["watcher:", "task:", "goal:"],
}));

mock.module("../db/threads.ts", () => ({
  getActiveThreadId: async () => "thread-1",
}));

// Deliberately NOT importing `./runner.ts` here. It imports every checker, so this
// file would evaluate `x.ts` with the real logger bound — and `x.test.ts`, later in
// the same `bun test src/watchers/` process, then mocks `../logging.ts` too late to
// rebind it (six of its assertions went silently log-less). That is why the two
// units under test live in leaf modules.
const { markRunHealth, buildRunHealthAlert, deliverFailureAlerts, RUN_HEALTH_KEY, RUN_HEALTH_ENTRY } =
  await import("./run-health.ts");
const { HEALTH_ESCALATE_AFTER, SOURCE_HEALTH_KEY, recordOutcome } = await import("./source-health.ts");

const NOW = 1_800_000_000_000;
const H = 3_600_000;

beforeEach(() => {
  snapshots.clear();
  savedMessages = [];
  snapshotGetThrows = false;
  snapshotSetThrows = false;
  saveMessageThrows = false;
});

describe("markRunHealth", () => {
  test("escalates only once the streak reaches the threshold", async () => {
    for (let run = 1; run <= HEALTH_ESCALATE_AFTER; run++) {
      const alerts = await markRunHealth("w1", "Viktig e-post", "error", NOW + run * H, "no Gmail tool call");
      if (run < HEALTH_ESCALATE_AFTER) expect(alerts).toHaveLength(0);
      else {
        expect(alerts).toHaveLength(1);
        expect(alerts[0]!.summary).toContain(`${HEALTH_ESCALATE_AFTER} runs in a row`);
        expect(alerts[0]!.summary).toContain("no Gmail tool call");
      }
    }
  });

  test("an ok run resets the streak, so recovery is real", async () => {
    for (let run = 1; run <= 5; run++) {
      await markRunHealth("w1", "W", "error", NOW + run * H, "boom");
    }
    expect(await markRunHealth("w1", "W", "ok", NOW + 6 * H)).toHaveLength(0);
    const stored = snapshots.get(RUN_HEALTH_KEY) as Record<string, { consecutive: number; lastOkAt: number }>;
    expect(stored[RUN_HEALTH_ENTRY]!.consecutive).toBe(0);
    expect(stored[RUN_HEALTH_ENTRY]!.lastOkAt).toBe(NOW + 6 * H);
    // And the next failure starts a NEW episode rather than resuming the old streak.
    expect(await markRunHealth("w1", "W", "error", NOW + 7 * H, "boom")).toHaveLength(0);
  });

  test("writes its OWN snapshot key — the per-source map is never touched", async () => {
    snapshots.set(SOURCE_HEALTH_KEY, { "tier2:llms": { outcome: "ok", at: NOW, consecutive: 0 } });
    await markRunHealth("w1", "W", "error", NOW, "boom");
    expect(snapshots.get(SOURCE_HEALTH_KEY)).toEqual({ "tier2:llms": { outcome: "ok", at: NOW, consecutive: 0 } });
    expect(snapshots.has(RUN_HEALTH_KEY)).toBe(true);
  });

  test("a snapshot write failure does not swallow the alert or throw", async () => {
    for (let run = 1; run < HEALTH_ESCALATE_AFTER; run++) {
      await markRunHealth("w1", "W", "error", NOW + run * H, "boom");
    }
    snapshotSetThrows = true;
    const alerts = await markRunHealth("w1", "W", "error", NOW + HEALTH_ESCALATE_AFTER * H, "boom");
    expect(alerts).toHaveLength(1);
  });

  test("a snapshot read failure degrades to no-prior rather than throwing", async () => {
    snapshotGetThrows = true;
    // Under-escalates (the streak restarts) — the deliberate trade: health must never
    // break the path it observes, and over-escalating on a DB blip would page the user
    // about a watcher that is fine.
    expect(await markRunHealth("w1", "W", "error", NOW, "boom")).toHaveLength(0);
  });
});

describe("buildRunHealthAlert", () => {
  const failing = (consecutive: number, lastOkAt?: number) =>
    ({ outcome: "error" as const, at: NOW, consecutive, detail: "boom", ...(lastOkAt != null ? { lastOkAt } : {}) });

  test("id is stable within an episode so hourly repeats dedup to one delivery", () => {
    const a = buildRunHealthAlert("W", failing(HEALTH_ESCALATE_AFTER, NOW - 5 * H), NOW)[0]!;
    const b = buildRunHealthAlert("W", failing(HEALTH_ESCALATE_AFTER + 1, NOW - 5 * H), NOW + H)[0]!;
    expect(a.id).toBe(b.id);
  });

  test("id differs across episodes so a second wedge is still heard", () => {
    const first = buildRunHealthAlert("W", failing(HEALTH_ESCALATE_AFTER, NOW - 5 * H), NOW)[0]!;
    // Recovered, then wedged again: `recordOutcome` reset the streak, so `lastOkAt`
    // is the only thing separating the two episodes.
    const second = buildRunHealthAlert("W", failing(HEALTH_ESCALATE_AFTER, NOW + 10 * H), NOW + 20 * H)[0]!;
    expect(second.id).not.toBe(first.id);
  });

  test("a watcher that has never succeeded says so", () => {
    const alert = buildRunHealthAlert("W", failing(HEALTH_ESCALATE_AFTER), NOW)[0]!;
    expect(alert.summary).toContain("has never completed a run");
  });

  test("says nothing below the threshold, or on an ok record", () => {
    expect(buildRunHealthAlert("W", failing(HEALTH_ESCALATE_AFTER - 1, NOW), NOW)).toHaveLength(0);
    expect(buildRunHealthAlert("W", recordOutcome(undefined, "ok", NOW), NOW)).toHaveLength(0);
  });
});

describe("deliverFailureAlerts", () => {
  const watcher = (lastNotifiedIds: string[] = []): Watcher => ({
    id: "w1",
    userId: "u1",
    botName: "jarvis",
    name: "Viktig e-post",
    type: "email",
    config: {},
    intervalMs: 3_600_000,
    enabled: true,
    lastRunAt: NOW,
    lastNotifiedIds,
    forceNextRun: false,
    createdAt: NOW,
    updatedAt: NOW,
  } as Watcher);

  const alert = (id = "watcher-health:Viktig e-post:run:never:0"): WatcherAlert => ({
    id,
    source: "watcher-health",
    sender: "Watcher health",
    subject: "failing",
    summary: "⚠️ **Watcher failing**",
    urgency: "high",
  });

  function fakeApi(behavior: "ok" | "parse-error" | "hard-error" = "ok") {
    const sent: { text: string; html: boolean }[] = [];
    return {
      sent,
      api: {
        sendMessage: async (_uid: string, text: string, opts?: { parse_mode?: string }) => {
          const html = opts?.parse_mode === "HTML";
          if (html && behavior === "parse-error") throw new Error("Bad Request: can't parse entities");
          if (html && behavior === "hard-error") throw new Error("Forbidden: bot was blocked by the user");
          sent.push({ text, html });
        },
      } as any,
    };
  }

  test("sends and returns the delivered id", async () => {
    const { api, sent } = fakeApi();
    const ids = await deliverFailureAlerts(api, watcher(), "jarvis", [alert()], false);
    expect(ids).toEqual([alert().id]);
    expect(sent).toHaveLength(1);
    expect(savedMessages).toHaveLength(1);
  });

  test("an already-notified id is neither re-sent nor re-recorded", async () => {
    const { api, sent } = fakeApi();
    const ids = await deliverFailureAlerts(api, watcher([alert().id]), "jarvis", [alert()], false);
    expect(ids).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  test("quiet hours HOLD the escalation — nothing sent, nothing recorded, so it re-emits", async () => {
    const { api, sent } = fakeApi();
    const ids = await deliverFailureAlerts(api, watcher(), "jarvis", [alert()], true);
    expect(ids).toEqual([]);
    expect(sent).toHaveLength(0);
    expect(savedMessages).toHaveLength(0);
  });

  test("falls back to plain text when Telegram rejects the HTML, and still records", async () => {
    const { api, sent } = fakeApi("parse-error");
    const ids = await deliverFailureAlerts(api, watcher(), "jarvis", [alert()], false);
    expect(ids).toEqual([alert().id]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toBe(false);
  });

  test("a send that fails outright throws, so nothing is recorded and it retries next run", async () => {
    const { api } = fakeApi("hard-error");
    await expect(deliverFailureAlerts(api, watcher(), "jarvis", [alert()], false)).rejects.toThrow("blocked");
    expect(savedMessages).toHaveLength(0);
  });

  test("a failed message-save does NOT un-record a delivery the user already got", async () => {
    saveMessageThrows = true;
    const { api, sent } = fakeApi();
    const ids = await deliverFailureAlerts(api, watcher(), "jarvis", [alert()], false);
    expect(sent).toHaveLength(1);
    expect(ids).toEqual([alert().id]);
  });
});
