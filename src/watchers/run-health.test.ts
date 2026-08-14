/**
 * Run-level watcher health, its escalation delivery, and the failure path the
 * runner's `catch` takes.
 *
 * NO `mock.module` here — every DB seam is a parameter. The first cut mocked
 * `db/watchers.ts`/`db/messages.ts`/`db/threads.ts` and imported `runner.ts`, which
 * evaluates `x.ts` with the real logger bound; `x.test.ts`, later in the same
 * `bun test src/watchers/` process, then mocked `../logging.ts` too late to rebind
 * it and six of its assertions went silently log-less. Injected deps mean this file
 * is safe anywhere in the chunk and needs no dedicated link in the test chain.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import type { Watcher, WatcherAlert } from "../types.ts";
import {
  markRunHealth,
  buildRunHealthAlert,
  deliverFailureAlerts,
  handleWatcherFailure,
  runEscalateAfter,
  RUN_HEALTH_KEY,
  RUN_HEALTH_ENTRY,
  type FailureNotifyDeps,
} from "./run-health.ts";
import { HEALTH_ESCALATE_AFTER, SOURCE_HEALTH_KEY, recordOutcome } from "./source-health.ts";

const NOW = 1_800_000_000_000;
const H = 3_600_000;

// ── fakes ────────────────────────────────────────────────────────────

const snapshots = new Map<string, unknown>();
let savedMessages: unknown[] = [];
let activityRows: { type: string; text: string }[] = [];
let snapshotGetThrows = false;
let snapshotSetThrows = false;
let saveMessageThrows = false;

function deps(over: Partial<FailureNotifyDeps> = {}): FailureNotifyDeps {
  return {
    getSnapshot: async (_id, key) => {
      if (snapshotGetThrows) throw new Error("db down");
      return snapshots.has(key) ? snapshots.get(key) : null;
    },
    setSnapshot: async (_id, key, value) => {
      if (snapshotSetThrows) throw new Error("db down");
      snapshots.set(key, value);
    },
    saveMessage: (async (m: unknown) => {
      if (saveMessageThrows) throw new Error("messages table gone");
      savedMessages.push(m);
      return undefined as never;
    }) as FailureNotifyDeps["saveMessage"],
    getActiveThreadId: (async () => "thread-1") as FailureNotifyDeps["getActiveThreadId"],
    pushActivity: (type, text) => activityRows.push({ type, text }),
    ...over,
  };
}

const watcher = (over: Partial<Watcher> = {}): Watcher => ({
  id: "w1",
  userId: "u1",
  botName: "jarvis",
  name: "Viktig e-post",
  type: "email",
  config: {},
  intervalMs: H,
  enabled: true,
  lastRunAt: null,
  lastNotifiedIds: [],
  forceNextRun: false,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
} as Watcher);

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
    } as never,
  };
}

beforeEach(() => {
  snapshots.clear();
  savedMessages = [];
  activityRows = [];
  snapshotGetThrows = false;
  snapshotSetThrows = false;
  saveMessageThrows = false;
});

// ── markRunHealth ────────────────────────────────────────────────────

describe("markRunHealth", () => {
  test("escalates only once the streak reaches the threshold", async () => {
    for (let run = 1; run <= HEALTH_ESCALATE_AFTER; run++) {
      const { alerts } = await markRunHealth(watcher(), "error", NOW + run * H, "no Gmail tool call", deps());
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
      await markRunHealth(watcher(), "error", NOW + run * H, "boom", deps());
    }
    const ok = await markRunHealth(watcher(), "ok", NOW + 6 * H, undefined, deps());
    expect(ok.alerts).toHaveLength(0);
    expect(ok.health.consecutive).toBe(0);
    expect(ok.health.lastOkAt).toBe(NOW + 6 * H);
    const next = await markRunHealth(watcher(), "error", NOW + 7 * H, "boom", deps());
    expect(next.alerts).toHaveLength(0);
  });

  test("writes its OWN snapshot key — the per-source map is never touched", async () => {
    const sourceMap = { "tier2:llms": { outcome: "ok", at: NOW, consecutive: 0 } };
    snapshots.set(SOURCE_HEALTH_KEY, sourceMap);
    await markRunHealth(watcher(), "error", NOW, "boom", deps());
    expect(snapshots.get(SOURCE_HEALTH_KEY)).toEqual(sourceMap);
    expect(snapshots.has(RUN_HEALTH_KEY)).toBe(true);
    expect(Object.keys(snapshots.get(RUN_HEALTH_KEY) as object)).toEqual([RUN_HEALTH_ENTRY]);
  });

  test("the FIRST record seeds lastOkAt from last_run_at, so the alert is not a lie", async () => {
    // A watcher with months of history has no run-health record on deploy day. Without
    // the seed the first escalation claims it "has never completed a run" — false — and
    // healthLevel reads the null lastOkAt as infinite staleness (red `stale`) on the
    // first failure of a watcher that was healthy an hour ago.
    const w = watcher({ lastRunAt: NOW - 2 * H });
    let alerts: WatcherAlert[] = [];
    for (let run = 1; run <= HEALTH_ESCALATE_AFTER; run++) {
      ({ alerts } = await markRunHealth(w, "error", NOW + run, "boom", deps()));
    }
    expect(alerts[0]!.summary).toContain("last completed a run 2h ago");
    expect(alerts[0]!.summary).not.toContain("never");
    const stored = snapshots.get(RUN_HEALTH_KEY) as Record<string, { lastOkAt: number }>;
    expect(stored[RUN_HEALTH_ENTRY]!.lastOkAt).toBe(NOW - 2 * H);
  });

  test("a watcher that has genuinely never run says so", async () => {
    let alerts: WatcherAlert[] = [];
    for (let run = 1; run <= HEALTH_ESCALATE_AFTER; run++) {
      ({ alerts } = await markRunHealth(watcher({ lastRunAt: null }), "error", NOW + run, "boom", deps()));
    }
    expect(alerts[0]!.summary).toContain("has no recorded run before this");
  });

  test("a snapshot write failure does not swallow the alert or throw", async () => {
    for (let run = 1; run < HEALTH_ESCALATE_AFTER; run++) {
      await markRunHealth(watcher(), "error", NOW + run * H, "boom", deps());
    }
    snapshotSetThrows = true;
    const { alerts } = await markRunHealth(watcher(), "error", NOW + HEALTH_ESCALATE_AFTER * H, "boom", deps());
    expect(alerts).toHaveLength(1);
  });

  test("a snapshot read failure degrades to no-prior rather than throwing", async () => {
    snapshotGetThrows = true;
    // Under-escalates (the streak restarts) — the deliberate trade: health must never
    // break the path it observes, and over-escalating on a DB blip would page the user
    // about a watcher that is fine.
    const { alerts } = await markRunHealth(watcher({ lastRunAt: null }), "error", NOW, "boom", deps());
    expect(alerts).toHaveLength(0);
  });
});

// ── escalation threshold ─────────────────────────────────────────────

describe("runEscalateAfter", () => {
  test("a daily-or-slower watcher escalates on the FIRST failure", () => {
    // Three runs is ~3h on the hourly email row but THREE WEEKS on a weekly one,
    // after which the nag bucket would wait 24 more weeks.
    expect(runEscalateAfter(7 * 24 * H)).toBe(1);
    expect(runEscalateAfter(24 * H)).toBe(1);
  });

  test("a fast watcher keeps the 3-run threshold", () => {
    expect(runEscalateAfter(H)).toBe(HEALTH_ESCALATE_AFTER);
    expect(runEscalateAfter(5 * 60_000)).toBe(HEALTH_ESCALATE_AFTER);
  });

  test("markRunHealth applies it — one failure escalates a weekly watcher", async () => {
    const { alerts } = await markRunHealth(
      watcher({ intervalMs: 7 * 24 * H, lastRunAt: NOW - 7 * 24 * H }),
      "error", NOW, "boom", deps(),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.summary).toContain("failed **1 run**");
  });
});

// ── alert shape ──────────────────────────────────────────────────────

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

  test("the id is namespaced, so a per-source key can never collide with it", () => {
    const alert = buildRunHealthAlert("W", failing(HEALTH_ESCALATE_AFTER, NOW), NOW)[0]!;
    expect(alert.id).toContain(RUN_HEALTH_ENTRY);
    expect(RUN_HEALTH_ENTRY).not.toBe("run");
  });

  test("says nothing below the threshold, or on an ok record", () => {
    expect(buildRunHealthAlert("W", failing(HEALTH_ESCALATE_AFTER - 1, NOW), NOW)).toHaveLength(0);
    expect(buildRunHealthAlert("W", recordOutcome(undefined, "ok", NOW), NOW)).toHaveLength(0);
  });
});

// ── delivery ─────────────────────────────────────────────────────────

describe("deliverFailureAlerts", () => {
  const alert = (id = "watcher-health:Viktig e-post:watcher:run:never:0"): WatcherAlert => ({
    id,
    source: "watcher-health",
    sender: "Watcher health",
    subject: "failing",
    summary: "⚠️ **Watcher failing**",
    urgency: "high",
  });

  test("sends and returns the delivered id", async () => {
    const { api, sent } = fakeApi();
    const ids = await deliverFailureAlerts(api, watcher(), "jarvis", [alert()], false, deps());
    expect(ids).toEqual([alert().id]);
    expect(sent).toHaveLength(1);
    expect(savedMessages).toHaveLength(1);
    // Distinguishable from a real email digest in the prompt's proactive-alerts block,
    // while still matching the `watcher:` prefix that keeps it out of history.
    expect((savedMessages[0] as { source: string }).source).toBe("watcher:health");
  });

  test("an already-notified id is neither re-sent nor re-recorded", async () => {
    const { api, sent } = fakeApi();
    const ids = await deliverFailureAlerts(api, watcher({ lastNotifiedIds: [alert().id] }), "jarvis", [alert()], false, deps());
    expect(ids).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  test("quiet hours HOLD the escalation — nothing sent, nothing recorded, so it re-emits", async () => {
    const { api, sent } = fakeApi();
    const ids = await deliverFailureAlerts(api, watcher(), "jarvis", [alert()], true, deps());
    expect(ids).toEqual([]);
    expect(sent).toHaveLength(0);
    expect(savedMessages).toHaveLength(0);
  });

  test("falls back to plain text when Telegram rejects the HTML, and still records", async () => {
    const { api, sent } = fakeApi("parse-error");
    const ids = await deliverFailureAlerts(api, watcher(), "jarvis", [alert()], false, deps());
    expect(ids).toEqual([alert().id]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toBe(false);
  });

  test("a send that fails outright throws, so nothing is recorded and it retries next run", async () => {
    const { api } = fakeApi("hard-error");
    await expect(deliverFailureAlerts(api, watcher(), "jarvis", [alert()], false, deps())).rejects.toThrow("blocked");
    expect(savedMessages).toHaveLength(0);
  });

  test("a failed message-save does NOT un-record a delivery the user already got", async () => {
    saveMessageThrows = true;
    const { api, sent } = fakeApi();
    const ids = await deliverFailureAlerts(api, watcher(), "jarvis", [alert()], false, deps());
    expect(sent).toHaveLength(1);
    expect(ids).toEqual([alert().id]);
  });
});

// ── the runner's whole failure path ──────────────────────────────────

describe("handleWatcherFailure", () => {
  test("an hourly watcher: one activity row, then ONE escalation at the threshold", async () => {
    const { api, sent } = fakeApi();
    const w = watcher({ lastRunAt: NOW - H });
    const delivered: string[][] = [];
    for (let run = 1; run <= 5; run++) {
      const ids = await handleWatcherFailure(api, w, "jarvis", "no Gmail tool call", false, deps(), NOW + run * H);
      delivered.push(ids);
      // What the runner does with the return value — recording ONLY delivered ids is
      // what collapses runs 4 and 5 into silence. Without this line the same
      // escalation ships every hour for the rest of the episode.
      w.lastNotifiedIds = [...w.lastNotifiedIds, ...ids];
    }
    // Row on the first failure only — a 5-minute watcher would otherwise push 288
    // rows a day into activity_log and fan the same count of SSE events out.
    expect(activityRows.filter((r) => r.text.includes("failed:"))).toHaveLength(1);
    // Five failures, ONE Telegram message.
    expect(sent).toHaveLength(1);
    expect(delivered[HEALTH_ESCALATE_AFTER - 1]).toHaveLength(1);
    expect(delivered[0]).toEqual([]);
    expect(delivered[1]).toEqual([]);
    expect(delivered[HEALTH_ESCALATE_AFTER]).toEqual([]);
  });

  test("the escalating run does not ALSO push the generic failure row", async () => {
    const { api } = fakeApi();
    const w = watcher({ intervalMs: 7 * 24 * H, lastRunAt: NOW - 7 * 24 * H });
    await handleWatcherFailure(api, w, "jarvis", "boom", false, deps(), NOW);
    // Escalates on failure 1 (weekly), so the generic row must stand down — one
    // event, one row, not two.
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]!.text).toContain("escalated");
  });

  test("NEVER throws — the caller still has to advance last_run_at", async () => {
    const { api } = fakeApi("hard-error");
    const w = watcher({ intervalMs: 7 * 24 * H, lastRunAt: NOW - 7 * 24 * H });
    const ids = await handleWatcherFailure(api, w, "jarvis", "boom", false, deps(), NOW);
    expect(ids).toEqual([]);
  });

  test("a total DB outage still lets the run report and return cleanly", async () => {
    snapshotGetThrows = true;
    snapshotSetThrows = true;
    const { api } = fakeApi();
    const ids = await handleWatcherFailure(api, watcher(), "jarvis", "boom", false, deps(), NOW);
    expect(ids).toEqual([]);
    expect(activityRows).toHaveLength(1);
  });
});
