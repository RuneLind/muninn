import { test, expect, describe } from "bun:test";
import {
  backlogStripModel,
  backlogSentenceHtml,
  backlogTailHtml,
  backlogControlHtml,
  backlogConfirmHtml,
  backlogProgressText,
  backlogProgressHtml,
  backlogOutcomeHtml,
  backlogBannerHtml,
  backlogStripHtml,
  backlogSourceDraftHtml,
  sourceDraftResultHtml,
  type BacklogProgress,
  type BacklogWatcherInfo,
  type IngestBacklogResponse,
  type SourceBacklogResult,
} from "./wiki-gardener-strip.ts";

/**
 * The strip's honest-numbers contract + control gating are pure, so they're
 * tested here without a DOM (the browser entrypoint touches `document` at module
 * load and can't be imported in tests).
 *
 * Key invariant: "offered in past runs" and the reset gate/label both use the
 * server-computed `offeredStillQueued` (queued ∩ offered), NOT the raw all-time
 * `offered` field and NOT a client-side `queued − remaining` derivation (which the
 * drain's age floor would inflate by counting merely-too-fresh docs as offered).
 */

function base(over: Partial<IngestBacklogResponse> = {}): IngestBacklogResponse {
  return {
    byCollection: [
      { collection: "youtube-summaries", source: "youtube", label: "YouTube", total: 0, ingested: 0, queued: 310 },
      { collection: "x-articles", source: "x-article", label: "X", total: 0, ingested: 0, queued: 7 },
      { collection: "anthropic-summaries", source: "anthropic", label: "Anthropic", total: 0, ingested: 0, queued: 7 },
      { collection: "tiktok-summaries", source: "tiktok", label: "TikTok", total: 0, ingested: 0, queued: 5 },
    ],
    total: 400,
    ingested: 71,
    queued: 329,
    wikiUrlCount: 100,
    generatedAt: 111,
    running: false,
    offered: 200, // all-time offered (includes since-consumed) — deliberately ≠ offeredStillQueued
    remaining: 260,
    offeredStillQueued: 69, // queued ∩ offered — the honest count (server-computed)
    fresh: 0,
    freshBySource: [],
    freshWindowDays: 14,
    watcherSeeded: true,
    batchSize: 40,
    maxProposals: 8,
    ...over,
  };
}

describe("backlogStripModel — honest numbers", () => {
  test("offered-in-past-runs is the server-computed offeredStillQueued, not the raw all-time offered", () => {
    const m = backlogStripModel(base(), 3);
    expect(m.totalNeverIngested).toBe(329);
    expect(m.eligibleNow).toBe(260);
    // Sourced from the response field (queued ∩ offered) — NOT the raw offered
    // field (200), and NOT derived as queued(329) − remaining(260).
    expect(m.offeredStillQueued).toBe(69);
    expect(m.draftsAwaitingReview).toBe(3);
    // In this fixture (no too-fresh docs held back by the floor) the sentence adds
    // up: eligible + offered-still-queued = total.
    expect(m.eligibleNow + m.offeredStillQueued).toBe(m.totalNeverIngested);
    // Per-source counts sum to the total.
    expect(m.perSource.reduce((s, p) => s + p.queued, 0)).toBe(329);
  });

  test("offeredStillQueued is taken verbatim from the response, decoupled from queued − remaining", () => {
    // The age floor makes `remaining` exclude too-fresh docs, so `queued − remaining`
    // over-counts. The strip must trust the server field instead: here queued − remaining
    // would be 329 − 100 = 229, but the honest offered-and-still-queued count is 10.
    const m = backlogStripModel(base({ remaining: 100, offeredStillQueued: 10 }), 0);
    expect(m.eligibleNow).toBe(100);
    expect(m.offeredStillQueued).toBe(10);
  });

  test("drainNow = min(batchSize, eligibleNow)", () => {
    expect(backlogStripModel(base(), 0).drainNow).toBe(40); // capped by batch
    expect(backlogStripModel(base({ remaining: 12 }), 0).drainNow).toBe(12); // capped by eligible
  });
});

