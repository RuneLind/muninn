import { test, expect } from "bun:test";
import {
  assembleIndexingOverview,
  assessRowHealth,
  classifyJob,
  computeNextRunMs,
  computeTiles,
  describeSchedule,
  formatAge,
  formatCountdown,
  formatDuration,
  formatRelative,
  normalizeStatus,
  scheduleIntervalMs,
  statusBadge,
  toRow,
  type IndexingJobsResponse,
  type RawJob,
  type RawRun,
  type RawSchedule,
} from "./indexing-overview.ts";

// Fixed clock for stable relative-time assertions.
const NOW = Date.parse("2026-07-20T12:00:00Z");

function run(over: Partial<RawRun> = {}): RawRun {
  return {
    runId: "r1",
    status: "succeeded",
    variant: "incremental",
    trigger: "scheduled",
    startedAt: "2026-07-20T10:00:00Z",
    finishedAt: "2026-07-20T10:00:19Z",
    durationSeconds: 19,
    phases: [],
    error: null,
    documentCount: 100,
    chunkCount: 500,
    ...over,
  };
}

function job(over: Partial<RawJob> = {}): RawJob {
  return {
    collection: "c",
    loaded: true,
    job: null,
    schedule: null,
    current: null,
    lastRun: null,
    history: [],
    medianDurationSeconds: {},
    ...over,
  };
}

function deps(jobs: RawJob[]): { fetchJobs: () => Promise<IndexingJobsResponse> } {
  return { fetchJobs: async () => ({ jobs }) };
}

// ---- Schedule shapes -------------------------------------------------------

test("describeSchedule handles calendar daily (weekday null)", () => {
  const s: RawSchedule = { kind: "calendar", hour: 8, minute: 0, weekday: null };
  expect(describeSchedule(s)).toBe("daily 08:00");
});

test("describeSchedule handles calendar with weekday (Mondays)", () => {
  const s: RawSchedule = { kind: "calendar", hour: 9, minute: 5, weekday: 1 };
  expect(describeSchedule(s)).toBe("Mondays 09:05");
});

test("describeSchedule handles hourly", () => {
  const s: RawSchedule = { kind: "hourly", minute: 30 };
  expect(describeSchedule(s)).toBe("hourly at :30");
});

test("describeSchedule handles interval", () => {
  const s: RawSchedule = { kind: "interval", seconds: 3600 };
  expect(describeSchedule(s)).toBe("every 3600s");
});

test("describeSchedule handles null", () => {
  expect(describeSchedule(null)).toBeNull();
});

// ---- Three-class grouping invariant ---------------------------------------

test("every row appears exactly once, classes sum to total", async () => {
  const jobs: RawJob[] = [
    job({ collection: "scheduled-a", schedule: { kind: "calendar", hour: 8, minute: 0, weekday: null }, lastRun: run() }),
    job({ collection: "scheduled-b", schedule: { kind: "hourly", minute: 15 }, lastRun: null }),
    job({ collection: "tracked-a", schedule: null, lastRun: run() }),
    job({ collection: "tracked-b", schedule: null, lastRun: run() }),
    job({ collection: "never-a", schedule: null, lastRun: null }),
  ];
  const o = await assembleIndexingOverview(deps(jobs), NOW);

  expect(o.total).toBe(5);
  const byKey = Object.fromEntries(o.classes.map((c) => [c.key, c.rows.map((r) => r.collection)]));
  expect(byKey.scheduled).toEqual(["scheduled-a", "scheduled-b"]);
  expect(byKey.tracked).toEqual(["tracked-a", "tracked-b"]);
  expect(byKey.never).toEqual(["never-a"]);

  // Invariant: sum of class sizes == total, and every collection appears once.
  const all = o.classes.flatMap((c) => c.rows.map((r) => r.collection));
  expect(all.length).toBe(o.total);
  expect(new Set(all).size).toBe(o.total);
});

test("classes render scheduled-first", async () => {
  const o = await assembleIndexingOverview(deps([job({ lastRun: run() })]), NOW);
  expect(o.classes.map((c) => c.key)).toEqual(["scheduled", "tracked", "never"]);
});

test("classifyJob: schedule wins even when lastRun present", () => {
  expect(classifyJob(job({ schedule: { kind: "calendar" }, lastRun: run() }))).toBe("scheduled");
  expect(classifyJob(job({ schedule: null, lastRun: run() }))).toBe("tracked");
  expect(classifyJob(job({ schedule: null, lastRun: null }))).toBe("never");
});

// ---- Medians ---------------------------------------------------------------

