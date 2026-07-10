import { test, expect, describe, beforeEach } from "bun:test";
import {
  selectBacklogBatch,
  assembleBacklog,
  runExclusive,
  gardenerRunInFlight,
  startBacklogRun,
  resetBacklogOffered,
  draftedCount,
  getBacklogProgress,
  requestBacklogCancel,
  __resetGardenerMutexForTest,
  BACKLOG_BATCH_SIZE,
  type AssembleBacklogDeps,
  type AssembledBacklog,
} from "./backlog.ts";
import type { QueuedDoc } from "../wiki/ingest-backlog.ts";
import type { WatcherAlert } from "../types.ts";

// ── selectBacklogBatch ───────────────────────────────────────────────────────

describe("selectBacklogBatch", () => {
  function qd(collection: string, id: string, date?: string): QueuedDoc {
    return { collection, id, url: `https://x/${id}`, ...(date ? { date } : {}) };
  }

  test("selects newest-first by listing date", () => {
    const docs = [
      qd("c", "a", "2026-01-01"),
      qd("c", "b", "2026-03-01"),
      qd("c", "d", "2026-02-01"),
    ];
    const batch = selectBacklogBatch(docs, new Set());
    expect(batch.map((b) => b.id)).toEqual(["b", "d", "a"]);
    expect(batch.map((b) => b.key)).toEqual(["c/b", "c/d", "c/a"]);
  });

  test("undated docs sort last", () => {
    const docs = [qd("c", "undated"), qd("c", "dated", "2026-05-01")];
    const batch = selectBacklogBatch(docs, new Set());
    expect(batch.map((b) => b.id)).toEqual(["dated", "undated"]);
  });

  test("excludes already-offered keys", () => {
    const docs = [qd("c", "a", "2026-03-01"), qd("c", "b", "2026-02-01"), qd("c", "d", "2026-01-01")];
    const batch = selectBacklogBatch(docs, new Set(["c/b"]));
    expect(batch.map((b) => b.key)).toEqual(["c/a", "c/d"]);
  });

  test("caps at the batch size", () => {
    const docs = Array.from({ length: 5 }, (_, i) => qd("c", `d${i}`, `2026-01-0${i + 1}`));
    const batch = selectBacklogBatch(docs, new Set(), 2);
    expect(batch).toHaveLength(2);
    // Newest two (d4, d3).
    expect(batch.map((b) => b.id)).toEqual(["d4", "d3"]);
  });

  test("default batch size is BACKLOG_BATCH_SIZE", () => {
    const docs = Array.from({ length: BACKLOG_BATCH_SIZE + 10 }, (_, i) =>
      qd("c", `d${i}`, `2026-01-01`),
    );
    expect(selectBacklogBatch(docs, new Set())).toHaveLength(BACKLOG_BATCH_SIZE);
  });
});

// ── assembleBacklog (consumed-complement + selection) ────────────────────────

describe("assembleBacklog", () => {
  function baseDeps(overrides?: Partial<AssembleBacklogDeps>): AssembleBacklogDeps {
    return {
      botName: "jarvis",
      wikiDir: "/tmp/wiki",
      apiUrl: "http://x",
      listCollections: async () => ({
        byCollection: {
          "youtube-summaries": [
            { id: "y1", url: "https://youtu.be/y1", date: "2026-06-03" }, // queued
            { id: "y2", url: "https://youtu.be/y2", date: "2026-06-02" }, // consumed
            { id: "y3", url: "https://youtu.be/y3", date: "2026-06-01" }, // queued
          ],
          "x-articles": [],
          "anthropic-summaries": [],
          "tiktok-summaries": [],
        },
        errors: [],
      }),
      sweepWikiUrls: async () => new Set<string>(),
      getConsumed: async () => new Set<string>(["youtube-summaries/y2"]),
      getPending: async () => new Set<string>(),
      getOffered: async () => new Set<string>(),
      ...overrides,
    };
  }

  test("batch is the queued docs newest-first; consumed-complement is everything else", async () => {
    const a = await assembleBacklog(baseDeps());
    // y2 is consumed (not queued); y1 + y3 are queued, newest-first.
    expect(a.batchKeys).toEqual(["youtube-summaries/y1", "youtube-summaries/y3"]);
    expect(a.queuedCount).toBe(2);
    // consumed-complement = every LISTED key except the batch → y2 only.
    expect([...a.consumedComplement].sort()).toEqual(["youtube-summaries/y2"]);
    // The full listing snapshot is retained for the memoized listDocs seam.
    expect(a.listedBySource["youtube-summaries"]).toHaveLength(3);
  });

  test("already-offered queued docs are dropped from the batch but stay listed", async () => {
    const a = await assembleBacklog(
      baseDeps({ getOffered: async () => new Set(["youtube-summaries/y1"]) }),
    );
    expect(a.batchKeys).toEqual(["youtube-summaries/y3"]);
    // y1 is offered (not selected) → it lands in the consumed-complement so harvest skips it.
    expect(a.consumedComplement.has("youtube-summaries/y1")).toBe(true);
    expect(a.consumedComplement.has("youtube-summaries/y3")).toBe(false);
    expect(a.offeredBefore.has("youtube-summaries/y1")).toBe(true);
  });
});