describe("recency-first sentence + collapsed tail", () => {
  test("fresh arrivals lead the sentence with per-source breakdown + window label", () => {
    const m = backlogStripModel(
      base({
        fresh: 5,
        freshBySource: [
          { label: "YouTube", count: 4 },
          { label: "X", count: 1 },
        ],
      }),
      2,
    );
    expect(m.freshTotal).toBe(5);
    const html = backlogSentenceHtml(m);
    // Order: new → drainable → drafts. The all-time totals are NOT in the sentence.
    expect(html).toContain("new (last 14d)");
    expect(html.indexOf("new (last 14d)")).toBeLessThan(html.indexOf("drainable now"));
    expect(html).toContain("YouTube");
    expect(html).toContain("weekly watcher");
    expect(html).toContain("drafts awaiting review");
    expect(html).not.toContain("never ingested");
  });

  test("zero fresh still shows the honest '0 new' lead (live response)", () => {
    const html = backlogSentenceHtml(backlogStripModel(base(), 0));
    expect(html).toContain("0</span> new (last 14d)");
    expect(html).not.toContain("weekly watcher"); // no breakdown when empty
  });

  test("degraded response (no live fields) hides the fresh segment instead of lying '0 new'", () => {
    const degraded = base();
    delete degraded.fresh;
    delete degraded.freshBySource;
    delete degraded.freshWindowDays;
    const m = backlogStripModel(degraded, 0);
    expect(m.freshWindowDays).toBe(0);
    expect(backlogSentenceHtml(m)).not.toContain("new (last");
  });

  test("tail holds the all-time accounting: offered summary + per-source breakdown", () => {
    const html = backlogTailHtml(backlogStripModel(base({ remaining: 0, offeredStillQueued: 255 }), 0));
    expect(html).toContain("<details");
    expect(html).toContain("255</span> offered in past runs, never drafted");
    expect(html).toContain("329</span> never ingested all-time");
    expect(html).toContain("YouTube"); // per-source breakdown behind the toggle
    expect(html).toContain("310");
  });

  test("tail without an offered set still shows the all-time summary; empty backlog renders nothing", () => {
    const noOffered = backlogTailHtml(backlogStripModel(base({ offeredStillQueued: 0 }), 0));
    expect(noOffered).not.toContain("offered in past runs");
    expect(noOffered).toContain("never ingested all-time");
    const empty = backlogTailHtml(
      backlogStripModel(base({ queued: 0, remaining: 0, offeredStillQueued: 0, byCollection: [] }), 0),
    );
    expect(empty).toBe("");
  });

  test("malformed freshBySource entries are dropped, zero-count entries hidden", () => {
    const m = backlogStripModel(
      base({
        fresh: 3,
        // deliberately malformed shapes a degraded/older server might emit
        freshBySource: [
          { label: "YouTube", count: 3 },
          { label: "X", count: 0 },
          { label: 7, count: "x" },
          null,
        ] as never,
      }),
      0,
    );
    expect(m.freshPerSource).toEqual([{ label: "YouTube", count: 3 }]);
  });
});

