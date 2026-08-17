/**
 * The board payload: column membership, the tile-vs-cards agreement, the
 * calibration sentence, and every way the money is allowed to disappear.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  buildBoardPayload,
  calibrationSentence,
  moneyBlockedReason,
  planWikiUrl,
  LEDGER_REBUILD_MARKER,
} from "./board.ts";
import { fetchPlanLedger, type PlanLedgerResult } from "./ledger.ts";
import { buildPricing } from "./estimate.ts";
import type { PlanRecord, PlanSourceResult } from "./source.ts";
import type { LedgerPlan } from "./ledger.ts";

const LEDGER_ROWS: LedgerPlan[] = JSON.parse(
  await Bun.file(path.join(import.meta.dir, "fixtures", "ledger-plans.json")).text(),
).plans;

const NOW = Date.parse("2026-08-17T12:00:00Z");

function rec(over: Partial<PlanRecord> & { slug: string }): PlanRecord {
  return {
    title: over.slug,
    planStatus: "proposed",
    statusDate: undefined,
    statusNote: undefined,
    followupsOpen: false,
    priority: undefined,
    tags: [],
    relPath: `plans/${over.slug}.mdx`,
    mtimeMs: 1_700_000_000_000,
    hash: `hash-${over.slug}`,
    ...over,
  };
}

/** Plans named after real ledger rows, so the join has something to price. */
const shippedSlugs = LEDGER_ROWS.filter((r) => r.planStatus === "shipped").map((r) => r.slug);

const PLANS: PlanRecord[] = [
  rec({ slug: "board-a", priority: "p1", statusDate: "2026-07-01", tags: ["board"] }),
  rec({ slug: "board-b", planStatus: "ready" }),
  rec({ slug: "board-c", planStatus: "in-flight", statusDate: "2026-08-01" }),
  rec({ slug: "board-d", planStatus: "blocked", statusNote: "waiting on huginn" }),
  rec({ slug: shippedSlugs[0]!, planStatus: "shipped", followupsOpen: true }),
  rec({ slug: shippedSlugs[1]!, planStatus: "shipped" }),
  rec({ slug: shippedSlugs[2]!, planStatus: "superseded" }),
  // The ledger prices this one: it is a shipped row, so its estimate is real.
  rec({ slug: shippedSlugs[3]!, planStatus: "proposed" }),
];

function source(over: Partial<PlanSourceResult> = {}): PlanSourceResult {
  return {
    root: "/tmp/mimir",
    plans: PLANS,
    queue: { order: { proposed: ["board-a"] }, hash: "queue-hash" },
    warnings: [],
    ...over,
  };
}

function ledger(over: Partial<PlanLedgerResult> = {}): PlanLedgerResult {
  return {
    fetchedAt: NOW,
    baseUrl: "http://127.0.0.1:8787",
    urlConfigured: true,
    ledgerConfigured: true,
    reachable: true,
    generatedAt: "2026-08-17T11:00:00.000Z",
    refreshedAt: "2026-08-17T10:00:00.000Z",
    plans: LEDGER_ROWS,
    ...over,
  };
}

const build = (s = source(), l = ledger()) => buildBoardPayload({ source: s, ledger: l, now: NOW });

describe("column membership", () => {
  test("every plan lands in exactly one column, follow-ups included", () => {
    const p = build();
    expect(p.cards).toHaveLength(PLANS.length);
    const byColumn = new Map<string, string[]>();
    for (const c of p.cards) byColumn.set(c.column, [...(byColumn.get(c.column) ?? []), c.slug]);
    expect(byColumn.get("proposed")).toEqual([shippedSlugs[3]!, "board-a"].sort());
    expect(byColumn.get("ready")).toEqual(["board-b"]);
    expect(byColumn.get("in-flight")).toEqual(["board-c"]);
    expect(byColumn.get("blocked")).toEqual(["board-d"]);
    expect(byColumn.get("followups")).toEqual([shippedSlugs[0]!]);
    expect(byColumn.get("shipped")!.sort()).toEqual([shippedSlugs[1]!, shippedSlugs[2]!].sort());
  });

  test("cards carry the disk priority, the hand order and the queue hash through", () => {
    const p = build();
    expect(p.cards.find((c) => c.slug === "board-a")!.priority).toBe("p1");
    expect(p.queue.order).toEqual({ proposed: ["board-a"] });
    expect(p.queue.hash).toBe("queue-hash");
  });

  test("age is measured from status_date only — an undated plan has none", () => {
    const p = build();
    // 2026-07-01 → 2026-08-17T12:00Z is 47½ days; the card says 47, because a
    // day is only counted once it has actually elapsed.
    expect(p.cards.find((c) => c.slug === "board-a")!.ageDays).toBe(47);
    expect(p.cards.find((c) => c.slug === "board-b")!.ageDays).toBeNull();
  });

  test("the reader link addresses the plan by relPath, so a same-stem page cannot shadow it", () => {
    // `?page=` resolves first-stem-match in the reader; `?relPath=` is the
    // collision-proof form the Atlas tab already uses.
    expect(planWikiUrl("plans/a-b.mdx")).toBe("/wiki?wiki=mimir&relPath=plans%2Fa-b.mdx");
    expect(planWikiUrl("plans/a b.md")).toBe("/wiki?wiki=mimir&relPath=plans%2Fa%20b.md");
  });

  test("the card's reader link is its own relPath", () => {
    const p = build();
    const a = p.cards.find((c) => c.slug === "board-a")!;
    expect(a.wikiUrl).toBe(`/wiki?wiki=mimir&relPath=${encodeURIComponent(a.relPath)}`);
  });
});