test("medianDurationSeconds with two variants renders both, incremental-first", () => {
  const row = toRow(job({ medianDurationSeconds: { rebuild: 83, incremental: 10 } }), NOW);
  expect(row.medians).toEqual([
    { variant: "incremental", duration: "10s" },
    { variant: "rebuild", duration: "1m 23s" },
  ]);
});

test("empty medianDurationSeconds ⇒ no median entries", () => {
  expect(toRow(job({ medianDurationSeconds: {} }), NOW).medians).toEqual([]);
});

// ---- Null durations, running / incomplete ----------------------------------

test("running run: durationSeconds null ⇒ lastDuration null, no 'null s'", () => {
  const row = toRow(
    job({
      current: run({ status: "running", durationSeconds: null, finishedAt: null, startedAt: "2026-07-20T11:59:00Z" }),
      lastRun: run({ status: "running", durationSeconds: null, finishedAt: null }),
    }),
    NOW,
  );
  expect(row.running).toBe(true);
  expect(row.lastDuration).toBeNull();
  expect(row.runningElapsed).toBe("1m"); // 60s elapsed
});

test("running run with no startedAt ⇒ elapsed-or-nothing (null elapsed)", () => {
  const row = toRow(job({ current: run({ status: "running", startedAt: null, durationSeconds: null }) }), NOW);
  expect(row.running).toBe(true);
  expect(row.runningElapsed).toBeNull();
});

test("incomplete run: null durationSeconds ⇒ no 'null s'", () => {
  const row = toRow(job({ lastRun: run({ status: "incomplete", durationSeconds: null, finishedAt: null }) }), NOW);
  expect(row.lastDuration).toBeNull();
});

test("formatDuration never yields 'null s'", () => {
  expect(formatDuration(null)).toBeNull();
  expect(formatDuration(undefined)).toBeNull();
  expect(formatDuration(0)).toBe("0s");
  expect(formatDuration(45)).toBe("45s");
  expect(formatDuration(159)).toBe("2m 39s");
  expect(formatDuration(4802)).toBe("1h 20m");
});

// ---- Status styling --------------------------------------------------------

test("degraded is distinct from succeeded", () => {
  const deg = statusBadge("degraded");
  const ok = statusBadge("succeeded");
  expect(deg.status).toBe("degraded");
  expect(deg.cls).toBe("degraded");
  expect(deg.cls).not.toBe(ok.cls);
});

test("skipped is its own status, not warning/degraded", () => {
  const sk = statusBadge("skipped");
  expect(sk.status).toBe("skipped");
  expect(sk.cls).toBe("skipped");
  expect(sk.cls).not.toBe(statusBadge("degraded").cls);
  expect(sk.cls).not.toBe(statusBadge("failed").cls);
});

test("normalizeStatus folds unknowns to 'unknown'", () => {
  expect(normalizeStatus("succeeded")).toBe("succeeded");
  expect(normalizeStatus("SKIPPED")).toBe("skipped");
  expect(normalizeStatus("weird")).toBe("unknown");
  expect(normalizeStatus(null)).toBe("unknown");
});

// ---- Relative time ---------------------------------------------------------

test("formatRelative buckets", () => {
  expect(formatRelative(null, NOW)).toBeNull();
  expect(formatRelative(NOW - 10_000, NOW)).toBe("just now");
  expect(formatRelative(NOW - 50_000, NOW)).toBe("just now");
  expect(formatRelative(NOW - 61_000, NOW)).toBe("1m ago");
  expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe("5m ago");
  expect(formatRelative(NOW - 2 * 3600_000, NOW)).toBe("2h ago");
  expect(formatRelative(NOW - 3 * 86400_000, NOW)).toBe("3d ago");
});

// ---- Never-throws / error contract ----------------------------------------

test("huginn error ⇒ errors[] not a throw, classes still present", async () => {
  const failing = {
    fetchJobs: async () => {
      throw new Error("Knowledge API unreachable");
    },
  };
  const o = await assembleIndexingOverview(failing, NOW);
  expect(o.errors).toBeDefined();
  expect(o.errors![0]).toContain("indexing jobs:");
  expect(o.total).toBe(0);
  expect(o.classes.map((c) => c.key)).toEqual(["scheduled", "tracked", "never"]);
  expect(o.classes.every((c) => c.rows.length === 0)).toBe(true);
});

test("clean payload carries no errors key", async () => {
  const o = await assembleIndexingOverview(deps([job({ lastRun: run() })]), NOW);
  expect(o.errors).toBeUndefined();
});