// ── mutex ────────────────────────────────────────────────────────────────────

describe("runExclusive (per-bot gardener mutex)", () => {
  beforeEach(() => __resetGardenerMutexForTest());

  test("second call while a run is in flight returns null", () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = runExclusive("jarvis", () => gate);
    expect(first).not.toBeNull();
    expect(gardenerRunInFlight("jarvis")).toBe(true);
    const second = runExclusive("jarvis", async () => "x");
    expect(second).toBeNull();
    release();
  });

  test("mutex is released after the run settles", async () => {
    await runExclusive("jarvis", async () => "done");
    expect(gardenerRunInFlight("jarvis")).toBe(false);
  });

  test("mutex is released even when the run throws", async () => {
    const p = runExclusive("jarvis", async () => {
      throw new Error("boom");
    });
    await expect(p!).rejects.toThrow("boom");
    expect(gardenerRunInFlight("jarvis")).toBe(false);
  });

  test("different bots don't block each other", () => {
    const a = runExclusive("jarvis", () => new Promise<void>(() => {}));
    const b = runExclusive("melosys", () => new Promise<void>(() => {}));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });
});

// ── draftedCount ─────────────────────────────────────────────────────────────

describe("draftedCount", () => {
  test("counts comma-separated proposal ids in the alert", () => {
    const alerts: WatcherAlert[] = [{ id: "wiki-gardener:a,b,c", source: "wiki-gardener", summary: "", urgency: "low" }];
    expect(draftedCount(alerts)).toBe(3);
  });
  test("zero for no alerts (nothing clustered)", () => {
    expect(draftedCount([])).toBe(0);
  });
  test("zero for an empty id list", () => {
    expect(draftedCount([{ id: "wiki-gardener:", source: "wiki-gardener", summary: "", urgency: "low" }])).toBe(0);
  });
});

// ── startBacklogRun orchestration ────────────────────────────────────────────