describe("backlogStripModel — Run-gardener-now watcher affordance", () => {
  const NOW = 1_700_000_000_000;
  const DAY = 86_400_000;
  function watcher(over: Partial<BacklogWatcherInfo> = {}): BacklogWatcherInfo {
    return {
      id: "w-1",
      enabled: true,
      lastRunAt: NOW - 3 * DAY,
      nextRunAt: NOW + 4 * DAY, // 3d ago + 7d interval ⇒ in ~4d
      forceQueued: false,
      ...over,
    };
  }
  // Fresh docs present by default so the button's fresh-gate is satisfied.
  function freshBase(over: Partial<IngestBacklogResponse> = {}): IngestBacklogResponse {
    return base({ fresh: 5, freshBySource: [{ label: "YouTube", count: 5 }], ...over });
  }

  test("happy path: fresh + enabled + not queued + idle ⇒ Run-now button + next-run text", () => {
    const m = backlogStripModel(freshBase({ watcher: watcher() }), 0, NOW);
    expect(m.watcherRunNow).toEqual({ id: "w-1" });
    expect(m.watcherQueued).toBe(false);
    expect(m.nextRunText).toBe("next weekly run in ~4d");
  });

  test("hours granularity below a day", () => {
    const m = backlogStripModel(
      freshBase({ watcher: watcher({ nextRunAt: NOW + 3 * 3_600_000 }) }),
      0,
      NOW,
    );
    expect(m.nextRunText).toBe("next weekly run in ~3h");
  });

  test("forceQueued ⇒ no button, watcherQueued true (model still carries next-run text; renderer suppresses it)", () => {
    const m = backlogStripModel(freshBase({ watcher: watcher({ forceQueued: true }) }), 0, NOW);
    expect(m.watcherRunNow).toBeNull();
    expect(m.watcherQueued).toBe(true);
    // The model still derives the text — it's the renderer (freshWatcherSuffixHtml)
    // that suppresses it while the run is queued (asserted in the sentence tests).
    expect(m.nextRunText).toBe("next weekly run in ~4d");
  });

  test("a run in flight ⇒ no button even with fresh + enabled watcher", () => {
    const m = backlogStripModel(freshBase({ running: true, watcher: watcher() }), 0, NOW);
    expect(m.watcherRunNow).toBeNull();
  });

  test("no watcher block (degraded/older server) ⇒ no affordance, no next-run text", () => {
    const m = backlogStripModel(freshBase({ watcher: null }), 0, NOW);
    expect(m.watcherRunNow).toBeNull();
    expect(m.watcherQueued).toBe(false);
    expect(m.nextRunText).toBeNull();
  });

  test("disabled watcher ⇒ no affordance, no next-run text (never fires even if force-queued)", () => {
    const m = backlogStripModel(
      freshBase({ watcher: watcher({ enabled: false, forceQueued: true }) }),
      0,
      NOW,
    );
    expect(m.watcherRunNow).toBeNull();
    expect(m.watcherQueued).toBe(false);
    expect(m.nextRunText).toBeNull();
  });

  test("zero fresh ⇒ no Run-now button (but next-run text still derived for an enabled watcher)", () => {
    const m = backlogStripModel(base({ fresh: 0, freshBySource: [], watcher: watcher() }), 0, NOW);
    expect(m.watcherRunNow).toBeNull();
    expect(m.nextRunText).toBe("next weekly run in ~4d");
  });

  test("nextRunText: never-run (lastRunAt null) or past-due ⇒ due on next tick", () => {
    const neverRun = backlogStripModel(
      freshBase({ watcher: watcher({ lastRunAt: null, nextRunAt: null }) }),
      0,
      NOW,
    );
    expect(neverRun.nextRunText).toBe("next weekly run due on next tick");
    const pastDue = backlogStripModel(
      freshBase({ watcher: watcher({ nextRunAt: NOW - 1 }) }),
      0,
      NOW,
    );
    expect(pastDue.nextRunText).toBe("next weekly run due on next tick");
  });

  test("degraded response (freshWindowDays 0) ⇒ no watcher affordance even with a watcher block", () => {
    const degraded = freshBase({ watcher: watcher() });
    delete degraded.freshWindowDays;
    const m = backlogStripModel(degraded, 0, NOW);
    expect(m.watcherRunNow).toBeNull();
    expect(m.nextRunText).toBeNull();
  });

  test("malformed watcher block ⇒ parsed to null (no affordance)", () => {
    const m = backlogStripModel(
      freshBase({ watcher: { id: 7, enabled: "yes" } as never }),
      0,
      NOW,
    );
    expect(m.watcherRunNow).toBeNull();
    expect(m.nextRunText).toBeNull();
  });
});

