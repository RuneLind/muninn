import { test, expect } from "bun:test";
import {
  buildIndexingDetail,
  buildPhaseTimeline,
  buildSparkline,
} from "./indexing-detail.ts";
import type { RawJob, RawPhase, RawRun } from "./indexing-overview.ts";

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
    ...over,
  };
}

function phase(over: Partial<RawPhase> = {}): RawPhase {
  return { name: "reindex", status: "succeeded", durationSeconds: 5, fatal: true, ...over };
}

// ---- Phase timeline: ordered (huginn #92+) --------------------------------

test("ordered timeline: sorts phases chronologically by startedAt", () => {
  // Deliberately out of order in the input — the derivation must sort.
  const r = run({
    phases: [
      phase({ name: "reindex", startedAt: "2026-07-20T10:05:15Z", durationSeconds: 8, fatal: true }),
      phase({ name: "fetch", startedAt: "2026-07-20T10:05:05Z", durationSeconds: 5, fatal: true }),
      phase({ name: "relevance", startedAt: "2026-07-20T10:05:11Z", durationSeconds: 4, fatal: false }),
      phase({ name: "author_graph", startedAt: "2026-07-20T10:05:10Z", durationSeconds: 1, fatal: false }),
    ],
  });
  const t = buildPhaseTimeline(r);
  expect(t.kind).toBe("ordered");
  expect(t.phases.map((p) => p.name)).toEqual(["fetch", "author_graph", "relevance", "reindex"]);
  expect(t.phases.every((p) => p.startedAtMs != null)).toBe(true);
  // Strictly ascending start times.
  const ms = t.phases.map((p) => p.startedAtMs!);
  expect(ms).toEqual([...ms].sort((a, b) => a - b));
  expect(t.phases[0]!.duration).toBe("5s");
});

// ---- Phase timeline: unordered (mixed pre-#92 data) -----------------------

test("unordered timeline: ANY phase missing startedAt ⇒ arrival order, no axis", () => {
  const r = run({
    phases: [
      phase({ name: "fetch", startedAt: "2026-07-20T10:05:05Z" }),
      phase({ name: "reindex", startedAt: undefined }), // missing
    ],
  });
  const t = buildPhaseTimeline(r);
  expect(t.kind).toBe("unordered");
  // Arrival order preserved (NOT sorted).
  expect(t.phases.map((p) => p.name)).toEqual(["fetch", "reindex"]);
  // No time axis is asserted — all startedAtMs dropped to null on this path.
  expect(t.phases.every((p) => p.startedAtMs == null)).toBe(true);
});

test("single reindex-only phase with no startedAt ⇒ unordered, not none", () => {
  // Live shape: anthropic-knowledge lastRun phases = [{reindex, no startedAt}].
  const t = buildPhaseTimeline(run({ phases: [phase({ startedAt: undefined })] }));
  expect(t.kind).toBe("unordered");
  expect(t.phases).toHaveLength(1);
});

// ---- Phase timeline: none (backfilled, no phases) -------------------------

test("backfilled run (empty phases) ⇒ 'none', not an empty ordered list", () => {
  const t = buildPhaseTimeline(run({ trigger: "unknown", phases: [] }));
  expect(t.kind).toBe("none");
  expect(t.phases).toEqual([]);
});

test("run with absent phases ⇒ 'none'", () => {
  const t = buildPhaseTimeline(run({ phases: undefined }));
  expect(t.kind).toBe("none");
});

test("null run ⇒ 'none'", () => {
  expect(buildPhaseTimeline(null).kind).toBe("none");
});

// ---- Degraded visibility: failed non-fatal phase --------------------------

test("degraded run: failed non-fatal phase is flagged visible", () => {
  const r = run({
    status: "degraded",
    phases: [
      phase({ name: "fetch", status: "succeeded", startedAt: "2026-07-20T10:00:01Z", fatal: true }),
      phase({ name: "author_graph", status: "failed", startedAt: "2026-07-20T10:00:05Z", fatal: false }),
      phase({ name: "reindex", status: "succeeded", startedAt: "2026-07-20T10:00:07Z", fatal: true }),
    ],
  });
  const t = buildPhaseTimeline(r);
  const bad = t.phases.find((p) => p.name === "author_graph")!;
  expect(bad.status.status).toBe("failed");
  expect(bad.fatal).toBe(false);
  expect(bad.nonFatalFailure).toBe(true);
  // A fatal succeeded phase is not flagged.
  expect(t.phases.find((p) => p.name === "reindex")!.nonFatalFailure).toBe(false);
});