describe("startBacklogRun", () => {
  beforeEach(() => __resetGardenerMutexForTest());

  const assembled: AssembledBacklog = {
    listedBySource: {},
    batchKeys: ["c/a", "c/b"],
    consumedComplement: new Set(),
    offeredBefore: new Set(["c/z"]),
    queuedCount: 5,
  };

  test("no watcher → no-watcher (offered memory needs the FK)", () => {
    const r = startBacklogRun({
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: false,
      assemble: async () => assembled,
      persistOffered: async () => {},
      runGardener: async () => [],
      recordLastRun: () => {},
    });
    expect(r.state).toBe("no-watcher");
  });

  test("gardener disabled → disabled", () => {
    const r = startBacklogRun({
      botName: "jarvis",
      gardenerEnabled: false,
      hasWatcher: true,
      assemble: async () => assembled,
      persistOffered: async () => {},
      runGardener: async () => [],
      recordLastRun: () => {},
    });
    expect(r.state).toBe("disabled");
  });

  test("persists the offered union BEFORE running the gardener, records the outcome", async () => {
    const calls: string[] = [];
    let persistedKeys: string[] = [];
    let recorded: { offered: number; drafted: number } | null = null;

    const r = startBacklogRun({
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => {
        calls.push("assemble");
        return assembled;
      },
      persistOffered: async (keys) => {
        calls.push("persist");
        persistedKeys = keys;
      },
      runGardener: async () => {
        calls.push("run");
        return [{ id: "wiki-gardener:p1,p2", source: "wiki-gardener", summary: "", urgency: "low" }];
      },
      recordLastRun: (rec) => {
        recorded = rec;
      },
    });

    expect(r.state).toBe("started");
    // Let the detached run settle.
    await new Promise((res) => setTimeout(res, 10));

    expect(calls).toEqual(["assemble", "persist", "run"]);
    // Union of offeredBefore (c/z) + the batch keys (c/a, c/b), deduped.
    expect([...persistedKeys].sort()).toEqual(["c/a", "c/b", "c/z"]);
    expect(recorded).not.toBeNull();
    expect(recorded!.offered).toBe(2);
    expect(recorded!.drafted).toBe(2);
    expect(gardenerRunInFlight("jarvis")).toBe(false);
  });

  test("a second start while the first is in flight returns running (no duplicate run)", async () => {
    let releaseRun!: () => void;
    const runGate = new Promise<WatcherAlert[]>((res) => (releaseRun = () => res([])));
    let runCount = 0;

    const deps = {
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => assembled,
      persistOffered: async () => {},
      runGardener: async () => {
        runCount++;
        return runGate;
      },
      recordLastRun: () => {},
    };

    const first = startBacklogRun(deps);
    expect(first.state).toBe("started");
    const second = startBacklogRun(deps);
    expect(second.state).toBe("running");

    releaseRun();
    await new Promise((res) => setTimeout(res, 10));
    expect(runCount).toBe(1);
  });

  test("records an error outcome + releases the mutex when the run throws", async () => {
    let recorded: { error?: string } | null = null;
    const r = startBacklogRun({
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => assembled,
      persistOffered: async () => {},
      runGardener: async () => {
        throw new Error("draft blew up");
      },
      recordLastRun: (rec) => {
        recorded = rec;
      },
    });
    expect(r.state).toBe("started");
    await new Promise((res) => setTimeout(res, 10));
    expect(recorded).not.toBeNull();
    expect(recorded!.error).toContain("draft blew up");
    expect(gardenerRunInFlight("jarvis")).toBe(false);
  });
});

// ── progress + soft cancel ───────────────────────────────────────────────────