describe("backlogSentenceHtml — Run-gardener-now fresh segment", () => {
  const NOW = 1_700_000_000_000;
  const DAY = 86_400_000;
  function watcher(over: Partial<BacklogWatcherInfo> = {}): BacklogWatcherInfo {
    return { id: "w-1", enabled: true, lastRunAt: NOW - 3 * DAY, nextRunAt: NOW + 4 * DAY, forceQueued: false, ...over };
  }
  function freshBase(over: Partial<IngestBacklogResponse> = {}): IngestBacklogResponse {
    return base({ fresh: 5, freshBySource: [{ label: "YouTube", count: 5 }], ...over });
  }

  test("happy path: fresh segment carries next-run text + the Run-now button markup", () => {
    const html = backlogSentenceHtml(backlogStripModel(freshBase({ watcher: watcher() }), 0, NOW));
    expect(html).toContain("next weekly run in ~4d");
    expect(html).toContain('data-backlog-action="run-watcher"');
    expect(html).toContain('data-watcher-id="w-1"');
    expect(html).toContain("Run gardener now");
    // The dead-end fallback note is replaced, not appended.
    expect(html).not.toContain("weekly watcher's turf");
  });

  test("queued state: the note replaces the button AND suppresses the next-run text", () => {
    const html = backlogSentenceHtml(
      backlogStripModel(freshBase({ watcher: watcher({ forceQueued: true }) }), 0, NOW),
    );
    expect(html).toContain("gardener run queued — starts on the next scheduler tick");
    expect(html).not.toContain('data-backlog-action="run-watcher"');
    // Queued wins: showing "next weekly run in ~4d" beside "queued" reads as a
    // contradiction, so the next-run text is suppressed while a run is queued.
    expect(html).not.toContain("next weekly run in ~4d");
  });

  test("a run in flight: next-run text shows, but no button/queued note (control area owns run state)", () => {
    const html = backlogSentenceHtml(
      backlogStripModel(freshBase({ running: true, watcher: watcher({ forceQueued: true }) }), 0, NOW),
    );
    expect(html).toContain("next weekly run in ~4d");
    expect(html).not.toContain('data-backlog-action="run-watcher"');
    expect(html).not.toContain("gardener run queued");
  });

  test("degrades to the old 'weekly watcher's turf' label when there is no watcher block", () => {
    const html = backlogSentenceHtml(backlogStripModel(freshBase({ watcher: null }), 0, NOW));
    expect(html).toContain("weekly watcher's turf");
    expect(html).not.toContain('data-backlog-action="run-watcher"');
    expect(html).not.toContain("next weekly run");
  });
});

describe("backlogStripModel — control gating", () => {
  test("zero queued → no run, no reset, not all-offered", () => {
    const m = backlogStripModel(
      base({ byCollection: [], queued: 0, remaining: 0, offered: 0, offeredStillQueued: 0 }),
      0,
    );
    expect(m.showRun).toBe(false);
    expect(m.showReset).toBe(false);
    expect(m.nothingDrainable).toBe(false);
    expect(backlogControlHtml(m)).toBe("");
  });

  test("offered>0 with eligible left → both run and reset show", () => {
    const m = backlogStripModel(base(), 0);
    expect(m.showRun).toBe(true);
    expect(m.showReset).toBe(true);
    expect(m.nothingDrainable).toBe(false);
    const html = backlogControlHtml(m);
    expect(html).toContain('data-backlog-action="confirm"'); // run button opens confirm
    expect(html).toContain("Reset offered (69)");
  });

  test("running → disabled Running…, no run/reset buttons", () => {
    const m = backlogStripModel(base({ running: true }), 0);
    expect(m.running).toBe(true);
    expect(m.showRun).toBe(false);
    expect(m.showReset).toBe(false);
    const html = backlogControlHtml(m);
    expect(html).toContain("Running…");
    expect(html).not.toContain("data-backlog-action");
  });

  test("nothing drainable (remaining 0, queued>0) → 'nothing drainable' + reset with re-run wording", () => {
    const m = backlogStripModel(base({ remaining: 0, offeredStillQueued: 329 }), 0);
    expect(m.nothingDrainable).toBe(true);
    expect(m.showRun).toBe(false);
    expect(m.showReset).toBe(true); // 329 offered-still-queued
    const html = backlogControlHtml(m);
    // Not "all offered" — fresh in-window docs are un-offered too, so that wording
    // lies whenever new arrivals exist; the note states what the missing button means.
    expect(html).toContain("nothing drainable");
    expect(html).toContain("Reset to re-run");
    expect(html).not.toContain("Reset offered ("); // keep the re-run wording
  });

  test("offered-still-queued 0 (everything consumed) → no reset button", () => {
    // Nothing offered-and-still-queued (server reports 0), so no "Reset offered (0)".
    const m = backlogStripModel(base({ queued: 5, remaining: 5, offered: 400, offeredStillQueued: 0 }), 0);
    expect(m.offeredStillQueued).toBe(0);
    expect(m.showReset).toBe(false);
    expect(backlogControlHtml(m)).not.toContain("Reset");
  });

  test("watcher not seeded → control hidden entirely", () => {
    const m = backlogStripModel(base({ watcherSeeded: false }), 0);
    expect(m.controlHidden).toBe(true);
    expect(m.showRun).toBe(false);
    expect(m.showReset).toBe(false);
    expect(backlogControlHtml(m)).toBe("");
  });
});

