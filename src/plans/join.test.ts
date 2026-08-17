import { describe, expect, test } from "bun:test";
import { joinPlans } from "./join.ts";
import type { PlanRecord } from "./source.ts";
import type { LedgerPlan } from "./ledger.ts";

function rec(slug: string): PlanRecord {
  return {
    slug,
    title: slug,
    planStatus: "proposed",
    statusDate: undefined,
    statusNote: undefined,
    followupsOpen: false,
    priority: undefined,
    tags: [],
    relPath: `plans/${slug}.md`,
    mtimeMs: 0,
    hash: "h",
  };
}

const SHIPPED: LedgerPlan[] = [1, 2, 3].map((i) => ({
  slug: `shipped-${i}`,
  planStatus: "shipped",
  landed: 2,
  costUSD: 20 * i,
  total: 2,
  prs: [
    { repo: "/Users/rune/source/private/muninn" },
    { repo: "/Users/rune/source/private/muninn" },
  ],
}));

describe("joinPlans", () => {
  test("is outer on the mimir side — a plan with no ledger row is still a card", () => {
    const res = joinPlans([rec("a"), rec("b")], [{ slug: "a", planStatus: "proposed" }]);
    expect(res.plans.map((p) => p.plan.slug)).toEqual(["a", "b"]);
    expect(res.plans[0]!.ledger).not.toBeNull();
    expect(res.plans[1]!.ledger).toBeNull();
    expect(res.plans[1]!.estimate).toBeNull();
  });

  test("reports ledger rows naming no plan on disk", () => {
    const res = joinPlans([rec("a")], [{ slug: "a" }, { slug: "gone" }, { slug: "also-gone" }]);
    expect(res.ledgerOnlySlugs).toEqual(["also-gone", "gone"]);
  });

  test("prices joined plans off the FULL ledger, retired rows included", () => {
    const active: LedgerPlan = {
      slug: "active",
      planStatus: "in-flight",
      total: 3,
      prs: [{ repo: "/Users/rune/source/private/muninn" }],
    };
    const res = joinPlans([rec("active")], [...SHIPPED, active]);
    const est = res.plans[0]!.estimate!;
    // Three muninn samples at 10/20/30 $/PR ⇒ family pool, band 15–25 × 3 PRs.
    expect(est.pool).toBe("family");
    expect(est.sampleSize).toBe(3);
    expect(est.prCount).toBe(3);
    expect(est.low).toBe(45);
    expect(est.mid).toBe(60);
    expect(est.high).toBe(75);
    expect(res.pricing.samples).toHaveLength(3);
  });

  test("a duplicate ledger slug resolves deterministically to the first row", () => {
    const res = joinPlans(
      [rec("a")],
      [{ slug: "a", title: "first" }, { slug: "a", title: "second" }],
    );
    expect(res.plans[0]!.ledger!.title).toBe("first");
    expect(res.ledgerOnlySlugs).toEqual([]);
  });
});