test("never-tracked row: no last status, no duration", async () => {
  const o = await assembleIndexingOverview(deps([job({ collection: "capra-notion", loaded: true, lastRun: null })]), NOW);
  const row = o.classes.find((c) => c.key === "never")!.rows[0]!;
  expect(row.lastStatus).toBeNull();
  expect(row.lastRelative).toBeNull();
  expect(row.lastDuration).toBeNull();
  expect(row.loaded).toBe(true);
});

// ---- Staleness / aging / drift (row health) --------------------------------

const DAY = 24 * 60 * 60 * 1000;

function agedRun(daysAgo: number): RawRun {
  return run({ startedAt: new Date(NOW - daysAgo * DAY).toISOString() });
}

test("unscheduled row: >14d ⇒ stale (chip), fresh ⇒ quiet", () => {
  const stale = toRow(job({ schedule: null, lastRun: agedRun(20) }), NOW);
  expect(stale.stale).toBe(true);
  expect(stale.aging).toBe(false);
  expect(stale.attention).toBe("stale");

  const fresh = toRow(job({ schedule: null, lastRun: agedRun(1) }), NOW);
  expect(fresh.stale).toBe(false);
  expect(fresh.aging).toBe(false);
  expect(fresh.attention).toBeNull();
});

test("unscheduled row: 7–14d ⇒ aging (no chip)", () => {
  const aging = toRow(job({ schedule: null, lastRun: agedRun(13) }), NOW);
  expect(aging.aging).toBe(true);
  expect(aging.stale).toBe(false);
  expect(aging.attention).toBe("aging");
});

test("scheduled daily job: recent run is not stale/drifting; long gap drifts", () => {
  const sched: RawSchedule = { kind: "calendar", hour: 8, minute: 0, weekday: null };
  const ok = toRow(job({ schedule: sched, lastRun: agedRun(0.4) }), NOW);
  expect(ok.drifting).toBe(false);
  expect(ok.attention).toBeNull();

  // >2 daily cycles without a run ⇒ drifting (STALE chip via attention).
  const drift = toRow(job({ schedule: sched, lastRun: agedRun(3) }), NOW);
  expect(drift.drifting).toBe(true);
  expect(drift.attention).toBe("stale");
  // Drift is a scheduled concept — the age-band `stale` flag stays off.
  expect(drift.stale).toBe(false);
});

test("never-tracked row: quiet (no run to age)", () => {
  const r = toRow(job({ schedule: null, lastRun: null }), NOW);
  expect(r.attention).toBeNull();
  expect(r.stale).toBe(false);
  expect(r.aging).toBe(false);
  expect(r.ageMs).toBeNull();
});

test("failed last run flagged (assessRowHealth)", () => {
  const h = assessRowHealth(job({ schedule: null, lastRun: run({ status: "failed" }) }), NOW - DAY, NOW);
  expect(h.failed).toBe(true);
});

// ---- Schedule intervals / next-run projection ------------------------------

test("scheduleIntervalMs by kind", () => {
  expect(scheduleIntervalMs({ kind: "calendar", weekday: null })).toBe(DAY);
  expect(scheduleIntervalMs({ kind: "calendar", weekday: 1 })).toBe(7 * DAY);
  expect(scheduleIntervalMs({ kind: "hourly" })).toBe(60 * 60 * 1000);
  expect(scheduleIntervalMs({ kind: "interval", seconds: 300 })).toBe(300_000);
  expect(scheduleIntervalMs({ kind: "interval", seconds: 0 })).toBeNull();
  expect(scheduleIntervalMs(null)).toBeNull();
});

test("computeNextRunMs: interval advances from last start, always future", () => {
  const s: RawSchedule = { kind: "interval", seconds: 3600 };
  const lastStart = NOW - 90 * 60 * 1000; // 90m ago
  const next = computeNextRunMs(s, lastStart, NOW)!;
  expect(next).toBeGreaterThan(NOW);
  // Next fire is on the hourly cadence from the base (120m after a 90m-ago start).
  expect(next).toBe(lastStart + 2 * 3600 * 1000);
});

test("computeNextRunMs: calendar/hourly return a future time", () => {
  expect(computeNextRunMs({ kind: "calendar", hour: 8, minute: 0, weekday: null }, null, NOW)!).toBeGreaterThan(NOW);
  expect(computeNextRunMs({ kind: "hourly", minute: 30 }, null, NOW)!).toBeGreaterThan(NOW);
  const weekly = computeNextRunMs({ kind: "calendar", hour: 9, minute: 0, weekday: 1 }, null, NOW)!;
  expect(weekly).toBeGreaterThan(NOW);
  expect(new Date(weekly).getDay()).toBe(1); // a Monday
});

