import { test, expect, describe, beforeEach } from "bun:test";
import {
  selectBacklogBatch,
  passesAgeFloor,
  assembleBacklog,
  runExclusive,
  gardenerRunInFlight,
  startBacklogRun,
  resetBacklogOffered,
  draftedCount,
  draftedKeysSince,
  recoverRunJournal,
  getBacklogProgress,
  requestBacklogCancel,
  __resetGardenerMutexForTest,
  runSourceFallback,
  BACKLOG_BATCH_SIZE,
  BACKLOG_MAX_PROPOSALS,
  type AssembleBacklogDeps,
  type AssembledBacklog,
  type BacklogCandidate,
  type RunJournal,
} from "./backlog.ts";
import type { QueuedDoc } from "../wiki/ingest-backlog.ts";
import type { WatcherAlert } from "../types.ts";
import { agentStatus } from "../observability/agent-status.ts";

/**
 * No-op journal seams (PR 3) — every `startBacklogRun` case that doesn't exercise
 * the run journal spreads these so the work fn's readRunJournal (top) and
 * clearRunJournal (settle) are harmless. `readRunJournal: null` ⇒ no auto-recover.
 * `minClusterSize: 1` keeps the insufficient-batch guard inert for these cases (all
 * their batches are ≥ 1); the guard's own tests override it.
 */
const NOOP_JOURNAL = {
  minClusterSize: 1,
  getOffered: async () => new Set<string>(),
  readRunJournal: async (): Promise<RunJournal | null> => null,
  writeRunJournal: async () => {},
  clearRunJournal: async () => {},
  draftedKeysSince: async () => new Set<string>(),
};

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

  // ── age floor (docs still inside the weekly gardener's window are off-limits) ──
  const NOW = Date.parse("2026-07-17T00:00:00Z");
  const DAY = 86_400_000;
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString().slice(0, 10);

  test("age floor drops a doc newer than minAgeDays, keeps an older one", () => {
    const docs = [
      qd("c", "fresh", iso(3 * DAY)), // 3 days old — inside the 14-day window
      qd("c", "old", iso(30 * DAY)), // 30 days old — the drain's tail
    ];
    const batch = selectBacklogBatch(docs, new Set(), BACKLOG_BATCH_SIZE, 14, NOW);
    expect(batch.map((b) => b.id)).toEqual(["old"]);
  });

  test("age floor keeps an undated doc (genuinely old backlog)", () => {
    const docs = [qd("c", "fresh", iso(3 * DAY)), qd("c", "undated")];
    const batch = selectBacklogBatch(docs, new Set(), BACKLOG_BATCH_SIZE, 14, NOW);
    expect(batch.map((b) => b.id)).toEqual(["undated"]);
  });

  test("age floor is inclusive at the boundary (a doc exactly minAgeDays old stays eligible)", () => {
    const docs = [qd("c", "boundary", iso(14 * DAY))];
    const batch = selectBacklogBatch(docs, new Set(), BACKLOG_BATCH_SIZE, 14, NOW);
    expect(batch.map((b) => b.id)).toEqual(["boundary"]);
  });

  test("age floor honors a per-bot lookback override", () => {
    const docs = [qd("c", "d20", iso(20 * DAY))];
    // 20 days old — inside a 30-day override window ⇒ off-limits.
    expect(selectBacklogBatch(docs, new Set(), BACKLOG_BATCH_SIZE, 30, NOW)).toHaveLength(0);
    // …but eligible under the 14-day default.
    expect(selectBacklogBatch(docs, new Set(), BACKLOG_BATCH_SIZE, 14, NOW)).toHaveLength(1);
  });
});

// ── passesAgeFloor (the shared floor predicate) ──────────────────────────────

