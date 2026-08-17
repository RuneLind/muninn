/**
 * Route-shape test for `/plans` and `GET /api/plans/board`. The payload itself
 * is covered in `src/plans/board.test.ts`; this pins the HTTP contract:
 *
 *   - the page and the API serve the SAME assembly,
 *   - neither 5xx's, on any degraded input — a dead ledger, an unreadable
 *     plans directory, a throwing source,
 *   - the degrade states a reader needs are in the HTML itself, not only in
 *     the bundle that renders the cards.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { assemblePlanBoard, registerPlansRoutes, type PlanBoardDeps } from "./plans-routes.ts";
import type { Config } from "../../config.ts";
import type { PlanSourceResult } from "../../plans/source.ts";
import type { LedgerPlan } from "../../plans/ledger.ts";

const CONFIG = { claudeUsageUrl: "http://127.0.0.1:8799" } as Config;

const SHIPPED: LedgerPlan[] = [1, 2, 3, 4].map((i) => ({
  slug: `muninn-shipped-${i}`,
  planStatus: "shipped",
  landed: 2,
  total: 2,
  costUSD: 40 * i,
  merges: 2,
  findings: 3,
  prs: [
    { repo: "/Users/rune/source/private/muninn", prNumber: i * 10, reviewed: true },
    { repo: "/Users/rune/source/private/muninn", prNumber: i * 10 + 1, reviewed: true },
  ],
}));

/** The ledger knows the unfinished plan too — it reads the same plans/ dir —
 *  and that row (a declared slate, nothing landed) is what makes it priceable. */
const LEDGER: LedgerPlan[] = [
  ...SHIPPED,
  { slug: "muninn-plan-board-page", planStatus: "proposed", total: 3, landed: 0, costUSD: 0, prs: [] },
];

const SOURCE: PlanSourceResult = {
  root: "/tmp/mimir",
  plans: [
    {
      slug: "muninn-plan-board-page",
      title: "The read-only board page",
      planStatus: "proposed",
      statusDate: "2026-08-01",
      statusNote: undefined,
      followupsOpen: false,
      priority: "p1",
      tags: ["board"],
      relPath: "plans/muninn-plan-board-page.mdx",
      mtimeMs: 1,
      hash: "h1",
    },
    {
      slug: "muninn-shipped-1",
      title: "Something that shipped",
      planStatus: "shipped",
      statusDate: "2026-07-01",
      statusNote: undefined,
      followupsOpen: true,
      priority: undefined,
      tags: [],
      relPath: "plans/muninn-shipped-1.md",
      mtimeMs: 2,
      hash: "h2",
    },
  ],
  queue: { order: { proposed: ["muninn-plan-board-page"] }, hash: "qhash" },
  warnings: [],
};

function deps(over: Partial<PlanBoardDeps> = {}): PlanBoardDeps {
  return {
    loadSource: async () => SOURCE,
    ledger: {
      urlConfigured: true,
      baseUrl: "http://127.0.0.1:8799",
      fetchPlans: async () => ({ plans: LEDGER, configured: true, generatedAt: "2026-08-17T10:00:00Z" }),
    },
    ...over,
  };
}

function app(d: PlanBoardDeps): Hono {
  const a = new Hono();
  registerPlansRoutes(a, CONFIG, d);
  return a;
}

describe("GET /api/plans/board", () => {
  test("serves the assembled board, money and all", async () => {
    const res = await app(deps()).request("/api/plans/board");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.money.available).toBe(true);
    expect(body.cards.map((c: { slug: string }) => c.slug).sort()).toEqual([
      "muninn-plan-board-page",
      "muninn-shipped-1",
    ]);
    expect(body.cards.find((c: { slug: string }) => c.slug === "muninn-shipped-1").column).toBe("followups");
    expect(body.queue).toEqual({ order: { proposed: ["muninn-plan-board-page"] }, hash: "qhash" });
    expect(body.meters.backlog.slugs).toEqual(["muninn-plan-board-page"]);
    expect(body.meters.backlog.mid).toBe(
      body.cards.find((c: { slug: string }) => c.slug === "muninn-plan-board-page").estimate.mid,
    );
    expect(body.calibrationSentence).toContain("shipped plans");
  });

  test("a dead ledger is a 200 with no money and the URL it tried", async () => {
    const res = await app(
      deps({
        ledger: {
          urlConfigured: true,
          baseUrl: "http://127.0.0.1:8799",
          fetchPlans: async () => {
            throw new Error("connection refused (http://127.0.0.1:8799/api/plans)");
          },
        },
      }),
    ).request("/api/plans/board");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.money.available).toBe(false);
    expect(body.ledger.baseUrl).toBe("http://127.0.0.1:8799");
    expect(body.ledger.errors[0]).toContain("connection refused");
    // The board is still a board.
    expect(body.cards).toHaveLength(2);
    expect(body.cards[0].priority ?? body.cards[1].priority).toBe("p1");
    expect(body.queue.order.proposed).toEqual(["muninn-plan-board-page"]);
  });

  test("a source that THROWS degrades to an empty corpus, never a 500", async () => {
    const res = await app(
      deps({
        loadSource: async () => {
          throw new Error("EACCES: permission denied, scandir '/tmp/mimir/plans'");
        },
      }),
    ).request("/api/plans/board");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cards).toEqual([]);
    expect(body.warnings[0]).toContain("EACCES");
    expect(body.wiki.registered).toBe(false);
  });
});

describe("GET /plans", () => {
  test("renders the page with the same payload embedded", async () => {
    const d = deps();
    const res = await app(d).request("/plans");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("window.PLAN_BOARD =");
    expect(html).toContain("muninn-plan-board-page");
    expect(html).toContain('href="/plans"');
    // The embedded object is the assembly, field for field (bar the instant).
    const embedded = JSON.parse(
      html.split("window.PLAN_BOARD = ")[1]!.split(";\n")[0]!.replace(/\\u003c/g, "<"),
    );
    const fresh = await assemblePlanBoard(d, embedded.generatedAt);
    expect(embedded).toEqual(JSON.parse(JSON.stringify(fresh)));
  });

  test("the degrade banner is in the HTML, not only in the bundle", async () => {
    const res = await app(
      deps({
        ledger: {
          urlConfigured: true,
          baseUrl: "http://127.0.0.1:8799",
          fetchPlans: async () => {
            throw new Error("connect ECONNREFUSED 127.0.0.1:8799");
          },
        },
      }),
    ).request("/plans");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No money on this board");
    expect(html).toContain("http://127.0.0.1:8799");
    expect(html).toContain("ECONNREFUSED");
  });

  test("an unregistered mimir renders one honest state, still 200", async () => {
    const res = await app(
      deps({
        loadSource: async () => ({
          root: null,
          plans: [],
          queue: { order: {}, hash: "" },
          warnings: ['wiki "mimir" is not registered — set WIKI_EXTRA=mimir=<path>'],
        }),
      }),
    ).request("/plans");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("wiki not registered on this host");
    expect(html).toContain("WIKI_EXTRA");
  });

  test("a payload value carrying </script> cannot break out of the embed", async () => {
    const res = await app(
      deps({
        loadSource: async () => ({
          ...SOURCE,
          warnings: ["</script><script>alert(1)</script>"],
        }),
      }),
    ).request("/plans");
    const html = await res.text();
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
  });
});
