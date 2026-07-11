import { test, expect, describe } from "bun:test";
import type { AgentRun } from "../observability/agent-status.ts";
import {
  median,
  estimateIdentity,
  fmtDurationShort,
  groupWatcherDurations,
  ringDurations,
  buildRunEstimates,
  computeCardEta,
  type WatcherDurationRow,
  type CardEtaRun,
} from "./agent-eta.ts";

// ── Factories ─────────────────────────────────────────────────────────────────

function run(over: Partial<AgentRun> = {}): AgentRun {
  return {
    requestId: `req-${Math.random()}`,
    botName: "jarvis",
    phase: "idle",
    startedAt: 1000,
    completedAt: 2000,
    completed: true,
    tools: [],
    kind: "gardener_drain",
    name: "Backlog drain",
    ...over,
  };
}

function watcherRow(over: Partial<WatcherDurationRow> = {}): WatcherDurationRow {
  return {
    name: "watcher:email",
    durationMs: 1000,
    quietHoursSkipped: false,
    skippedInFlight: false,
    ...over,
  };
}

// ── median ────────────────────────────────────────────────────────────────────

describe("median", () => {
  test("odd length → middle element", () => {
    expect(median([5, 1, 3])).toBe(3);
  });
  test("even length → mean of the two middle", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  test("empty → null", () => {
    expect(median([])).toBeNull();
  });
});

describe("fmtDurationShort", () => {
  test("sub-minute in seconds", () => expect(fmtDurationShort(45_000)).toBe("45s"));
  test("minutes rounded", () => expect(fmtDurationShort(5 * 60_000 + 20_000)).toBe("5m"));
  test("hours + minutes", () => expect(fmtDurationShort(3_900_000)).toBe("1h 5m"));
  test("negative clamps to 0s", () => expect(fmtDurationShort(-500)).toBe("0s"));
});

// ── watcher grouping (skip-span exclusion) ────────────────────────────────────

describe("groupWatcherDurations", () => {
  test("strips the watcher: prefix and groups by type", () => {
    const g = groupWatcherDurations([
      watcherRow({ name: "watcher:email", durationMs: 100 }),
      watcherRow({ name: "watcher:email", durationMs: 300 }),
      watcherRow({ name: "watcher:wiki-gardener", durationMs: 500 }),
    ]);
    expect(g.email).toEqual([100, 300]);
    expect(g["wiki-gardener"]).toEqual([500]);
  });

  test("excludes quiet-hours + in-flight skip spans (would poison the median)", () => {
    const g = groupWatcherDurations([
      watcherRow({ durationMs: 100 }),
      watcherRow({ durationMs: 1, quietHoursSkipped: true }),
      watcherRow({ durationMs: 1, skippedInFlight: true }),
      watcherRow({ durationMs: 200 }),
    ]);
    expect(g.email).toEqual([100, 200]); // skip rows dropped
  });

  test("excludes null / non-positive durations", () => {
    const g = groupWatcherDurations([
      watcherRow({ durationMs: null }),
      watcherRow({ durationMs: 0 }),
      watcherRow({ durationMs: 150 }),
    ]);
    expect(g.email).toEqual([150]);
  });

  test("caps each type to the newest N (rows arrive newest-first)", () => {
    const rows = Array.from({ length: 25 }, (_, i) => watcherRow({ durationMs: i + 1 }));
    const g = groupWatcherDurations(rows, 20);
    expect(g.email).toHaveLength(20);
    expect(g.email![0]).toBe(1); // first (newest) kept, tail dropped
  });
});

// ── ring durations ────────────────────────────────────────────────────────────

describe("ringDurations", () => {
  test("matches (kind, name), newest-first, completed only", () => {
    const ring: AgentRun[] = [
      run({ kind: "research", name: "A", startedAt: 0, completedAt: 100 }), // 100
      run({ kind: "research", name: "B", startedAt: 0, completedAt: 999 }), // wrong name
      run({ kind: "capture", name: "A", startedAt: 0, completedAt: 999 }), // wrong kind
      run({ kind: "research", name: "A", startedAt: 0, completedAt: 300 }), // 300 (newer)
      run({ kind: "research", name: "A", startedAt: 0, completed: false, completedAt: undefined }), // not done
    ];
    expect(ringDurations(ring, "research", "A")).toEqual([300, 100]);
  });

  test("no matches → empty", () => {
    expect(ringDurations([run({ kind: "capture", name: "X" })], "research", "X")).toEqual([]);
  });
});

// ── buildRunEstimates ─────────────────────────────────────────────────────────

describe("buildRunEstimates", () => {
  test("median from ring history for a live non-watcher run", () => {
    const live = run({ requestId: "live", kind: "research", name: "Q", completed: false, completedAt: undefined, startedAt: 9999 });
    const ring: AgentRun[] = [
      run({ kind: "research", name: "Q", startedAt: 0, completedAt: 100 }),
      run({ kind: "research", name: "Q", startedAt: 0, completedAt: 300 }),
      run({ kind: "research", name: "Q", startedAt: 0, completedAt: 200 }),
    ];
    const est = buildRunEstimates([live], ring, []);
    expect(est[estimateIdentity("research", "Q")]).toBe(200); // median of 100/200/300
  });

  test("no history → identity absent (elapsed-only)", () => {
    const live = run({ kind: "research", name: "New", completed: false, completedAt: undefined });
    const est = buildRunEstimates([live], [], []);
    expect(est[estimateIdentity("research", "New")]).toBeUndefined();
    expect(Object.keys(est)).toHaveLength(0);
  });

  test("watcher runs source from the trace durations, not the ring", () => {
    const live = run({ kind: "watcher", name: "email", completed: false, completedAt: undefined });
    const watcherRows = [watcherRow({ durationMs: 400 }), watcherRow({ durationMs: 600 })];
    const est = buildRunEstimates([live], [], watcherRows);
    expect(est[estimateIdentity("watcher", "email")]).toBe(500); // median 400/600
  });

  test("display-named watcher resolves via watcherTypeByName to the type bucket", () => {
    // Live run carries the DISPLAY name; durations bucket by TYPE.
    const live = run({ kind: "watcher", name: "Wiki Gardener", completed: false, completedAt: undefined });
    const watcherRows = [
      watcherRow({ name: "watcher:wiki-gardener", durationMs: 400 }),
      watcherRow({ name: "watcher:wiki-gardener", durationMs: 600 }),
    ];
    const est = buildRunEstimates([live], [], watcherRows, { "Wiki Gardener": "wiki-gardener" });
    // Estimate keyed by the run's NAME (client contract), sourced from the type bucket.
    expect(est[estimateIdentity("watcher", "Wiki Gardener")]).toBe(500);
  });

  test("unknown watcher name (no mapping) falls back gracefully to no estimate", () => {
    const live = run({ kind: "watcher", name: "Wiki Gardener", completed: false, completedAt: undefined });
    const watcherRows = [watcherRow({ name: "watcher:wiki-gardener", durationMs: 500 })];
    // No mapping → falls back to name-as-type ("Wiki Gardener"), which has no bucket.
    const est = buildRunEstimates([live], [], watcherRows);
    expect(est[estimateIdentity("watcher", "Wiki Gardener")]).toBeUndefined();
  });

  test("chat is never estimated", () => {
    const live = run({ kind: "chat", name: "Chat turn", completed: false, completedAt: undefined });
    // Even if a (bogus) ring history existed under the chat identity, it's excluded.
    const ring = [run({ kind: "chat", name: "Chat turn", startedAt: 0, completedAt: 500 })];
    const est = buildRunEstimates([live], ring, []);
    expect(est[estimateIdentity("chat", "Chat turn")]).toBeUndefined();
  });

  test("completed runs in the running set are skipped", () => {
    const done = run({ kind: "research", name: "Q", completed: true });
    const ring = [run({ kind: "research", name: "Q", startedAt: 0, completedAt: 200 })];
    expect(buildRunEstimates([done], ring, [])).toEqual({});
  });
});

// ── computeCardEta (pure card-render model) ───────────────────────────────────

describe("computeCardEta", () => {
  const NOW = 10_000;

  test("elapsed-only when no history and no progress (indeterminate, no ETA line)", () => {
    const r: CardEtaRun = { kind: "research", name: "Q", startedAt: NOW - 4000, completed: false };
    const m = computeCardEta(r, null, NOW);
    expect(m.barMode).toBe("indeterminate");
    expect(m.etaLabel).toBeUndefined();
    expect(m.elapsedMs).toBe(4000);
  });

  test("history estimate → 'est.' qualifier + capped bar", () => {
    const r: CardEtaRun = { kind: "research", name: "Q", startedAt: NOW - 2000, completed: false };
    const m = computeCardEta(r, 10_000, NOW); // 2s of an estimated 10s
    expect(m.barMode).toBe("estimate");
    expect(m.barPct).toBe(20);
    expect(m.etaLabel).toBe("~8s left · est.");
  });

  test("bar caps at 95% even as it approaches the estimate", () => {
    const r: CardEtaRun = { kind: "research", name: "Q", startedAt: NOW - 9900, completed: false };
    const m = computeCardEta(r, 10_000, NOW); // 99% of estimate
    expect(m.barMode).toBe("estimate");
    expect(m.barPct).toBe(95);
  });

  test("past the estimate → 'running over est.' (not a frozen bar)", () => {
    const r: CardEtaRun = { kind: "research", name: "Q", startedAt: NOW - 15_000, completed: false };
    const m = computeCardEta(r, 10_000, NOW);
    expect(m.barMode).toBe("over");
    expect(m.barPct).toBeUndefined(); // shimmer, no frozen fill
    expect(m.etaLabel).toBe("running over est.");
  });

  test("pace beats history median when discrete progress exists (gardener drain)", () => {
    // 4s elapsed, 2 of 8 drafts done → pace = 4s/2*8 = 16s expected → 12s left.
    // The (much smaller) history median must NOT win.
    const r: CardEtaRun = {
      kind: "gardener_drain",
      name: "Backlog drain",
      startedAt: NOW - 4000,
      completed: false,
      progress: { done: 2, total: 8 },
    };
    const m = computeCardEta(r, 3000, NOW);
    expect(m.expectedDurationMs).toBe(16_000); // pace, not the 3000 median
    expect(m.barMode).toBe("determinate"); // n/m bar
    expect(m.barPct).toBe(25); // 2/8
    expect(m.etaLabel).toBe("~12s left · est.");
  });

  test("paced ETA is frozen per snapshot — countdown non-increasing for fixed progress", () => {
    // done=1/total=40: without freezing, pace = elapsed/1*40 balloons ~40× realtime,
    // so "time left" would grow between snapshots. The render pass freezes the pace;
    // rAF ticks feed it back and the countdown must only DECREASE.
    const r: CardEtaRun = {
      kind: "gardener_drain",
      name: "Backlog drain",
      startedAt: 0,
      completed: false,
      progress: { done: 1, total: 40 },
    };
    // Render pass at elapsed=10s → frozen pace expected = 10s/1*40 = 400s.
    const atRender = computeCardEta(r, 5000, 10_000);
    expect(atRender.expectedDurationMs).toBe(400_000);
    const remRender = atRender.expectedDurationMs! - atRender.elapsedMs; // 390s

    // A later tick (5s on) feeding the FROZEN pace back must not change expected,
    // and the remaining time must be smaller (countdown), never larger.
    const laterFrozen = computeCardEta(r, 5000, 15_000, atRender.expectedDurationMs);
    expect(laterFrozen.expectedDurationMs).toBe(400_000);
    const remLater = laterFrozen.expectedDurationMs! - laterFrozen.elapsedMs; // 385s
    expect(remLater).toBeLessThan(remRender);

    // Regression guard: recomputing pace from live elapsed (no freeze) balloons it.
    const laterUnfrozen = computeCardEta(r, 5000, 15_000);
    expect(laterUnfrozen.expectedDurationMs).toBe(600_000); // 15s/1*40 → grows upward
  });

  test("discrete progress with done=0 falls back to history (no pace yet)", () => {
    const r: CardEtaRun = {
      kind: "gardener_drain",
      name: "Backlog drain",
      startedAt: NOW - 1000,
      completed: false,
      progress: { done: 0, total: 5 },
    };
    const m = computeCardEta(r, 8000, NOW);
    expect(m.barMode).toBe("determinate");
    expect(m.barPct).toBe(0);
    expect(m.expectedDurationMs).toBe(8000); // history, pace not computable at done=0
  });

  test("completed → done bar, no ETA line", () => {
    const r: CardEtaRun = { kind: "research", name: "Q", startedAt: 1000, completed: true, completedAt: 3500 };
    const m = computeCardEta(r, 10_000, NOW);
    expect(m.barMode).toBe("done");
    expect(m.elapsedMs).toBe(2500); // completedAt - startedAt, not now
    expect(m.etaLabel).toBeUndefined();
  });

  test("chat gets no ETA even if a history value is passed", () => {
    const r: CardEtaRun = { kind: "chat", name: "Chat turn", startedAt: NOW - 3000, completed: false };
    const m = computeCardEta(r, 10_000, NOW);
    expect(m.barMode).toBe("indeterminate");
    expect(m.etaLabel).toBeUndefined();
  });
});