describe("backlog progress line (live drain)", () => {
  function prog(over: Partial<BacklogProgress> = {}): BacklogProgress {
    return {
      stage: "drafting",
      draftsDone: 3,
      draftsTotal: 6,
      currentTopic: "ai-agents",
      startedAt: Date.parse("2026-07-10T14:32:00"),
      cancelRequested: false,
      ...over,
    };
  }

  test("stage text maps each stage to friendly copy", () => {
    expect(backlogProgressText(prog({ stage: "assembling" }))).toBe("Selecting batch…");
    expect(backlogProgressText(prog({ stage: "harvesting" }))).toBe("Fetching docs…");
    expect(backlogProgressText(prog({ stage: "clustering" }))).toBe("Clustering…");
    expect(backlogProgressText(prog({ stage: "resolving" }))).toBe("Resolving targets…");
    expect(backlogProgressText(prog())).toBe("Drafting 3/6 — ai-agents");
    // No total yet (draft loop not reached, no topic) → plain "Drafting…".
    expect(backlogProgressText(prog({ draftsTotal: 0, currentTopic: undefined }))).toBe("Drafting…");
  });

  test("running with progress renders the progress line + a live Cancel button", () => {
    const m = backlogStripModel(base({ running: true, progress: prog() }), 0);
    expect(m.progress).not.toBeNull();
    const html = backlogControlHtml(m);
    expect(html).toContain("Drafting 3/6 — ai-agents");
    expect(html).toContain("started 14:32");
    expect(html).toContain("3 drafts ready below");
    expect(html).toContain('data-backlog-action="cancel-run"');
    expect(html).not.toContain("Running…"); // progress replaces the plain disabled button
  });

  test("cancel requested → button reads Cancelling… and is disabled", () => {
    const html = backlogProgressHtml(prog({ cancelRequested: true }));
    expect(html).toContain("Cancelling…");
    expect(html).toContain("disabled");
  });

  test("running WITHOUT progress (a weekly run holds the mutex) → plain disabled Running…", () => {
    const m = backlogStripModel(base({ running: true, progress: null }), 0);
    expect(m.progress).toBeNull();
    const html = backlogControlHtml(m);
    expect(html).toContain("Running…");
    expect(html).not.toContain("data-backlog-action"); // not cancellable
  });

  test("currentTopic is HTML-escaped in the progress line", () => {
    const html = backlogProgressHtml(prog({ currentTopic: "<b>x</b>" }));
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("backlogOutcomeHtml — cancelled runs", () => {
  test("cancelled after k drafts → 'undrafted docs returned to the queue'", () => {
    const html = backlogOutcomeHtml({ finishedAt: 1, offered: 40, drafted: 2, cancelled: { drafted: 2, of: 6 } });
    expect(html).toContain("cancelled after 2/6 drafts");
    expect(html).toContain("undrafted docs returned to the queue");
  });

  test("cancelled before drafting (drafted 0) → special-cased copy", () => {
    const html = backlogOutcomeHtml({ finishedAt: 1, offered: 40, drafted: 0, cancelled: { drafted: 0, of: 5 } });
    expect(html).toContain("cancelled before drafting — batch docs returned to the queue");
  });
});

describe("backlogOutcomeHtml — insufficient + zero-draft burn (PR 2)", () => {
  test("insufficient batch → informational 'below the minimum cluster size; nothing offered'", () => {
    const html = backlogOutcomeHtml({ finishedAt: 1, offered: 0, drafted: 0, outcome: "insufficient", eligible: 2 });
    expect(html).toContain("2 eligible doc(s)");
    expect(html).toContain("below the minimum cluster size");
    expect(html).toContain("nothing offered");
    // Nothing was burned, so this is a plain note — NOT the warn style.
    expect(html).not.toContain("bk-warn");
  });

  test("insufficient with zero eligible (or the field absent) → distinct empty-backlog copy", () => {
    const html = backlogOutcomeHtml({ finishedAt: 1, offered: 0, drafted: 0, outcome: "insufficient" });
    expect(html).toContain("no eligible docs in the backlog");
    expect(html).not.toContain("bk-warn");
  });

  test("insufficient renders the run's own minClusterSize threshold, defaulting to 3", () => {
    const withMin = backlogOutcomeHtml({
      finishedAt: 1, offered: 0, drafted: 0, outcome: "insufficient", eligible: 4, minClusterSize: 5,
    });
    expect(withMin).toContain("below the minimum cluster size of 5");
    const withoutMin = backlogOutcomeHtml({ finishedAt: 1, offered: 0, drafted: 0, outcome: "insufficient", eligible: 2 });
    expect(withoutMin).toContain("below the minimum cluster size of 3");
  });

  test("offered docs but drafted nothing → warn style + burn copy + Reset hint", () => {
    const html = backlogOutcomeHtml({ finishedAt: 1, offered: 9, drafted: 0 });
    expect(html).toContain("bk-warn");
    expect(html).toContain("⚠");
    expect(html).toContain("offered 9 docs but drafted nothing");
    expect(html).toContain("Reset to retry");
  });

  test("a real done run (drafted > 0) is unchanged — no warn", () => {
    const html = backlogOutcomeHtml({ finishedAt: 1, offered: 9, drafted: 2 });
    expect(html).toContain("2 draft(s) from 9 docs");
    expect(html).not.toContain("bk-warn");
  });

  test("nothing offered and nothing drafted → plain 'nothing to draft' note (not a warn)", () => {
    const html = backlogOutcomeHtml({ finishedAt: 1, offered: 0, drafted: 0 });
    expect(html).toContain("nothing to draft");
    expect(html).not.toContain("bk-warn");
  });
});

describe("backlogStripModel — degraded response (live fields absent)", () => {
  // The GET's catch branch returns only { byCollection:[], total, ingested,
  // queued:0, wikiUrlCount, generatedAt, errors } — no remaining/running/
  // watcherSeeded/batchSize/maxProposals.
  const degraded: IngestBacklogResponse = {
    byCollection: [],
    total: 0,
    ingested: 0,
    queued: 0,
    wikiUrlCount: 0,
    generatedAt: 222,
    errors: [{ source: "backlog", collection: "", error: "huginn down" }],
  };

  test("every number is a real integer — never NaN/undefined", () => {
    const m = backlogStripModel(degraded, 0);
    for (const n of [
      m.totalNeverIngested,
      m.eligibleNow,
      m.offeredStillQueued,
      m.draftsAwaitingReview,
      m.batchSize,
      m.maxProposals,
      m.drainNow,
    ]) {
      expect(Number.isFinite(n)).toBe(true);
    }
    // remaining falls back to queued(0) ⇒ nothing to drain, control hidden.
    expect(m.showRun).toBe(false);
  });

  test("confirm copy never renders NaN/undefined even when constants absent", () => {
    const m = backlogStripModel(degraded, 0);
    const copy = backlogConfirmHtml(m);
    expect(copy).not.toContain("NaN");
    expect(copy).not.toContain("undefined");
  });
});

describe("backlogBannerHtml — interrupted-run recovery (PR 3)", () => {
  test("absent when no interrupted run", () => {
    const m = backlogStripModel(base(), 0);
    expect(m.interrupted).toBeNull();
    expect(backlogBannerHtml(m)).toBe("");
  });

  test("renders the drafted/of counts + Recover/Dismiss actions", () => {
    const m = backlogStripModel(base({ interrupted: { at: 0, batchSize: 40, drafted: 0 } }), 0);
    const html = backlogBannerHtml(m);
    expect(html).toContain("was interrupted");
    expect(html).toContain(">0<"); // drafted
    expect(html).toContain(">40<"); // of batchSize
    expect(html).toContain('data-backlog-action="recover"');
    expect(html).toContain('data-backlog-action="dismiss"');
    // The banner is prepended to the full strip.
    expect(backlogStripHtml(m)).toStartWith('<div class="bk-banner">');
  });

  test("shows k of n when some drafts landed", () => {
    const m = backlogStripModel(base({ interrupted: { at: 0, batchSize: 40, drafted: 3 } }), 0);
    const html = backlogBannerHtml(m);
    expect(html).toContain(">3<");
    expect(html).toContain(">40<");
  });
});

describe("source-page drafter control", () => {
  test("available when uncovered docs exist and nothing is running", () => {
    const m = backlogStripModel(base(), 0);
    expect(m.sourceDraftAvailable).toBe(true);
    const html = backlogSourceDraftHtml(m);
    expect(html).toContain('data-backlog-action="source-draft"');
    // A collection <select> is rendered alongside the button.
    expect(html).toContain('data-backlog-select="source-draft"');
    // The button is appended to the full strip.
    expect(backlogStripHtml(m)).toContain("Draft source pages");
  });

  test("hidden while a run is in flight", () => {
    const m = backlogStripModel(base({ running: true }), 0);
    expect(m.sourceDraftAvailable).toBe(false);
    expect(backlogSourceDraftHtml(m)).toBe("");
  });

  test("hidden when nothing is queued", () => {
    const m = backlogStripModel(
      base({
        byCollection: [],
        queued: 0,
        remaining: 0,
        offeredStillQueued: 0,
        fresh: 0,
      }),
      0,
    );
    expect(m.sourceDraftAvailable).toBe(false);
    expect(m.sourceDraftOptions).toEqual([]);
    expect(m.sourceDraftDefaultCollection).toBe("");
    expect(backlogSourceDraftHtml(m)).toBe("");
  });

  test("available when ANY collection has uncovered docs (not just youtube)", () => {
    // A wiki whose only backlog is X — the multi-collection control offers it (the
    // <select> lets the user draft that collection).
    const m = backlogStripModel(
      base({
        byCollection: [
          { collection: "youtube-summaries", source: "youtube", label: "YouTube", total: 0, ingested: 0, queued: 0 },
          { collection: "x-articles", source: "x-article", label: "X", total: 0, ingested: 0, queued: 12 },
        ],
        queued: 12,
      }),
      0,
    );
    expect(m.sourceDraftAvailable).toBe(true);
    // Default selection = the largest queue (X here, since youtube is drained to 0).
    expect(m.sourceDraftDefaultCollection).toBe("x-articles");
  });

  test("default collection is the one with the largest queue", () => {
    const m = backlogStripModel(
      base({
        byCollection: [
          { collection: "youtube-summaries", source: "youtube", label: "YouTube", total: 0, ingested: 0, queued: 4 },
          { collection: "x-articles", source: "x-article", label: "X", total: 0, ingested: 0, queued: 40 },
          { collection: "tiktok-summaries", source: "tiktok", label: "TikTok", total: 0, ingested: 0, queued: 9 },
        ],
        queued: 53,
      }),
      0,
    );
    expect(m.sourceDraftDefaultCollection).toBe("x-articles");
  });

  test("select options carry each collection's queued count as the label + data-queued", () => {
    const html = backlogSourceDraftHtml(backlogStripModel(base(), 0));
    // base() → YouTube 310 (largest, pre-selected), X 7, Anthropic 7, TikTok 5.
    expect(html).toContain('value="youtube-summaries" data-queued="310" selected');
    expect(html).toContain("YouTube — 310 queued");
    expect(html).toContain('value="x-articles" data-queued="7"');
    expect(html).toContain("X — 7 queued");
    expect(html).toContain("TikTok — 5 queued");
    // The pre-selected default is enabled (largest queue > 0).
    expect(html).not.toContain('data-backlog-action="source-draft" disabled');
  });

  test("a 0-queued collection still appears as an option (the button re-gates client-side)", () => {
    const html = backlogSourceDraftHtml(
      backlogStripModel(
        base({
          byCollection: [
            { collection: "youtube-summaries", source: "youtube", label: "YouTube", total: 0, ingested: 0, queued: 5 },
            { collection: "x-articles", source: "x-article", label: "X", total: 0, ingested: 0, queued: 0 },
          ],
          queued: 5,
        }),
        0,
      ),
    );
    expect(html).toContain("X — 0 queued");
    expect(html).toContain('value="x-articles" data-queued="0"');
    // YouTube (5) is the default and > 0 → button enabled.
    expect(html).toContain('value="youtube-summaries" data-queued="5" selected');
    expect(html).not.toContain('data-backlog-action="source-draft" disabled');
  });

  test("hidden when the gardener is disabled (the source-draft route 400s then)", () => {
    const m = backlogStripModel(base({ gardenerEnabled: false }), 0);
    expect(m.sourceDraftAvailable).toBe(false);
    expect(backlogSourceDraftHtml(m)).toBe("");
  });

  test("an absent gardenerEnabled (degraded/older server) is treated as enabled", () => {
    // base() has youtube queued 310 and omits gardenerEnabled → shown.
    const m = backlogStripModel(base(), 0);
    expect(m.sourceDraftAvailable).toBe(true);
  });
});

describe("sourceDraftResultHtml", () => {
  const result = (over: Partial<SourceBacklogResult["totals"]> = {}): SourceBacklogResult => ({
    results: [],
    totals: { selected: 3, drafted: 2, covered: 0, skipped: 1, error: 0, ...over },
    totalQueued: 100,
    limit: 3,
  });

  test("null → empty", () => {
    expect(sourceDraftResultHtml(null)).toBe("");
  });

  test("error → failure note", () => {
    expect(sourceDraftResultHtml({ error: "boom" })).toContain("source draft failed: boom");
  });

  test("rolls up only the non-zero buckets", () => {
    const html = sourceDraftResultHtml(result());
    expect(html).toContain("2 drafted");
    expect(html).toContain("1 skipped");
    expect(html).not.toContain("covered");
    expect(html).toContain("of 3");
  });

  test("nothing selected → explicit note", () => {
    const html = sourceDraftResultHtml(result({ selected: 0, drafted: 0, skipped: 0 }));
    expect(html).toContain("no uncovered docs to draft");
  });

  test("names the collection when a label is passed", () => {
    expect(sourceDraftResultHtml(result(), "TikTok")).toContain("TikTok source pages:");
    expect(sourceDraftResultHtml({ error: "boom" }, "X")).toContain("X source draft failed: boom");
    expect(sourceDraftResultHtml(result({ selected: 0, drafted: 0, skipped: 0 }), "YouTube")).toContain(
      "YouTube source draft: no uncovered docs to draft",
    );
  });
});