test("failed FATAL phase is not a non-fatal failure", () => {
  const t = buildPhaseTimeline(
    run({ phases: [phase({ name: "fetch", status: "failed", fatal: true, startedAt: "2026-07-20T10:00:01Z" })] }),
  );
  expect(t.phases[0]!.nonFatalFailure).toBe(false);
});

// ---- Sparkline -------------------------------------------------------------

test("sparkline: null durations stay null (never coerced to 0)", () => {
  const s = buildSparkline([
    run({ startedAt: "2026-07-20T10:00:00Z", durationSeconds: 10, status: "succeeded" }),
    run({ startedAt: "2026-07-20T11:00:00Z", durationSeconds: null, status: "failed" }),
  ]);
  expect(s.points).toHaveLength(2);
  expect(s.points[1]!.durationSeconds).toBeNull();
  expect(s.points[1]!.duration).toBeNull();
  expect(s.points[1]!.status.status).toBe("failed");
  // maxDuration ignores the null.
  expect(s.maxDurationSeconds).toBe(10);
});

test("sparkline: distinguishes variants with stable first-seen indices", () => {
  const s = buildSparkline([
    run({ startedAt: "2026-07-20T08:00:00Z", variant: "incremental", durationSeconds: 10 }),
    run({ startedAt: "2026-07-20T09:00:00Z", variant: "rebuild", durationSeconds: 83 }),
    run({ startedAt: "2026-07-20T10:00:00Z", variant: "incremental", durationSeconds: 9 }),
  ]);
  expect(s.variants).toEqual(["incremental", "rebuild"]);
  expect(s.points.map((p) => p.variant)).toEqual(["incremental", "rebuild", "incremental"]);
  expect(s.points.map((p) => p.variantIndex)).toEqual([0, 1, 0]);
  expect(s.maxDurationSeconds).toBe(83);
});

test("sparkline: sorts oldest-first, null starts sort last (stable)", () => {
  const s = buildSparkline([
    run({ runId: "b", startedAt: "2026-07-20T11:00:00Z", durationSeconds: 2 }),
    run({ runId: "no-ts", startedAt: null, durationSeconds: 3 }),
    run({ runId: "a", startedAt: "2026-07-20T10:00:00Z", durationSeconds: 1 }),
  ]);
  // a (10:00) before b (11:00); the null-start point lands last.
  expect(s.points.map((p) => p.durationSeconds)).toEqual([1, 2, 3]);
  expect(s.points[2]!.startedAtMs).toBeNull();
});

test("sparkline: empty history ⇒ no points, null max", () => {
  const s = buildSparkline([]);
  expect(s.points).toEqual([]);
  expect(s.variants).toEqual([]);
  expect(s.maxDurationSeconds).toBeNull();
});

// ---- Combined detail + in-flight current ----------------------------------

test("buildIndexingDetail: assembles timeline, sparkline, and null current when idle", () => {
  const job: RawJob = {
    collection: "x-feed",
    loaded: true,
    job: null,
    schedule: null,
    current: null,
    lastRun: run({ phases: [phase({ startedAt: "2026-07-20T10:00:01Z" })] }),
    history: [run({ durationSeconds: 10 })],
    medianDurationSeconds: { incremental: 10 },
  };
  const d = buildIndexingDetail(job);
  expect(d.lastTimeline.kind).toBe("ordered"); // single phase, has startedAt ⇒ ordered
  expect(d.sparkline.points).toHaveLength(1);
  expect(d.current).toBeNull();
});

test("buildIndexingDetail: in-flight current carries its phases-so-far", () => {
  const job: RawJob = {
    collection: "x-feed",
    loaded: true,
    job: null,
    schedule: null,
    current: run({
      status: "running",
      durationSeconds: null,
      finishedAt: null,
      phases: [phase({ name: "fetch", status: "succeeded", startedAt: "2026-07-20T10:05:05Z" })],
    }),
    lastRun: null,
    history: [],
    medianDurationSeconds: {},
  };
  const d = buildIndexingDetail(job);
  expect(d.current).not.toBeNull();
  expect(d.current!.kind).toBe("ordered");
  expect(d.current!.phases[0]!.name).toBe("fetch");
});