describe("backlog progress + soft cancel", () => {
  beforeEach(() => __resetGardenerMutexForTest());

  const assembled: AssembledBacklog = {
    listedBySource: {},
    batchKeys: ["c/a", "c/b", "c/c", "c/d"],
    consumedComplement: new Set(),
    offeredBefore: new Set(["c/z"]),
    queuedCount: 10,
  };

  test("requestBacklogCancel is false when no run is in flight", () => {
    expect(requestBacklogCancel("nobody")).toBe(false);
  });

  test("progress is seeded synchronously on start and cleared on settle", async () => {
    let releaseRun!: () => void;
    const gate = new Promise<WatcherAlert[]>((res) => (releaseRun = () => res([])));

    const r = startBacklogRun({
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => assembled,
      persistOffered: async () => {},
      runGardener: async () => gate,
      recordLastRun: () => {},
    });
    expect(r.state).toBe("started");
    // Seeded synchronously (before the work fn's first await).
    const prog = getBacklogProgress("jarvis");
    expect(prog).not.toBeNull();
    expect(prog!.stage).toBe("assembling");
    // A run in flight ⇒ cancel is accepted.
    expect(requestBacklogCancel("jarvis")).toBe(true);
    expect(getBacklogProgress("jarvis")!.cancelRequested).toBe(true);

    releaseRun();
    await new Promise((res) => setTimeout(res, 10));
    expect(getBacklogProgress("jarvis")).toBeNull();
  });

  test("cancelled run returns exactly the skipped clusters' docs to offered; declined stay offered", async () => {
    const persistCalls: string[][] = [];
    const r = startBacklogRun({
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => assembled,
      persistOffered: async (keys) => {
        persistCalls.push([...keys].sort());
      },
      runGardener: async (_a, hooks) => {
        // Drafted c/a,c/b; cancel left c/c,c/d undrafted (declined docs are neither).
        hooks.onProgress?.({ stage: "drafting", draftsDone: 2, draftsTotal: 4 });
        hooks.onAborted?.(["c/c", "c/d"]);
        return [{ id: "wiki-gardener:p1,p2", source: "wiki-gardener", summary: "", urgency: "low" }];
      },
      recordLastRun: () => {},
    });
    expect(r.state).toBe("started");
    await new Promise((res) => setTimeout(res, 10));

    // First persist BEFORE the run: offeredBefore(c/z) ∪ batch(c/a..c/d).
    expect(persistCalls[0]).toEqual(["c/a", "c/b", "c/c", "c/d", "c/z"]);
    // Second persist AFTER cancel: minus the skipped c/c,c/d → declined stay offered.
    expect(persistCalls[1]).toEqual(["c/a", "c/b", "c/z"]);
    expect(persistCalls).toHaveLength(2);
  });

  test("records the cancelled outcome (drafted/of) from the hooks", async () => {
    let recorded: { cancelled?: { drafted: number; of: number } } | null = null;
    startBacklogRun({
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => assembled,
      persistOffered: async () => {},
      runGardener: async (_a, hooks) => {
        hooks.onProgress?.({ stage: "drafting", draftsDone: 1, draftsTotal: 3 });
        hooks.onAborted?.(["c/c"]);
        return [{ id: "wiki-gardener:p1", source: "wiki-gardener", summary: "", urgency: "low" }];
      },
      recordLastRun: (rec) => {
        recorded = rec;
      },
    });
    await new Promise((res) => setTimeout(res, 10));
    expect(recorded).not.toBeNull();
    // drafted = draftedCount(alerts) = 1; of = draftsTotal from the last onProgress = 3.
    expect(recorded!.cancelled).toEqual({ drafted: 1, of: 3 });
  });

  test("a run that is not cancelled records no `cancelled` field and persists once", async () => {
    const persistCalls: string[][] = [];
    let recorded: { cancelled?: unknown } | null = null;
    startBacklogRun({
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => assembled,
      persistOffered: async (keys) => {
        persistCalls.push([...keys].sort());
      },
      runGardener: async (_a, hooks) => {
        hooks.onProgress?.({ stage: "drafting", draftsDone: 4, draftsTotal: 4 });
        return [{ id: "wiki-gardener:a,b,c,d", source: "wiki-gardener", summary: "", urgency: "low" }];
      },
      recordLastRun: (rec) => {
        recorded = rec;
      },
    });
    await new Promise((res) => setTimeout(res, 10));
    expect(persistCalls).toHaveLength(1); // no post-run re-persist without a cancel
    expect(recorded!.cancelled).toBeUndefined();
  });
});

// ── resetBacklogOffered (mutex-guarded reset) ────────────────────────────────

describe("resetBacklogOffered", () => {
  beforeEach(() => __resetGardenerMutexForTest());

  test("writes the empty set when no run is in flight", async () => {
    let persisted = false;
    const outcome = await resetBacklogOffered("jarvis", async () => {
      persisted = true;
    });
    expect(outcome.ok).toBe(true);
    expect(persisted).toBe(true);
  });

  test("refuses while a run is in flight — the run's persistOffered would clobber the reset", async () => {
    let release!: () => void;
    runExclusive("jarvis", () => new Promise<void>((r) => (release = r)));

    let persisted = false;
    const outcome = await resetBacklogOffered("jarvis", async () => {
      persisted = true;
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("in flight");
    expect(persisted).toBe(false);

    // After the run settles, the reset goes through.
    release();
    await new Promise((res) => setTimeout(res, 5));
    const after = await resetBacklogOffered("jarvis", async () => {
      persisted = true;
    });
    expect(after.ok).toBe(true);
    expect(persisted).toBe(true);
  });
});