describe("the tile and the cards agree by construction", () => {
  test("backlog mid is the sum of the mids of the cards it names", () => {
    const p = build();
    expect(p.money.available).toBe(true);
    const named = p.meters.backlog!.slugs;
    expect(named.length).toBeGreaterThan(0);
    const sum = named
      .map((slug) => p.cards.find((c) => c.slug === slug)!.estimate!.mid!)
      .reduce((a, b) => a + b, 0);
    expect(p.meters.backlog!.mid).toBeCloseTo(sum, 9);
    // …and it names only ACTIVE cards that actually carry an estimate.
    for (const slug of named) {
      const card = p.cards.find((c) => c.slug === slug)!;
      expect(["proposed", "ready", "in-flight", "blocked"]).toContain(card.column);
      expect(card.estimate?.mid).not.toBeNull();
    }
  });

  test("spent to date is the terminal columns' recorded cost", () => {
    const p = build();
    const expected = p.cards
      .filter((c) => c.column === "shipped" || c.column === "followups")
      .reduce((s, c) => s + (c.ledger?.costUSD ?? 0), 0);
    expect(p.meters.spentToDate).toBeCloseTo(expected, 9);
  });
});

describe("calibration", () => {
  test("the sentence is computed — n, share and error all come from the score", () => {
    const p = build();
    expect(p.calibration!.n).toBeGreaterThan(0);
    const share = Math.round(p.calibration!.insideShare! * 100);
    const err = Math.round(p.calibration!.medianRelError! * 100);
    expect(p.calibrationSentence).toContain(`Over ${p.calibration!.n} shipped plans`);
    expect(p.calibrationSentence).toContain(`${share}% of the time`);
    expect(p.calibrationSentence).toContain(`median error ${err}%`);
  });

  test("it is not sold as accuracy, and the as-priced triple rides along", () => {
    const p = build();
    expect(p.calibrationSentence).toContain("in-sample");
    expect(p.calibrationSentence).toContain("by construction");
    expect(p.calibrationSentence).toContain("Priced the way a card is priced");
  });

  test("an empty score renders no sentence rather than 0%", () => {
    expect(calibrationSentence(null)).toBeNull();
    expect(calibrationSentence({ n: 0, inside: 0, insideShare: null, medianRelError: null, asPriced: null }))
      .toBeNull();
  });
});

describe("degrade: the money is one switch, and it is named", () => {
  test("unreachable ⇒ no money anywhere, every column and order intact", () => {
    const p = build(source(), ledger({ reachable: false, plans: [], errors: ["boom (http://127.0.0.1:8799)"] }));
    expect(p.money.available).toBe(false);
    expect(p.money.reason).toContain("http://127.0.0.1:8787");
    expect(p.cards).toHaveLength(PLANS.length);
    expect(p.cards.every((c) => c.estimate === null && c.ledger === null)).toBe(true);
    expect(p.meters.backlog).toBeNull();
    expect(p.meters.spentToDate).toBeNull();
    expect(p.calibration).toBeNull();
    expect(p.calibrationSentence).toBeNull();
    // The board is still a board: columns, priorities and the hand order survive.
    expect(new Set(p.cards.map((c) => c.column)).size).toBeGreaterThan(1);
    expect(p.cards.find((c) => c.slug === "board-a")!.priority).toBe("p1");
    expect(p.queue.order).toEqual({ proposed: ["board-a"] });
    expect(p.ledger.errors).toEqual(["boom (http://127.0.0.1:8799)"]);
  });

  test("a failed upstream rebuild hides the money — pinned to ledger.ts's own wording", async () => {
    // Built through fetchPlanLedger so the coupling to its message is tested,
    // not assumed: reword it there and this fails instead of silently
    // re-enabling money on rows a failed rebuild left behind.
    const result = await fetchPlanLedger(
      {
        urlConfigured: true,
        baseUrl: "http://127.0.0.1:8787",
        fetchPlans: async () => ({
          plans: LEDGER_ROWS,
          refreshError: "git pull timed out",
          refreshedAt: "2026-08-16T10:00:00.000Z",
          configured: true,
        }),
      },
      NOW,
    );
    expect(result.reachable).toBe(true);
    expect(result.errors!.some((e) => e.includes(LEDGER_REBUILD_MARKER))).toBe(true);
    const p = build(source(), result);
    expect(p.money.available).toBe(false);
    expect(p.money.reason).toContain("last rebuild failed");
    expect(p.cards.every((c) => c.estimate === null)).toBe(true);
  });

  test("claude-usage with no plans directory hides the money", () => {
    const p = build(source(), ledger({ ledgerConfigured: false, plans: [] }));
    expect(p.money.available).toBe(false);
    expect(p.money.reason).toContain("no plans directory");
  });

  test("too few shipped plans to price anything hides the money rather than showing $0", () => {
    const thin = LEDGER_ROWS.filter((r) => r.planStatus === "shipped").slice(0, 1);
    const p = build(source(), ledger({ plans: thin }));
    expect(p.money.available).toBe(false);
    expect(p.money.reason).toContain("shipped plan(s) with a cost");
    // Every other blocked reason names the host it read; a thin pool is the one
    // a reader is most likely to check against the wrong claude-usage.
    expect(p.money.reason).toContain("http://127.0.0.1:8787");
  });

  test("errors[] with reachable:true is a caveat, not a blackout", () => {
    const p = build(source(), ledger({ errors: ["claude-usage plans: 2 row(s) carried no slug — dropped"] }));
    expect(p.money.available).toBe(true);
    expect(p.money.reason).toBeNull();
    expect(p.ledger.errors).toHaveLength(1);
    expect(p.meters.backlog).not.toBeNull();
  });

  test("moneyBlockedReason asks the questions in the order a reader would", () => {
    const pricing = buildPricing(LEDGER_ROWS);
    expect(moneyBlockedReason(ledger({ reachable: false }), pricing)).toContain("did not answer");
    expect(moneyBlockedReason(ledger(), pricing)).toBeNull();
  });
});