describe("passesAgeFloor", () => {
  const NOW = Date.parse("2026-07-17T00:00:00Z");
  const DAY = 86_400_000;
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString().slice(0, 10);

  test("undated doc is always eligible (old backlog)", () => {
    expect(passesAgeFloor({ id: "no-date-here" }, 14, NOW)).toBe(true);
  });

  test("dated doc newer than the floor is ineligible; older is eligible", () => {
    expect(passesAgeFloor({ id: "x", date: iso(3 * DAY) }, 14, NOW)).toBe(false);
    expect(passesAgeFloor({ id: "x", date: iso(30 * DAY) }, 14, NOW)).toBe(true);
  });

  test("inclusive at the boundary (exactly minAgeDays old ⇒ eligible)", () => {
    expect(passesAgeFloor({ id: "x", date: iso(14 * DAY) }, 14, NOW)).toBe(true);
  });

  test("falls back to the YYYY-MM-DD id prefix when no explicit date", () => {
    expect(passesAgeFloor({ id: `${iso(3 * DAY)}-fresh` }, 14, NOW)).toBe(false);
    expect(passesAgeFloor({ id: `${iso(30 * DAY)}-old` }, 14, NOW)).toBe(true);
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
          "article-summaries": [],
        },
        errors: [],
      }),
      sweepWikiRefs: async () => ({ urls: new Set<string>(), idTokens: new Set<string>() }),
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

  test("threads the age floor: a fresh queued doc is excluded from the batch but stays listed", async () => {
    const now = Date.parse("2026-06-10T00:00:00Z");
    const a = await assembleBacklog(
      baseDeps({
        // y1 (2026-06-03) is 7 days old — inside a 14-day window → off-limits.
        // y3 (2026-06-01) is 9 days old — also inside. Neither should be batched.
        minAgeDays: 14,
        now,
      }),
    );
    expect(a.batchKeys).toEqual([]);
    // Both stay listed (harvest's consumed-complement still skips them).
    expect(a.consumedComplement.has("youtube-summaries/y1")).toBe(true);
    expect(a.consumedComplement.has("youtube-summaries/y3")).toBe(true);
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
      ...NOOP_JOURNAL,
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
      ...NOOP_JOURNAL,
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

  test("journals BEFORE offering, persists the offered union BEFORE running, records + clears on success", async () => {
    const calls: string[] = [];
    let persistedKeys: string[] = [];
    let journalled: RunJournal | null = null;
    let recorded: { offered: number; drafted: number } | null = null;

    const r = startBacklogRun({
      ...NOOP_JOURNAL,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => {
        calls.push("assemble");
        return assembled;
      },
      writeRunJournal: async (j) => {
        calls.push("journal");
        journalled = j;
      },
      clearRunJournal: async () => {
        calls.push("clear");
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

    // Journal is written AFTER assemble (needs batchKeys) but BEFORE persistOffered;
    // the journal is cleared on the success settle.
    expect(calls).toEqual(["assemble", "journal", "persist", "run", "clear"]);
    expect(journalled).not.toBeNull();
    expect(journalled!.batchKeys).toEqual(["c/a", "c/b"]);
    expect(typeof journalled!.startedAt).toBe("number");
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
      ...NOOP_JOURNAL,
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

  test("records an error outcome + releases the mutex + KEEPS the journal when the run throws", async () => {
    let recorded: { error?: string } | null = null;
    let cleared = false;
    const r = startBacklogRun({
      ...NOOP_JOURNAL,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => assembled,
      writeRunJournal: async () => {},
      clearRunJournal: async () => {
        cleared = true;
      },
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
    // The journal is deliberately NOT cleared — the errored batch routes through
    // the same Recover/Dismiss banner as a crash.
    expect(cleared).toBe(false);
  });

  test("insufficient batch (< minClusterSize) → records insufficient, writes NO journal + NO offered snapshot + skips runGardener", async () => {
    const calls: string[] = [];
    let recorded: import("./backlog.ts").LastBacklogRun | null = null;
    let ranGardener = false;
    let persistedWith: string[] | null = null;

    // A batch of 2 eligible docs against minClusterSize 3 — provably can't cluster.
    const tiny: AssembledBacklog = {
      listedBySource: {},
      batchKeys: ["c/a", "c/b"],
      consumedComplement: new Set(),
      offeredBefore: new Set(["c/z"]),
      queuedCount: 2,
    };

    const r = startBacklogRun({
      ...NOOP_JOURNAL,
      minClusterSize: 3,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => {
        calls.push("assemble");
        return tiny;
      },
      writeRunJournal: async () => {
        calls.push("journal");
      },
      clearRunJournal: async () => {
        calls.push("clear");
      },
      persistOffered: async (keys) => {
        calls.push("persist");
        persistedWith = keys;
      },
      runGardener: async () => {
        ranGardener = true;
        return [];
      },
      recordLastRun: (rec) => {
        recorded = rec;
      },
    });

    expect(r.state).toBe("started");
    await new Promise((res) => setTimeout(res, 10));

    // The guard fires after assemble: no journal write, no offered persist, no run.
    expect(ranGardener).toBe(false);
    // persistOffered was NEVER called with the batch (never called at all here).
    expect(persistedWith).toBeNull();
    expect(calls).not.toContain("journal");
    expect(calls).not.toContain("persist");
    // The settle clears the journal harmlessly (idempotent) — assemble ran, guard hit.
    expect(calls).toContain("assemble");

    // The outcome is recorded so the UI can warn instead of rendering a bland "done".
    expect(recorded).not.toBeNull();
    expect(recorded!.outcome).toBe("insufficient");
    expect(recorded!.eligible).toBe(2);
    expect(recorded!.offered).toBe(0);
    expect(recorded!.drafted).toBe(0);
    // Attempted-doc count persisted for the strip's reason line (= the too-small batch).
    expect(recorded!.attemptedDocs).toBe(2);
    expect(gardenerRunInFlight("jarvis")).toBe(false);
  });

  test("batch exactly at minClusterSize runs normally (no insufficient short-circuit)", async () => {
    let ranGardener = false;
    let recorded: import("./backlog.ts").LastBacklogRun | null = null;
    const exact: AssembledBacklog = {
      listedBySource: {},
      batchKeys: ["c/a", "c/b", "c/c"],
      consumedComplement: new Set(),
      offeredBefore: new Set(),
      queuedCount: 3,
    };
    startBacklogRun({
      ...NOOP_JOURNAL,
      minClusterSize: 3,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => exact,
      persistOffered: async () => {},
      runGardener: async () => {
        ranGardener = true;
        // Draft one proposal so this stays a "runs normally" case (a bare [] would
        // trip the zero-draft rollback guard and report offered:0).
        return [{ id: "wiki-gardener:p1", source: "wiki-gardener", summary: "", urgency: "low" }];
      },
      recordLastRun: (rec) => {
        recorded = rec;
      },
    });
    await new Promise((res) => setTimeout(res, 10));
    expect(ranGardener).toBe(true);
    expect(recorded!.outcome).toBeUndefined();
    expect(recorded!.offered).toBe(3);
  });

  test("zero-draft run rolls the offered set back to offeredBefore (batch stays eligible)", async () => {
    // A batch of 3 eligible docs against minClusterSize 1 clears the insufficient
    // guard, so the run offers + journals + runs — but runGardener drafts NOTHING
    // (returns []). The offered snapshot must be rolled back to offeredBefore so the
    // batch stays eligible next run (the `offered: 4, drafted: 0` burn case).
    const persists: string[][] = [];
    let recorded: import("./backlog.ts").LastBacklogRun | null = null;
    const batch: AssembledBacklog = {
      listedBySource: {},
      batchKeys: ["c/a", "c/b", "c/c"],
      consumedComplement: new Set(),
      offeredBefore: new Set(["c/z"]),
      queuedCount: 4,
    };

    startBacklogRun({
      ...NOOP_JOURNAL,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => batch,
      persistOffered: async (keys) => {
        persists.push([...keys].sort());
      },
      runGardener: async () => [], // drafted nothing
      recordLastRun: (rec) => {
        recorded = rec;
      },
    });
    await new Promise((res) => setTimeout(res, 10));

    // Two persists: the pre-run offered union, then the rollback to offeredBefore.
    expect(persists).toEqual([["c/a", "c/b", "c/c", "c/z"], ["c/z"]]);
    // The batch keys are NOT in the final offered set — they stay eligible.
    expect(persists[persists.length - 1]).toEqual(["c/z"]);
    // The last-run record reports offered:0 — nothing stayed burned.
    expect(recorded).not.toBeNull();
    expect(recorded!.offered).toBe(0);
    expect(recorded!.drafted).toBe(0);
    expect(recorded!.outcome).toBeUndefined(); // not the insufficient short-circuit
    expect(gardenerRunInFlight("jarvis")).toBe(false);
  });

  test("a run that drafts ≥1 keeps the offered set burned (no rollback)", async () => {
    // Legitimate persistence: a run that produced a proposal must NOT roll back —
    // the drafted batch stays offered so it isn't re-clustered next run.
    const persists: string[][] = [];
    let recorded: import("./backlog.ts").LastBacklogRun | null = null;
    const batch: AssembledBacklog = {
      listedBySource: {},
      batchKeys: ["c/a", "c/b", "c/c"],
      consumedComplement: new Set(),
      offeredBefore: new Set(["c/z"]),
      queuedCount: 4,
    };

    startBacklogRun({
      ...NOOP_JOURNAL,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => batch,
      persistOffered: async (keys) => {
        persists.push([...keys].sort());
      },
      runGardener: async () => [
        { id: "wiki-gardener:p1", source: "wiki-gardener", summary: "", urgency: "low" },
      ],
      recordLastRun: (rec) => {
        recorded = rec;
      },
    });
    await new Promise((res) => setTimeout(res, 10));

    // Exactly ONE persist — the pre-run offered union. No rollback.
    expect(persists).toEqual([["c/a", "c/b", "c/c", "c/z"]]);
    expect(recorded!.offered).toBe(3);
    expect(recorded!.drafted).toBe(1);
  });

  test("captures the onTally drop tally + attempted-doc count on a zero-draft run (R1)", async () => {
    let recorded: import("./backlog.ts").LastBacklogRun | null = null;
    const batch: AssembledBacklog = {
      listedBySource: {},
      batchKeys: ["c/a", "c/b", "c/c"],
      consumedComplement: new Set(),
      offeredBefore: new Set(),
      queuedCount: 3,
    };
    const tally = {
      clusters_dropped: 3,
      clusters_dropped_size: 3,
      clusters_dropped_skip: 0,
      clusters_dropped_hallucinated: 0,
      clusters_dropped_duplicate: 0,
      clusters_dropped_cap: 0,
      clusters_dropped_topics: "solo-0(size,n:1)",
    };

    startBacklogRun({
      ...NOOP_JOURNAL,
      minClusterSize: 3,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => batch,
      persistOffered: async () => {},
      // A completed run that clustered nothing draftable: fire onTally, draft nothing.
      runGardener: async (_a, hooks) => {
        hooks.onTally?.(tally, 0);
        return [];
      },
      recordLastRun: (rec) => {
        recorded = rec;
      },
    });
    await new Promise((res) => setTimeout(res, 10));

    expect(recorded).not.toBeNull();
    // The tally + attempted-doc count + threshold ride onto the durable last-run record.
    expect(recorded!.dropTally).toEqual(tally);
    expect(recorded!.attemptedDocs).toBe(3);
    expect(recorded!.minClusterSize).toBe(3);
    // Post-gate survivor count rides along (0 here — nothing clustered).
    expect(recorded!.keptClusters).toBe(0);
    // Zero-draft rollback still reports offered:0.
    expect(recorded!.offered).toBe(0);
    expect(recorded!.drafted).toBe(0);
  });

  test("harvest-floor zero-draft (onTally never fires) still persists the attempted-doc count", async () => {
    let recorded: import("./backlog.ts").LastBacklogRun | null = null;
    const batch: AssembledBacklog = {
      listedBySource: {},
      batchKeys: ["c/a", "c/b", "c/c"],
      consumedComplement: new Set(),
      offeredBefore: new Set(),
      queuedCount: 3,
    };
    startBacklogRun({
      ...NOOP_JOURNAL,
      minClusterSize: 3,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => batch,
      persistOffered: async () => {},
      runGardener: async () => [], // early-returned before clustering → no onTally
      recordLastRun: (rec) => {
        recorded = rec;
      },
    });
    await new Promise((res) => setTimeout(res, 10));

    expect(recorded).not.toBeNull();
    expect(recorded!.dropTally).toBeUndefined();
    expect(recorded!.attemptedDocs).toBe(3);
    expect(recorded!.minClusterSize).toBe(3);
  });

  test("auto-recovers a pending journal (returns undrafted docs) BEFORE offering the new batch", async () => {
    // A prior run journalled c/p1..c/p4; only c/p1 produced a draft (drafted set).
    // The offered set still carries all four (persisted before the crash). Recover
    // must return c/p2,c/p3,c/p4 to the pool, then clear the journal, THEN assemble.
    const calls: string[] = [];
    const persists: string[][] = [];
    let cleared = 0;

    startBacklogRun({
      ...NOOP_JOURNAL,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      readRunJournal: async () => {
        calls.push("readJournal");
        return { startedAt: 1000, batchKeys: ["c/p1", "c/p2", "c/p3", "c/p4"] };
      },
      draftedKeysSince: async () => new Set(["c/p1"]),
      getOffered: async () => new Set(["c/p1", "c/p2", "c/p3", "c/p4", "c/z"]),
      clearRunJournal: async () => {
        calls.push("clearJournal");
        cleared++;
      },
      assemble: async () => {
        calls.push("assemble");
        return assembled;
      },
      writeRunJournal: async () => {
        calls.push("writeJournal");
      },
      persistOffered: async (keys) => {
        calls.push("persist");
        persists.push([...keys].sort());
      },
      // Draft one proposal so the zero-draft rollback guard doesn't add an extra
      // persist — this case exercises journal recovery, not the zero-draft path.
      runGardener: async () => [
        { id: "wiki-gardener:p1", source: "wiki-gardener", summary: "", urgency: "low" },
      ],
      recordLastRun: () => {},
    });
    await new Promise((res) => setTimeout(res, 10));

    // The recover reads the journal, persists offered − undrafted, clears the old
    // journal, THEN assembles + writes the new journal + persists the new offer;
    // the success settle clears the (fresh) journal a final time.
    expect(calls).toEqual([
      "readJournal",
      "persist",
      "clearJournal",
      "assemble",
      "writeJournal",
      "persist",
      "clearJournal",
    ]);
    // First persist = recover: offered minus the 3 undrafted docs (c/p1 stays — it
    // drafted; c/z is unrelated and stays).
    expect(persists[0]).toEqual(["c/p1", "c/z"]);
    // Second persist = the new batch's offered union (offeredBefore c/z ∪ c/a,c/b).
    expect(persists[1]).toEqual(["c/a", "c/b", "c/z"]);
    // The old journal is cleared exactly once by the recover (the success settle
    // clears again on its own; that's a separate no-op clear on the fresh journal).
    expect(cleared).toBeGreaterThanOrEqual(1);
  });

  // ── R4 low-volume source-draft fallback ──────────────────────────────────────

  /** Build a candidate + its composite key for a fallback fixture. */
  function cand(collection: string, id: string): BacklogCandidate {
    return { collection, id, key: `${collection}/${id}` };
  }

  test("path (a): insufficient batch drafts its docs individually via the fallback", async () => {
    const drafted: string[] = [];
    let recorded: import("./backlog.ts").LastBacklogRun | null = null;
    // 2 eligible docs < minClusterSize 3 — the insufficient short-circuit.
    const tiny: AssembledBacklog = {
      listedBySource: {},
      batchKeys: ["c/a", "c/b"],
      batch: [cand("c", "a"), cand("c", "b")],
      consumedComplement: new Set(),
      offeredBefore: new Set(),
      queuedCount: 2,
    };
    let ranGardener = false;
    startBacklogRun({
      ...NOOP_JOURNAL,
      minClusterSize: 3,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => tiny,
      persistOffered: async () => {},
      runGardener: async () => {
        ranGardener = true;
        return [];
      },
      draftSourceFallback: async (c) => {
        drafted.push(c.key);
        return { outcome: "drafted" };
      },
      recordLastRun: (rec) => {
        recorded = rec;
      },
    });
    await new Promise((res) => setTimeout(res, 10));

    // The gardener never ran (insufficient short-circuit), but the fallback drafted both.
    expect(ranGardener).toBe(false);
    expect(drafted.sort()).toEqual(["c/a", "c/b"]);
    expect(recorded!.outcome).toBe("insufficient");
    expect(recorded!.fallbackDrafted).toBe(2);
  });

  test("path (b/c): a completed zero-cluster run falls back + still rolls the offered set back", async () => {
    const drafted: string[] = [];
    const persists: string[][] = [];
    let recorded: import("./backlog.ts").LastBacklogRun | null = null;
    // 3 eligible docs clear minClusterSize 1, so the run offers + journals + runs —
    // but runGardener drafts NOTHING (harvest floor / cluster-size gate → []).
    const batch: AssembledBacklog = {
      listedBySource: {},
      batchKeys: ["c/a", "c/b", "c/c"],
      batch: [cand("c", "a"), cand("c", "b"), cand("c", "c")],
      consumedComplement: new Set(),
      offeredBefore: new Set(["c/z"]),
      queuedCount: 4,
    };
    startBacklogRun({
      ...NOOP_JOURNAL,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => batch,
      persistOffered: async (keys) => {
        persists.push([...keys].sort());
      },
      runGardener: async () => [], // drafted nothing
      draftSourceFallback: async (c) => {
        drafted.push(c.key);
        return { outcome: "drafted" };
      },
      recordLastRun: (rec) => {
        recorded = rec;
      },
    });
    await new Promise((res) => setTimeout(res, 10));

    // The fallback drafted the batch docs individually…
    expect(drafted.sort()).toEqual(["c/a", "c/b", "c/c"]);
    expect(recorded!.fallbackDrafted).toBe(3);
    // …and the #311 rollback still fired: the batch keys are OUT of the final offered set.
    expect(persists[persists.length - 1]).toEqual(["c/z"]);
    // drafted (gardener CLUSTER proposals) stays 0 — fallbackDrafted is a distinct count.
    expect(recorded!.drafted).toBe(0);
    expect(recorded!.offered).toBe(0);
  });

  test("no fallback seam wired → zero-draft run records no fallbackDrafted (unchanged behavior)", async () => {
    let recorded: import("./backlog.ts").LastBacklogRun | null = null;
    const batch: AssembledBacklog = {
      listedBySource: {},
      batchKeys: ["c/a", "c/b", "c/c"],
      batch: [cand("c", "a"), cand("c", "b"), cand("c", "c")],
      consumedComplement: new Set(),
      offeredBefore: new Set(),
      queuedCount: 3,
    };
    startBacklogRun({
      ...NOOP_JOURNAL,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => batch,
      persistOffered: async () => {},
      runGardener: async () => [],
      // draftSourceFallback intentionally omitted.
      recordLastRun: (rec) => {
        recorded = rec;
      },
    });
    await new Promise((res) => setTimeout(res, 10));
    expect(recorded!.fallbackDrafted).toBeUndefined();
    expect(recorded!.drafted).toBe(0);
  });

  test("fallback failure tolerance: one doc's draft error doesn't abort the rest", async () => {
    const seen: string[] = [];
    let recorded: import("./backlog.ts").LastBacklogRun | null = null;
    const batch: AssembledBacklog = {
      listedBySource: {},
      batchKeys: ["c/a", "c/b", "c/c"],
      batch: [cand("c", "a"), cand("c", "b"), cand("c", "c")],
      consumedComplement: new Set(),
      offeredBefore: new Set(),
      queuedCount: 3,
    };
    startBacklogRun({
      ...NOOP_JOURNAL,
      minClusterSize: 1,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => batch,
      persistOffered: async () => {},
      runGardener: async () => [],
      draftSourceFallback: async (c) => {
        seen.push(c.key);
        if (c.id === "b") throw new Error("boom"); // one doc blows up
        return { outcome: "drafted" };
      },
      recordLastRun: (rec) => {
        recorded = rec;
      },
    });
    await new Promise((res) => setTimeout(res, 10));
    // All three were visited despite the middle one throwing; 2 drafted.
    expect(seen.sort()).toEqual(["c/a", "c/b", "c/c"]);
    expect(recorded!.fallbackDrafted).toBe(2);
  });

  test("nested doc ids (slashes) flow through the fallback via separate collection/id (no key parsing)", async () => {
    const seen: BacklogCandidate[] = [];
    const batch: AssembledBacklog = {
      listedBySource: {},
      batchKeys: ["x-summaries/ai/rag/Foo.md", "x-summaries/ai/rag/Bar.md"],
      batch: [
        { collection: "x-summaries", id: "ai/rag/Foo.md", key: "x-summaries/ai/rag/Foo.md" },
        { collection: "x-summaries", id: "ai/rag/Bar.md", key: "x-summaries/ai/rag/Bar.md" },
      ],
      consumedComplement: new Set(),
      offeredBefore: new Set(),
      queuedCount: 2,
    };
    startBacklogRun({
      ...NOOP_JOURNAL,
      minClusterSize: 5, // insufficient path
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => batch,
      persistOffered: async () => {},
      runGardener: async () => [],
      draftSourceFallback: async (c) => {
        seen.push(c);
        return { outcome: "drafted" };
      },
      recordLastRun: () => {},
    });
    await new Promise((res) => setTimeout(res, 10));
    // The bare doc id keeps its slashes intact — collection and id never re-derived
    // from a composite key.
    expect(seen.map((c) => `${c.collection}::${c.id}`).sort()).toEqual([
      "x-summaries::ai/rag/Bar.md",
      "x-summaries::ai/rag/Foo.md",
    ]);
  });
});

// ── runSourceFallback (R4 fan-out helper) ────────────────────────────────────

describe("runSourceFallback", () => {
  function cand(id: string): BacklogCandidate {
    return { collection: "c", id, key: `c/${id}` };
  }

  test("returns the count of docs actually drafted", async () => {
    const batch = [cand("a"), cand("b"), cand("c")];
    const n = await runSourceFallback(
      batch,
      async (c) => ({ outcome: c.id === "b" ? "skipped" : "drafted" }),
      "jarvis",
    );
    expect(n).toBe(2);
  });

  test("caps real model attempts at BACKLOG_MAX_PROPOSALS (8) over a 40-doc batch", async () => {
    // Path (c): a not-actually-low-volume vertical whose batch is BACKLOG_BATCH_SIZE.
    const batch = Array.from({ length: BACKLOG_BATCH_SIZE }, (_, i) => cand(`d${i}`));
    let attempts = 0;
    const n = await runSourceFallback(
      batch,
      async () => {
        attempts++;
        return { outcome: "drafted" };
      },
      "jarvis",
    );
    expect(attempts).toBe(BACKLOG_MAX_PROPOSALS); // 8, not 40
    expect(n).toBe(BACKLOG_MAX_PROPOSALS);
  });

  test("cheap covered/skipped outcomes do NOT consume the cap (head-of-line fairness)", async () => {
    // 8 skips at the head, then real drafts — the skips must not exhaust the cap.
    const batch = [
      ...Array.from({ length: 8 }, (_, i) => cand(`skip${i}`)),
      ...Array.from({ length: 8 }, (_, i) => cand(`draft${i}`)),
    ];
    const drafted: string[] = [];
    const n = await runSourceFallback(
      batch,
      async (c) => {
        if (c.id.startsWith("skip")) return { outcome: "covered" };
        drafted.push(c.id);
        return { outcome: "drafted" };
      },
      "jarvis",
    );
    expect(n).toBe(8);
    expect(drafted).toHaveLength(8); // reached all 8 real drafts past the skips
  });

  test("errors count toward the cap and are tolerated (one bad doc doesn't abort)", async () => {
    const batch = Array.from({ length: 4 }, (_, i) => cand(`d${i}`));
    let visited = 0;
    const n = await runSourceFallback(
      batch,
      async (c) => {
        visited++;
        if (c.id === "d1") return { outcome: "error" };
        return { outcome: "drafted" };
      },
      "jarvis",
      3, // cap of 3 real attempts
    );
    expect(visited).toBe(3); // stopped at the cap (d0 drafted, d1 error, d2 drafted)
    expect(n).toBe(2); // d0 + d2 drafted; d1 errored
  });

  test("a thrown seam is contained, counts as a failed attempt, and the fan-out continues", async () => {
    const batch = [cand("a"), cand("b"), cand("c")];
    let visited = 0;
    const n = await runSourceFallback(
      batch,
      async (c) => {
        visited++;
        if (c.id === "a") throw new Error("boom");
        return { outcome: "drafted" };
      },
      "jarvis",
    );
    expect(visited).toBe(3);
    expect(n).toBe(2);
  });

  test("empty batch drafts nothing", async () => {
    const n = await runSourceFallback([], async () => ({ outcome: "drafted" }), "jarvis");
    expect(n).toBe(0);
  });
});

// ── recoverRunJournal (shared recover body) ──────────────────────────────────

describe("recoverRunJournal", () => {
  test("no journal → 0, nothing persisted or cleared", async () => {
    let persisted = 0;
    let cleared = 0;
    const n = await recoverRunJournal({
      readRunJournal: async () => null,
      draftedKeysSince: async () => new Set<string>(),
      getOffered: async () => new Set<string>(),
      persistOffered: async () => {
        persisted++;
      },
      clearRunJournal: async () => {
        cleared++;
      },
    });
    expect(n).toBe(0);
    expect(persisted).toBe(0);
    expect(cleared).toBe(0);
  });

  test("drafted subset stays offered; undrafted returned; count = actual deletions", async () => {
    const persists: string[][] = [];
    let cleared = 0;
    const n = await recoverRunJournal({
      readRunJournal: async () => ({ startedAt: 1000, batchKeys: ["c/p1", "c/p2", "c/p3"] }),
      draftedKeysSince: async () => new Set(["c/p1"]),
      getOffered: async () => new Set(["c/p1", "c/p2", "c/p3", "c/z"]),
      persistOffered: async (keys) => {
        persists.push([...keys].sort());
      },
      clearRunJournal: async () => {
        cleared++;
      },
    });
    expect(n).toBe(2); // c/p2 + c/p3 actually left the offered set
    expect(persists).toEqual([["c/p1", "c/z"]]);
    expect(cleared).toBe(1);
  });

  test("journal-written-but-never-offered crash window → recovered 0, no persist, journal cleared", async () => {
    let persisted = 0;
    let cleared = 0;
    const n = await recoverRunJournal({
      readRunJournal: async () => ({ startedAt: 1000, batchKeys: ["c/p1", "c/p2"] }),
      draftedKeysSince: async () => new Set<string>(),
      // The crash hit between writeRunJournal and persistOffered — batch never offered.
      getOffered: async () => new Set(["c/z"]),
      persistOffered: async () => {
        persisted++;
      },
      clearRunJournal: async () => {
        cleared++;
      },
    });
    expect(n).toBe(0);
    expect(persisted).toBe(0); // deleting keys never offered is a no-op — skip the write
    expect(cleared).toBe(1);
  });
});

// ── draftedKeysSince (interrupted-run scan) ──────────────────────────────────

describe("draftedKeysSince", () => {
  function prop(createdAt: number, ...keys: string[]) {
    return {
      createdAt,
      sourceDocs: keys.map((k) => {
        const [collection, docId] = k.split("/");
        return { collection: collection!, docId: docId! };
      }),
    };
  }

  test("counts batch keys that appear in proposals created at/after startedAt", () => {
    const proposals = [prop(2000, "c/a", "c/x"), prop(3000, "c/b")];
    const drafted = draftedKeysSince(proposals, 1500, ["c/a", "c/b", "c/c"]);
    expect([...drafted].sort()).toEqual(["c/a", "c/b"]);
  });

  test("time-bound: an OLDER proposal matching a batch key is NOT counted", () => {
    // c/a is a batch key, but the only proposal citing it predates the run start
    // (e.g. a rejected proposal from a previous run, re-batched after a Reset).
    const proposals = [prop(500, "c/a"), prop(2500, "c/b")];
    const drafted = draftedKeysSince(proposals, 1000, ["c/a", "c/b"]);
    expect([...drafted]).toEqual(["c/b"]); // c/a excluded by the time bound
  });

  test("empty when no proposal cites a batch key", () => {
    const drafted = draftedKeysSince([prop(9000, "c/other")], 0, ["c/a", "c/b"]);
    expect(drafted.size).toBe(0);
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
      ...NOOP_JOURNAL,
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

  test("cancelled run returns exactly the skipped clusters' docs to offered; declined stay offered; clears journal", async () => {
    const persistCalls: string[][] = [];
    let cleared = false;
    const r = startBacklogRun({
      ...NOOP_JOURNAL,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => assembled,
      clearRunJournal: async () => {
        cleared = true;
      },
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
    // A cancel settles via the fulfilled path, so the journal IS cleared.
    expect(cleared).toBe(true);
  });

  test("records the cancelled outcome (drafted/of) from the hooks", async () => {
    let recorded: { cancelled?: { drafted: number; of: number } } | null = null;
    startBacklogRun({
      ...NOOP_JOURNAL,
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
      ...NOOP_JOURNAL,
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

// ── AgentRun registry mirror (/agents dashboard) ─────────────────────────────

describe("startBacklogRun — AgentRun registry mirror", () => {
  beforeEach(() => {
    __resetGardenerMutexForTest();
    agentStatus.clearRequest(); // reset the singleton (drops live runs + ring)
  });

  const assembled: AssembledBacklog = {
    listedBySource: {},
    batchKeys: ["c/a", "c/b", "c/c"],
    consumedComplement: new Set(),
    offeredBefore: new Set(),
    queuedCount: 5,
  };

  function gardenerRun(bot: string): AgentRunLike | undefined {
    return agentStatus.getAll().find((r) => r.kind === "gardener_drain" && r.botName === bot);
  }
  // Minimal structural shape we read (avoids importing the full AgentRun type).
  type AgentRunLike = ReturnType<typeof agentStatus.getAll>[number];

  test("registers a gardener_drain run on start and mirrors stage + progress + cancel", async () => {
    let release!: () => void;
    const gate = new Promise<WatcherAlert[]>((res) => (release = () => res([])));
    let hookRef: import("./backlog.ts").GardenerRunHooks | undefined;

    const r = startBacklogRun({
      ...NOOP_JOURNAL,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => assembled,
      persistOffered: async () => {},
      runGardener: async (_a, hooks) => {
        hookRef = hooks;
        return gate;
      },
      recordLastRun: () => {},
    });
    expect(r.state).toBe("started");

    // Registered synchronously-ish once the work fn runs its first tick.
    await new Promise((res) => setTimeout(res, 5));
    const run = gardenerRun("jarvis");
    expect(run).toBeDefined();
    expect(run!.name).toBe("Backlog drain");
    expect(run!.sourcePage).toBe("/wiki/gardener");
    expect(run!.completed).toBeFalsy();

    // A progress tick mirrors the stage into the run phase + n/m into progress.
    hookRef!.onProgress?.({ stage: "drafting", draftsDone: 1, draftsTotal: 3, currentTopic: "Topic X" });
    const mid = gardenerRun("jarvis")!;
    expect(mid.phase).toBe("drafting");
    expect(mid.progress).toEqual({ done: 1, total: 3, currentItem: "Topic X" });

    // A cancel is mirrored onto the run once shouldAbort observes it.
    requestBacklogCancel("jarvis");
    expect(hookRef!.shouldAbort?.()).toBe(true);
    expect(gardenerRun("jarvis")!.cancelRequested).toBe(true);

    release();
    await new Promise((res) => setTimeout(res, 10));
    // Marked completed (the 30s auto-clear timer still holds it in getAll) + also
    // snapshotted into the ring, which is what Recent sources gardener_drain from.
    expect(gardenerRun("jarvis")!.completed).toBe(true);
    const completed = agentStatus.getRecentCompleted().find((x) => x.kind === "gardener_drain");
    expect(completed).toBeDefined();
    expect(completed!.name).toBe("Backlog drain");
  });

  test("completes the registry run on a runGardener throw (never leaks)", async () => {
    startBacklogRun({
      ...NOOP_JOURNAL,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => assembled,
      persistOffered: async () => {},
      runGardener: async () => {
        throw new Error("huginn 500 mid-harvest");
      },
      recordLastRun: () => {},
    });
    await new Promise((res) => setTimeout(res, 10));

    // No live gardener_drain run remains; it settled into the completed ring.
    expect(agentStatus.getAll().some((x) => x.kind === "gardener_drain" && !x.completed)).toBe(false);
    expect(agentStatus.getRecentCompleted().some((x) => x.kind === "gardener_drain")).toBe(true);
  });

  test("no registry run when the drain never starts (running / disabled / no-watcher)", async () => {
    // A second click while one is in flight must not register a second card.
    let release!: () => void;
    const gate = new Promise<WatcherAlert[]>((res) => (release = () => res([])));
    const base = {
      ...NOOP_JOURNAL,
      botName: "jarvis",
      gardenerEnabled: true,
      hasWatcher: true,
      assemble: async () => assembled,
      persistOffered: async () => {},
      runGardener: async () => gate,
      recordLastRun: () => {},
    };
    startBacklogRun(base);
    await new Promise((res) => setTimeout(res, 5));
    const second = startBacklogRun(base);
    expect(second.state).toBe("running");
    expect(agentStatus.getAll().filter((x) => x.kind === "gardener_drain").length).toBe(1);

    release();
    await new Promise((res) => setTimeout(res, 10));
  });
});
