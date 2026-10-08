/**
 * The retention cleanup's order and failure isolation, and its timer: off with
 * the scheduler kill switch, one run at a time, a stop that waits for it.
 * The four DB functions are injected, so no database is needed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import {
  RETENTION_CLEANUP_STATEMENT_TIMEOUT_MS,
  RETENTION_CLEANUP_STOP_WAIT_MS,
  retentionCleanupBootLine,
  runRetentionCleanup,
  startRetentionCleanup,
  stopRetentionCleanup,
  type RetentionCleanupDeps,
} from "./retention-cleanup.ts";
import { BatchedDeleteError } from "../db/batched-delete.ts";

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

  test("every statement is passed the Postgres statement timeout", async () => {
    const seen: Record<string, unknown> = {};
    const deps: RetentionCleanupDeps = {
      harvestSearchSignals: async (opts) => ((seen.harvest = opts), 0),
      cleanupOldTraces: async (_d, opts) => ((seen.traces = opts), 0),
      cleanupOldSnapshots: async (_w, opts) => ((seen.snapshots = opts), 0),
      cleanupThreadCitations: async (_d, opts) => ((seen.citations = opts), 0),
    };
    await runRetentionCleanup(CONFIG, deps);
    const bound = { statementTimeoutMs: RETENTION_CLEANUP_STATEMENT_TIMEOUT_MS };
    // The deletes also get the stop flag, checked between their batches.
    const withStop = { ...bound, shouldStop: expect.any(Function) };
    expect(seen).toEqual({ harvest: bound, traces: withStop, snapshots: withStop, citations: withStop });
    expect(RETENTION_CLEANUP_STATEMENT_TIMEOUT_MS).toBe(300_000);
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

  test("a failed batched delete logs the rows its committed batches removed", async () => {
    const records = await capture();
    const fail = (n: number) => async () => {
      throw new BatchedDeleteError(n, new Error(`boom ${n}`));
    };
    const { deps } = recordingDeps({ cleanupOldTraces: fail(3), cleanupOldSnapshots: fail(4), cleanupThreadCitations: fail(5) });
    await runRetentionCleanup(CONFIG, deps);
    const errors = records.filter((r) => r.level === "error").map((r) => r.properties);
    expect(errors).toEqual([
      { count: 3, error: "boom 3" },
      { count: 4, error: "boom 4" },
      { count: 5, error: "boom 5" },
    ]);
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

  test("a stop during a run skips the steps after the one in flight, and the deletes see the flag", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const flags: boolean[] = [];
    const { deps, calls } = recordingDeps({
      harvestSearchSignals: async () => {
        await gate;
        return 0;
      },
    });
    const traces = deps.cleanupOldTraces;
    deps.cleanupOldTraces = (async (d: number, opts?: { shouldStop?: () => boolean }) => {
      flags.push(opts?.shouldStop?.() ?? false);
      return traces(d, opts as never);
    }) as RetentionCleanupDeps["cleanupOldTraces"];
    startRetentionCleanup(CONFIG, { deps, firstDelayMs: 0, intervalMs: 60_000 });
    try {
      await Bun.sleep(30);
      await stopRetentionCleanup(10);
    } finally {
      release();
    }
    await Bun.sleep(30);
    expect(calls).toEqual(["harvestSearchSignals"]);
    expect(flags).toEqual([]);
  });

  test("a stop during the trace delete skips the snapshot and citation deletes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, calls } = recordingDeps({
      cleanupOldTraces: async () => {
        await gate;
        return 0;
      },
    });
    startRetentionCleanup(CONFIG, { deps, firstDelayMs: 0, intervalMs: 60_000 });
    try {
      await Bun.sleep(30);
      await stopRetentionCleanup(10);
    } finally {
      release();
    }
    await Bun.sleep(30);
    expect(calls).toEqual(["harvestSearchSignals", "cleanupOldTraces"]);
  });

  test("each delete is handed the LIVE stop flag: false while running, true once stop is called", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let flag: (() => boolean) | undefined;
    const { deps } = recordingDeps();
    deps.cleanupOldTraces = (async (_d: number, opts?: { shouldStop?: () => boolean }) => {
      flag = opts?.shouldStop;
      await gate;
      return 0;
    }) as RetentionCleanupDeps["cleanupOldTraces"];
    startRetentionCleanup(CONFIG, { deps, firstDelayMs: 0, intervalMs: 60_000 });
    try {
      await Bun.sleep(30);
      expect(flag?.()).toBe(false);
      await stopRetentionCleanup(10);
      expect(flag?.()).toBe(true);
    } finally {
      release();
    }
  });

  test("a start after a stop that timed out does not revive the old run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, calls } = recordingDeps({
      harvestSearchSignals: async () => {
        await gate;
        return 0;
      },
    });
    startRetentionCleanup(CONFIG, { deps, firstDelayMs: 0, intervalMs: 60_000 });
    try {
      await Bun.sleep(30);
      await stopRetentionCleanup(10); // times out: the harvest is still waiting
      // A restart in the same process, before the old run has finished.
      startRetentionCleanup(CONFIG, { deps: recordingDeps().deps, firstDelayMs: 60_000, intervalMs: 60_000 });
    } finally {
      release();
    }
    await Bun.sleep(30);
    expect(calls, "the old run must stay stopped").toEqual(["harvestSearchSignals"]);
  });

  test("a later start after a stop runs again (the stop flag resets)", async () => {
    const { deps } = recordingDeps();
    startRetentionCleanup(CONFIG, { deps, firstDelayMs: 0, intervalMs: 60_000 });
    await Bun.sleep(30);
    await stopRetentionCleanup();
    const second = recordingDeps();
    startRetentionCleanup(CONFIG, { deps: second.deps, firstDelayMs: 0, intervalMs: 60_000 });
    await Bun.sleep(30);
    expect(second.calls).toEqual(["harvestSearchSignals", "cleanupOldTraces", "cleanupOldSnapshots", "cleanupThreadCitations"]);
  });

  test("the stop waits at most a few seconds for a run in flight", () => {
    expect(RETENTION_CLEANUP_STOP_WAIT_MS).toBeLessThanOrEqual(5_000);
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