test("computeNextRunMs: unscheduled ⇒ null", () => {
  expect(computeNextRunMs(null, NOW, NOW)).toBeNull();
});

test("formatCountdown buckets", () => {
  expect(formatCountdown(null, NOW)).toBeNull();
  expect(formatCountdown(NOW - 1000, NOW)).toBe("due now");
  expect(formatCountdown(NOW + 45 * 60_000, NOW)).toBe("in 45m");
  expect(formatCountdown(NOW + (18 * 60 + 40) * 60_000, NOW)).toBe("in 18h 40m");
  expect(formatCountdown(NOW + 3 * 60 * 60_000, NOW)).toBe("in 3h");
  expect(formatCountdown(NOW + (3 * 24 + 4) * 60 * 60_000, NOW)).toBe("in 3d 4h");
});

test("formatAge short labels", () => {
  expect(formatAge(null)).toBeNull();
  expect(formatAge(5 * 60_000)).toBe("5m");
  expect(formatAge(5 * 60 * 60_000)).toBe("5h");
  expect(formatAge(69 * DAY)).toBe("69d");
});

// ---- Summary tiles ---------------------------------------------------------

test("computeTiles: healthy count excludes stale/aging/drift, names worst stale", () => {
  const rows = [
    toRow(job({ collection: "fresh-1", schedule: null, lastRun: agedRun(1) }), NOW),
    toRow(job({ collection: "fresh-2", schedule: null, lastRun: agedRun(2) }), NOW),
    toRow(job({ collection: "aging-1", schedule: null, lastRun: agedRun(10) }), NOW),
    toRow(job({ collection: "stale-old", schedule: null, lastRun: agedRun(69) }), NOW),
    toRow(job({ collection: "stale-new", schedule: null, lastRun: agedRun(20) }), NOW),
    toRow(job({ collection: "never", schedule: null, lastRun: null }), NOW),
  ];
  const tiles = computeTiles(rows, NOW);
  const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t]));

  // 6 rows: 2 fresh + 1 never = 3 healthy (aging + 2 stale excluded).
  expect(byLabel.Healthy!.value).toBe("3 / 6");
  expect(byLabel.Healthy!.tone).toBeUndefined();

  expect(byLabel.Stale!.value).toBe("2");
  expect(byLabel.Stale!.tone).toBe("warning");
  expect(byLabel.Stale!.sub).toBe("stale-old · 69d"); // worst offender

  expect(byLabel.Drift!.value).toBe("0");
  expect(byLabel.Drift!.tone).toBeUndefined();
  expect(byLabel.Drift!.sub).toBe("all schedules on time");
});

test("computeTiles: clean board ⇒ no warning tones, Stale sub 'all fresh'", () => {
  const rows = [toRow(job({ collection: "ok", schedule: null, lastRun: agedRun(1) }), NOW)];
  const tiles = computeTiles(rows, NOW);
  const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t]));
  expect(byLabel.Stale!.value).toBe("0");
  expect(byLabel.Stale!.tone).toBeUndefined();
  expect(byLabel.Stale!.sub).toBe("all fresh");
});

test("computeTiles: Running tile shows soonest next fire when idle", () => {
  const rows = [
    toRow(job({ collection: "daily", schedule: { kind: "calendar", hour: 8, minute: 0, weekday: null }, lastRun: agedRun(0.3) }), NOW),
  ];
  const tiles = computeTiles(rows, NOW);
  const running = tiles.find((t) => t.label === "Running")!;
  expect(running.value).toBe("0");
  expect(running.tone).toBeUndefined();
  expect(running.sub).toMatch(/^next: daily · in /);
});

test("computeTiles: Running tile toned success with a live run", () => {
  const rows = [
    toRow(
      job({
        collection: "busy",
        schedule: null,
        current: run({ status: "running", durationSeconds: null, finishedAt: null, startedAt: new Date(NOW - 40_000).toISOString() }),
      }),
      NOW,
    ),
  ];
  const running = computeTiles(rows, NOW).find((t) => t.label === "Running")!;
  expect(running.value).toBe("1");
  expect(running.tone).toBe("success");
  expect(running.sub).toContain("busy");
});

test("overview payload carries the four tiles", async () => {
  const o = await assembleIndexingOverview(deps([job({ lastRun: run() })]), NOW);
  expect(o.tiles.map((t) => t.label)).toEqual(["Healthy", "Stale", "Drift", "Running"]);
});
