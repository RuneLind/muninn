/**
 * The retention cleanup's order and failure isolation, and its timer: off with
 * the scheduler kill switch, one run at a time, a stop that waits for it.
 * The four DB functions are injected, so no database is needed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import {
  retentionCleanupBootLine,
  runRetentionCleanup,
  startRetentionCleanup,
  stopRetentionCleanup,
  type RetentionCleanupDeps,
} from "./retention-cleanup.ts";

afterEach(async () => {
  await stopRetentionCleanup();
  await reset();
});

const CONFIG = {
  schedulerEnabled: true,
  tracingRetentionDays: 7,
  promptSnapshotsRetentionDays: 3,
  promptSnapshotsCaptureRetentionDays: 90,
};

function recordingDeps(overrides: Partial<Record<keyof RetentionCleanupDeps, () => Promise<number>>> = {}) {
  const calls: string[] = [];
  const args: Record<string, unknown> = {};
  const make =
    (name: keyof RetentionCleanupDeps) =>
    async (arg?: unknown): Promise<number> => {
      calls.push(name);
      args[name] = arg;
      return overrides[name] ? overrides[name]!() : 1;
    };
  const deps = {
    harvestSearchSignals: make("harvestSearchSignals"),
    cleanupOldTraces: make("cleanupOldTraces"),
    cleanupOldSnapshots: make("cleanupOldSnapshots"),
    cleanupThreadCitations: make("cleanupThreadCitations"),
  } as unknown as RetentionCleanupDeps;
  return { deps, calls, args };
}

async function capture(): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (r: LogRecord) => records.push(r) },
    loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
    reset: true,
  });
  return records;
}

describe("runRetentionCleanup", () => {
  test("harvests before the trace delete, then snapshots and citations, with the configured windows", async () => {
    const { deps, calls, args } = recordingDeps();
    await runRetentionCleanup(CONFIG, deps);
    expect(calls).toEqual(["harvestSearchSignals", "cleanupOldTraces", "cleanupOldSnapshots", "cleanupThreadCitations"]);
    expect(args.cleanupOldTraces).toBe(7);
    expect(args.cleanupOldSnapshots).toEqual({ chatDays: 3, captureDays: 90 });
    expect(args.cleanupThreadCitations).toBe(7);
  });

  test("a harvest failure is logged and the three deletes still run", async () => {
    const records = await capture();
    const { deps, calls } = recordingDeps({
      harvestSearchSignals: async () => {
        throw new Error("harvest boom");
      },
    });
    await runRetentionCleanup(CONFIG, deps);
    expect(calls).toEqual(["harvestSearchSignals", "cleanupOldTraces", "cleanupOldSnapshots", "cleanupThreadCitations"]);
    expect(records.some((r) => r.level === "error" && r.properties.error === "harvest boom")).toBe(true);
  });

  test("a trace-delete failure is logged and does not reject the run", async () => {
    const records = await capture();
    const { deps } = recordingDeps({
      cleanupOldTraces: async () => {
        throw new Error("trace boom");
      },
    });
    await expect(runRetentionCleanup(CONFIG, deps)).resolves.toBeUndefined();
    expect(records.some((r) => r.level === "error" && r.properties.error === "trace boom")).toBe(true);
  });

  test("a trace-delete failure still runs the snapshot and citation deletes", async () => {
    const { deps, calls } = recordingDeps({
      cleanupOldTraces: async () => {
        throw new Error("trace boom");
      },
    });
    await runRetentionCleanup(CONFIG, deps);
    expect(calls).toEqual(["harvestSearchSignals", "cleanupOldTraces", "cleanupOldSnapshots", "cleanupThreadCitations"]);
  });

  test("a snapshot-delete failure is logged and still runs the citation delete", async () => {
    const records = await capture();
    const { deps, calls } = recordingDeps({
      cleanupOldSnapshots: async () => {
        throw new Error("snapshot boom");
      },
    });
    await runRetentionCleanup(CONFIG, deps);
    expect(calls).toEqual(["harvestSearchSignals", "cleanupOldTraces", "cleanupOldSnapshots", "cleanupThreadCitations"]);
    expect(records.some((r) => r.level === "error" && r.properties.error === "snapshot boom")).toBe(true);
  });

  test("log lines carry counts only: no per-bot property", async () => {
    const records = await capture();
    const { deps } = recordingDeps();
    await runRetentionCleanup(CONFIG, deps);
    const lines = records.filter((r) => r.category.includes("retention"));
    expect(lines.length).toBe(4);
    for (const l of lines) expect(l.properties).toEqual({ count: 1 });
  });

  test("the boot line names every window", () => {
    expect(retentionCleanupBootLine(CONFIG)).toBe(
      "Retention cleanup on (hourly): traces and thread citations 7 day(s), chat prompt snapshots 3, capture snapshots 90",
    );
  });
});

describe("startRetentionCleanup", () => {
  test("SCHEDULER_ENABLED=false ⇒ no timer starts", async () => {
    const { deps, calls } = recordingDeps();
    expect(startRetentionCleanup({ ...CONFIG, schedulerEnabled: false }, { deps, firstDelayMs: 0, intervalMs: 5 })).toBe(false);
    await Bun.sleep(30);
    expect(calls).toEqual([]);
  });

  test("first run after the delay, then on the interval; a second start is a no-op", async () => {
    const { deps, calls } = recordingDeps();
    expect(startRetentionCleanup(CONFIG, { deps, firstDelayMs: 40, intervalMs: 10_000 })).toBe(true);
    // Idempotent: this second start must not add timers of its own.
    expect(startRetentionCleanup(CONFIG, { deps, firstDelayMs: 0, intervalMs: 5 })).toBe(true);
    await Bun.sleep(15);
    expect(calls.length).toBe(0);
    await Bun.sleep(60);
    expect(calls.filter((c) => c === "cleanupOldTraces").length).toBe(1);
    await stopRetentionCleanup();

    const second = recordingDeps();
    startRetentionCleanup(CONFIG, { deps: second.deps, firstDelayMs: 10_000, intervalMs: 20 });
    await Bun.sleep(70);
    expect(second.calls.filter((c) => c === "cleanupOldTraces").length).toBeGreaterThanOrEqual(2);
  });

  test("a tick while a run is in flight is skipped, and stop waits for the run and ends further ticks", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps } = recordingDeps({
      harvestSearchSignals: async () => {
        runs++;
        await gate;
        return 0;
      },
    });
    startRetentionCleanup(CONFIG, { deps, firstDelayMs: 0, intervalMs: 5 });
    try {
      await Bun.sleep(80);
      expect(runs).toBe(1);

      let stopped = false;
      const stop = stopRetentionCleanup().then(() => (stopped = true));
      await Bun.sleep(30);
      expect(stopped).toBe(false);
      release();
      await stop;
      expect(stopped).toBe(true);
      await Bun.sleep(30);
      expect(runs).toBe(1);
    } finally {
      release();
    }
  });

  test("a tick skipped because a run is in flight logs a warning", async () => {
    const records = await capture();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps } = recordingDeps({
      harvestSearchSignals: async () => {
        await gate;
        return 0;
      },
    });
    startRetentionCleanup(CONFIG, { deps, firstDelayMs: 0, intervalMs: 10 });
    try {
      await Bun.sleep(50);
      expect(records.some((r) => r.level === "warning" && r.message.join("").includes("still in flight"))).toBe(true);
    } finally {
      release();
    }
  });

  test("a run that hangs past the run bound is abandoned with a warning, and the next tick runs again", async () => {
    const records = await capture();
    let runs = 0;
    let release!: () => void;
    const never = new Promise<void>((r) => (release = r));
    const { deps } = recordingDeps({
      harvestSearchSignals: async () => {
        runs++;
        if (runs === 1) await never;
        return 0;
      },
    });
    startRetentionCleanup(CONFIG, { deps, firstDelayMs: 0, intervalMs: 60, runTimeoutMs: 20 });
    try {
      await Bun.sleep(150);
      expect(runs).toBeGreaterThanOrEqual(2);
      expect(records.some((r) => r.level === "warning" && r.message.join("").includes("timed out after"))).toBe(true);
    } finally {
      release();
    }
  });

  test("a timed-out run that settles late does not free the slot of the newer run in flight", async () => {
    let runs = 0;
    let releaseFirst!: () => void;
    const first = new Promise<void>((r) => (releaseFirst = r));
    const never = new Promise<void>(() => {});
    const { deps } = recordingDeps({
      harvestSearchSignals: async () => {
        runs++;
        await (runs === 1 ? first : never);
        return 0;
      },
    });
    // Run 1 at 0 ms, abandoned at 100; run 2 at 300, abandoned at 400.
    startRetentionCleanup(CONFIG, { deps, firstDelayMs: 0, intervalMs: 300, runTimeoutMs: 100 });
    try {
      await Bun.sleep(320);
      expect(runs).toBe(2);
      releaseFirst(); // run 1 settles late, while run 2 holds the slot
      await Bun.sleep(10);
      // Stop must still wait for run 2 (until its bound at ~400 ms), not return at once.
      const t0 = performance.now();
      await stopRetentionCleanup(1_000);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(40);
    } finally {
      releaseFirst();
    }
  });

  test("a run that never finishes: stop returns after its bound", async () => {
    let release!: () => void;
    const never = new Promise<void>((r) => (release = r));
    const { deps } = recordingDeps({
      harvestSearchSignals: async () => {
        await never;
        return 0;
      },
    });
    startRetentionCleanup(CONFIG, { deps, firstDelayMs: 0, intervalMs: 60_000 });
    try {
      await Bun.sleep(30);
      const t0 = performance.now();
      await stopRetentionCleanup(100);
      const waited = performance.now() - t0;
      expect(waited).toBeGreaterThanOrEqual(90);
      expect(waited).toBeLessThan(1_000);
    } finally {
      release();
      await Bun.sleep(10);
    }
  });
});