describe("degrade: the wiki side", () => {
  test("an unregistered mimir is a rendered state, not a throw", () => {
    const p = build(
      source({ root: null, plans: [], queue: { order: {}, hash: "" }, warnings: ["wiki \"mimir\" is not registered — set WIKI_EXTRA=mimir=<path>"] }),
      ledger(),
    );
    expect(p.wiki.registered).toBe(false);
    expect(p.wiki.root).toBeNull();
    expect(p.cards).toEqual([]);
    expect(p.meters.activeCount).toBe(0);
    expect(p.warnings[0]).toContain("WIKI_EXTRA");
    expect(p.columns).toHaveLength(6);
  });

  test("source warnings ride along as caveats", () => {
    const p = build(source({ warnings: ["plans/x.md: priority \"p9\" is not in the enum — dropped"] }));
    expect(p.warnings).toHaveLength(1);
    expect(p.money.available).toBe(true);
  });
});

describe("family survives the degrade", () => {
  test("a card with no ledger row still gets a family from its slug", () => {
    const p = build(source({ plans: [rec({ slug: "muninn-plan-board-page" })] }), ledger({ reachable: false, plans: [] }));
    const card = p.cards[0]!;
    expect(card.family).toBe("muninn");
    expect(card.familySource).toBe("slug");
    expect(card.estimate).toBeNull();
    expect(p.families).toEqual([{ family: "muninn", count: 1 }]);
  });

  test("a slug naming no known repo is 'unknown', never null", () => {
    const p = build(source({ plans: [rec({ slug: "zzz-nothing" })] }), ledger({ reachable: false, plans: [] }));
    expect(p.cards[0]!.family).toBe("unknown");
    expect(p.cards[0]!.familySource).toBeNull();
  });
});

describe("ledger facts", () => {
  test("the drawer's numbers come off the row, including the untyped extras", () => {
    const row: LedgerPlan = {
      slug: "extras",
      planStatus: "shipped",
      landed: 4,
      costUSD: 120,
      total: 4,
      findings: 9,
      merges: 4,
      prs: [{ prNumber: 7, url: "https://example.test/pr/7", repo: "muninn", reviewed: true }],
      ...({ activeHours: 6.5, maxRounds: 3, handovers: 2, legs: [{}, {}, {}], description: "a plan" } as object),
    };
    const p = build(source({ plans: [rec({ slug: "extras", planStatus: "shipped" })] }), ledger({ plans: [...LEDGER_ROWS, row] }));
    const card = p.cards[0]!;
    expect(card.description).toBe("a plan");
    expect(card.ledger).toEqual({
      costUSD: 120,
      landed: 4,
      merges: 4,
      activeHours: 6.5,
      findings: 9,
      maxRounds: 3,
      handovers: 2,
      sessions: 3,
      prs: [
        {
          number: 7,
          url: "https://example.test/pr/7",
          repo: "muninn",
          mergedAt: null,
          reviewed: true,
          findings: null,
          rounds: null,
          subject: null,
        },
      ],
    });
  });

  test("a ledger row naming no plan on disk is reported, not rendered", () => {
    const p = build(source({ plans: [rec({ slug: "board-a" })] }));
    expect(p.ledgerOnlySlugs.length).toBe(LEDGER_ROWS.length);
    expect(p.cards).toHaveLength(1);
  });
});
