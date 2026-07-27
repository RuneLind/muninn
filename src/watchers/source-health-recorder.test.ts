import { test, expect, describe, mock, beforeEach } from "bun:test";

// The recorder is the only part of source-health that touches the DB, so it needs its
// own file with the snapshot store mocked (mock.module leaks across files in the same
// bun test process — hence the repo's split test scripts).
const store = new Map<string, unknown>();
const setCalls: { key: string; value: unknown }[] = [];
let getThrows = false;
let setThrows = false;

mock.module("../db/watchers.ts", () => ({
  getWatcherSnapshot: async (_id: string, key: string) => {
    if (getThrows) throw new Error("db down");
    return store.has(key) ? store.get(key) : null;
  },
  setWatcherSnapshot: async (_id: string, key: string, value: unknown) => {
    if (setThrows) throw new Error("db down");
    setCalls.push({ key, value });
    if (value === null || value === undefined) store.delete(key);
    else store.set(key, value);
  },
}));

const { openSourceHealth, SOURCE_HEALTH_KEY, HEALTH_ESCALATE_AFTER } = await import("./source-health.ts");

const NOW = 1_800_000_000_000;
const H = 3_600_000;

beforeEach(() => {
  store.clear();
  setCalls.length = 0;
  getThrows = false;
  setThrows = false;
});

describe("openSourceHealth", () => {
  test("accumulates a streak across runs and escalates once past the threshold", async () => {
    for (let run = 1; run <= HEALTH_ESCALATE_AFTER; run++) {
      const rec = await openSourceHealth("w1", "Committer", NOW + run * 24 * H);
      rec.mark("committer:jarvis", "skipped", "off default branch");
      const alerts = await rec.finish();
      if (run < HEALTH_ESCALATE_AFTER) expect(alerts).toHaveLength(0);
      else {
        expect(alerts).toHaveLength(1);
        expect(alerts[0]!.summary).toContain("committer:jarvis");
        expect(alerts[0]!.summary).toContain(`${HEALTH_ESCALATE_AFTER} consecutive`);
      }
    }
    const stored = store.get(SOURCE_HEALTH_KEY) as Record<string, { consecutive: number }>;
    expect(stored["committer:jarvis"]!.consecutive).toBe(HEALTH_ESCALATE_AFTER);
  });

  test("an ok run resets the streak, so recovery is real", async () => {
    for (let run = 1; run <= 5; run++) {
      const rec = await openSourceHealth("w1", "W", NOW + run * H);
      rec.mark("s", "error", "boom");
      await rec.finish();
    }
    const rec = await openSourceHealth("w1", "W", NOW + 6 * H);
    rec.mark("s", "ok");
    expect(await rec.finish()).toHaveLength(0);
    const stored = store.get(SOURCE_HEALTH_KEY) as Record<string, { consecutive: number; lastOkAt: number }>;
    expect(stored.s!.consecutive).toBe(0);
    expect(stored.s!.lastOkAt).toBe(NOW + 6 * H);
  });

  test("a source not marked or carried is DROPPED (a de-configured source can't linger)", async () => {
    store.set(SOURCE_HEALTH_KEY, {
      keep: { outcome: "skipped", at: NOW, consecutive: 2 },
      gone: { outcome: "skipped", at: NOW, consecutive: 2 },
    });
    const rec = await openSourceHealth("w1", "W", NOW + H);
    rec.mark("keep", "ok");
    await rec.finish();
    const stored = store.get(SOURCE_HEALTH_KEY) as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual(["keep"]);
  });

  test("carry() preserves a prior record verbatim — this run judged nothing", async () => {
    store.set(SOURCE_HEALTH_KEY, { s: { outcome: "skipped", at: NOW, consecutive: 2, lastOkAt: NOW - H } });
    const rec = await openSourceHealth("w1", "W", NOW + H);
    rec.carry("s");
    await rec.finish();
    const stored = store.get(SOURCE_HEALTH_KEY) as Record<string, { consecutive: number; at: number }>;
    // NOT incremented: an infra failure is not evidence about the source.
    expect(stored.s!.consecutive).toBe(2);
    expect(stored.s!.at).toBe(NOW);
  });

  test("carry() on a source with no history writes nothing at all", async () => {
    const rec = await openSourceHealth("w1", "W", NOW);
    rec.carry("never-seen");
    await rec.finish();
    expect(store.get(SOURCE_HEALTH_KEY)).toEqual({});
  });

  test("a corrupt snapshot degrades to a fresh map instead of throwing", async () => {
    store.set(SOURCE_HEALTH_KEY, ["not", "a", "map"]);
    const rec = await openSourceHealth("w1", "W", NOW);
    rec.mark("s", "skipped", "x");
    const alerts = await rec.finish();
    expect(alerts).toHaveLength(0); // streak restarts at 1
    expect((store.get(SOURCE_HEALTH_KEY) as any).s.consecutive).toBe(1);
  });

  test("a DB read failure never throws — health must not break the path it observes", async () => {
    getThrows = true;
    const rec = await openSourceHealth("w1", "W", NOW);
    getThrows = false;
    rec.mark("s", "ok");
    expect(await rec.finish()).toHaveLength(0);
  });

  test("a DB write failure never throws, and the alerts still ship", async () => {
    store.set(SOURCE_HEALTH_KEY, { s: { outcome: "skipped", at: NOW, consecutive: 5 } });
    setThrows = true;
    const rec = await openSourceHealth("w1", "W", NOW + H);
    rec.mark("s", "skipped", "still broken");
    // The alert is built BEFORE the persist, so a failed write can't swallow it — the
    // whole point of buildHealthAlerts being pure.
    const alerts = await rec.finish();
    expect(alerts).toHaveLength(1);
  });
});
