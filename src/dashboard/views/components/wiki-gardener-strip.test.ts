import { test, expect, describe } from "bun:test";
import {
  backlogStripModel,
  backlogControlHtml,
  backlogConfirmHtml,
  backlogProgressText,
  backlogProgressHtml,
  backlogOutcomeHtml,
  backlogBannerHtml,
  backlogStripHtml,
  type BacklogProgress,
  type IngestBacklogResponse,
} from "./wiki-gardener-strip.ts";

/**
 * The strip's honest-numbers contract + control gating are pure, so they're
 * tested here without a DOM (the browser entrypoint touches `document` at module
 * load and can't be imported in tests).
 *
 * Key invariant: "offered in past runs" and the reset gate/label both use
 * `queued − remaining` (offered-AND-still-queued), NOT the raw all-time `offered`
 * field — so the sentence always adds up (per-source Σ = total = eligible +
 * offered-still-queued).
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
    offered: 200, // all-time offered (includes since-consumed) — deliberately > queued-remaining
    remaining: 260,
    watcherSeeded: true,
    batchSize: 40,
    maxProposals: 8,
    ...over,
  };
}

describe("backlogStripModel — honest numbers", () => {
  test("offered-in-past-runs is queued − remaining, not the raw all-time offered", () => {
    const m = backlogStripModel(base(), 3);
    expect(m.totalNeverIngested).toBe(329);
    expect(m.eligibleNow).toBe(260);
    // queued(329) − remaining(260) = 69 — NOT the raw offered field (200).
    expect(m.offeredStillQueued).toBe(69);
    expect(m.draftsAwaitingReview).toBe(3);
    // The sentence adds up: eligible + offered-still-queued = total.
    expect(m.eligibleNow + m.offeredStillQueued).toBe(m.totalNeverIngested);
    // Per-source counts sum to the total.
    expect(m.perSource.reduce((s, p) => s + p.queued, 0)).toBe(329);
  });

  test("drainNow = min(batchSize, eligibleNow)", () => {
    expect(backlogStripModel(base(), 0).drainNow).toBe(40); // capped by batch
    expect(backlogStripModel(base({ remaining: 12 }), 0).drainNow).toBe(12); // capped by eligible
  });
});

describe("backlogStripModel — control gating", () => {
  test("zero queued → no run, no reset, not all-offered", () => {
    const m = backlogStripModel(
      base({ byCollection: [], queued: 0, remaining: 0, offered: 0 }),
      0,
    );
    expect(m.showRun).toBe(false);
    expect(m.showReset).toBe(false);
    expect(m.allOffered).toBe(false);
    expect(backlogControlHtml(m)).toBe("");
  });

  test("offered>0 with eligible left → both run and reset show", () => {
    const m = backlogStripModel(base(), 0);
    expect(m.showRun).toBe(true);
    expect(m.showReset).toBe(true);
    expect(m.allOffered).toBe(false);
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

  test("all-offered (remaining 0, queued>0) → 'all offered' + reset with re-run wording", () => {
    const m = backlogStripModel(base({ remaining: 0 }), 0);
    expect(m.allOffered).toBe(true);
    expect(m.showRun).toBe(false);
    expect(m.showReset).toBe(true); // queued − 0 = 329 offered-still-queued
    const html = backlogControlHtml(m);
    expect(html).toContain("all offered");
    expect(html).toContain("Reset to re-run");
    expect(html).not.toContain("Reset offered ("); // keep the all-offered wording
  });

  test("offered-still-queued 0 (everything consumed) → no reset button", () => {
    // remaining == queued ⇒ nothing offered-and-still-queued, so no "Reset offered (0)".
    const m = backlogStripModel(base({ queued: 5, remaining: 5, offered: 400 }), 0);
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
