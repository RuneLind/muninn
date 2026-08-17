import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  buildPricing,
  calibration,
  declaredPrCount,
  estimate,
  normalizeRepo,
  planFamily,
  poolFor,
  quantile,
  repoFamily,
  CLAUDE_FAMILY,
  GLOBAL_POOL,
  MIN_FAMILY_SAMPLES,
} from "./estimate.ts";
import type { LedgerPlan } from "./ledger.ts";

const fixture = (await Bun.file(
  path.join(import.meta.dir, "fixtures", "ledger-plans.json"),
).json()) as { plans: LedgerPlan[] };
const FIXTURE_PLANS = fixture.plans;

describe("normalizeRepo", () => {
  test("strips the trailing semicolon the live payload carries", () => {
    expect(normalizeRepo("/Users/rune/source/private/claude-usage;")).toBe("claude-usage");
    expect(normalizeRepo("/Users/rune/source/private/claude-usage")).toBe("claude-usage");
  });

  test("maps a checkout subdirectory onto its repo", () => {
    expect(normalizeRepo("/Users/rune/source/private/huginn/huginn-jarvis")).toBe("huginn");
  });

  test("understands the short owner/repo form", () => {
    expect(normalizeRepo("RuneLind/muninn")).toBe("muninn");
    expect(normalizeRepo("RuneLind/huginn")).toBe("huginn");
  });

  test("non-repo paths fall through to null (the global pool)", () => {
    expect(normalizeRepo("/private/tmp")).toBeNull();
    expect(normalizeRepo("/Users/rune/source/private")).toBeNull();
    expect(normalizeRepo("")).toBeNull();
    expect(normalizeRepo(null)).toBeNull();
    expect(normalizeRepo(undefined)).toBeNull();
  });
});

describe("repoFamily", () => {
  test("groups the claude-* tool repos and leaves everything else alone", () => {
    expect(repoFamily("claude-usage")).toBe(CLAUDE_FAMILY);
    expect(repoFamily("claude-skills")).toBe(CLAUDE_FAMILY);
    expect(repoFamily("claude-hivemind")).toBe(CLAUDE_FAMILY);
    expect(repoFamily("muninn")).toBe("muninn");
    expect(repoFamily(null)).toBeNull();
  });
});

describe("planFamily", () => {
  test("buckets by the majority repo and reports the mix", () => {
    const fam = planFamily([
      { repo: "/Users/rune/source/private/muninn" },
      { repo: "/Users/rune/source/private/muninn" },
      { repo: "/Users/rune/source/private/mimir" },
    ]);
    expect(fam.family).toBe("muninn");
    expect(fam.mixed).toBe(true);
    expect(fam.counts).toEqual([
      { family: "muninn", prs: 2 },
      { family: "mimir", prs: 1 },
    ]);
  });

  test("a tie breaks on first-seen, deterministically", () => {
    const a = planFamily([{ repo: "…/mimir" }, { repo: "…/muninn" }]);
    const b = planFamily([{ repo: "…/muninn" }, { repo: "…/mimir" }]);
    expect(a.family).toBe("mimir");
    expect(b.family).toBe("muninn");
  });

  test("no known repo ⇒ no family", () => {
    expect(planFamily([{ repo: "/private/tmp" }]).family).toBeNull();
    expect(planFamily([]).family).toBeNull();
    expect(planFamily(null).family).toBeNull();
  });
});

describe("quantile", () => {
  test("interpolates linearly and handles the degenerate cases", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 10);
    expect(quantile([5], 0.75)).toBe(5);
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe("buildPricing over the fixture", () => {
  const pricing = buildPricing(FIXTURE_PLANS);

  test("the dirty repo string never becomes its own family", () => {
    expect([...pricing.families.keys()]).not.toContain("claude-usage;");
    expect([...pricing.families.keys()]).not.toContain("/Users/rune/source/private/claude-usage;");
    // …and the plan carrying it prices as an ordinary claude-* plan.
    const weekly = pricing.samples.find((s) => s.slug === "claude-usage-series-weekly-pct")!;
    expect(weekly.family).toBe(CLAUDE_FAMILY);
  });

  test("a shipped plan with zero PRs contributes no sample but is not an error", () => {
    expect(pricing.samples.map((s) => s.slug)).not.toContain("claude-skills-followup-audit-fixes");
  });

  test("only shipped plans price anything", () => {
    const slugs = new Set(pricing.samples.map((s) => s.slug));
    for (const plan of FIXTURE_PLANS) {
      if (plan.planStatus !== "shipped") expect(slugs.has(plan.slug)).toBe(false);
    }
  });

  test("$/PR is cost divided by LANDED PRs", () => {
    const plan = FIXTURE_PLANS.find((p) => p.slug === "claude-hivemind-architecture-fixes")!;
    const sample = pricing.samples.find((s) => s.slug === plan.slug)!;
    expect(sample.dollarsPerPR).toBeCloseTo(plan.costUSD! / plan.landed!, 10);
  });

  test("unmatched repo strings are reported rather than silently pooled", () => {
    expect(pricing.unknownRepoStrings.map((u) => u.repo)).toContain(
      "/Users/rune/source/private",
    );
  });
});

describe("estimate", () => {
  test("a thin family falls back to the global pool and says so", () => {
    // One mimir sample only — below MIN_FAMILY_SAMPLES.
    const plans: LedgerPlan[] = [
      mkShipped("m1", "mimir", 2, 100),
      mkShipped("u1", "muninn", 2, 40),
      mkShipped("u2", "muninn", 2, 60),
      mkShipped("u3", "muninn", 2, 80),
    ];
    const pricing = buildPricing(plans);
    expect(pricing.families.get("mimir")!.n).toBe(1);
    expect(MIN_FAMILY_SAMPLES).toBe(3);

    const thin = estimate(mkActive("new-mimir", "mimir", 2), pricing);
    expect(thin.pool).toBe("global");
    expect(thin.poolKey).toBe(GLOBAL_POOL);
    expect(thin.sampleSize).toBe(4);

    const thick = estimate(mkActive("new-muninn", "muninn", 2), pricing);
    expect(thick.pool).toBe("family");
    expect(thick.poolKey).toBe("muninn");
    expect(thick.sampleSize).toBe(3);
    // muninn $/PR samples: 20, 30, 40 ⇒ p50 = 30, band 25–35 per PR.
    expect(thick.dollarsPerPR).toEqual({ p25: 25, p50: 30, p75: 35 });
    expect(thick.low).toBe(50);
    expect(thick.mid).toBe(60);
    expect(thick.high).toBe(70);
  });

  test("a plan declaring no slate assumes the pool median and is flagged", () => {
    const pricing = buildPricing([
      mkShipped("u1", "muninn", 2, 40),
      mkShipped("u2", "muninn", 4, 120),
      mkShipped("u3", "muninn", 6, 180),
    ]);
    const undeclared = mkActive("x", "muninn", undefined);
    const est = estimate(undeclared, pricing);
    expect(est.assumedCount).toBe(true);
    expect(est.prCount).toBe(4); // median landed PRs of the pool
    const declared = estimate(mkActive("y", "muninn", 3), pricing);
    expect(declared.assumedCount).toBe(false);
    expect(declared.prCount).toBe(3);
  });

  test("a mixed-repo plan is priced by its majority family and says which", () => {
    const pricing = buildPricing([
      mkShipped("u1", "muninn", 2, 40),
      mkShipped("u2", "muninn", 2, 60),
      mkShipped("u3", "muninn", 2, 80),
    ]);
    const mixed: LedgerPlan = {
      slug: "mixed",
      planStatus: "in-flight",
      total: 3,
      prs: [
        { repo: "/Users/rune/source/private/muninn" },
        { repo: "/Users/rune/source/private/muninn" },
        { repo: "/Users/rune/source/private/mimir" },
      ],
    };
    const est = estimate(mixed, pricing);
    expect(est.family).toBe("muninn");
    expect(est.mixedRepos).toBe(true);
  });

  test("an empty corpus prices nothing rather than inventing a band", () => {
    const est = estimate(mkActive("x", "muninn", 3), buildPricing([]));
    expect(est.pool).toBe("none");
    expect(est.low).toBeNull();
    expect(est.mid).toBeNull();
    expect(est.high).toBeNull();
    expect(est.dollarsPerPR).toBeNull();
  });

  test("declaredPrCount prefers `total` and falls back to the slate length", () => {
    expect(declaredPrCount({ slug: "a", total: 4, slate: [1, 2] })).toBe(4);
    expect(declaredPrCount({ slug: "a", total: null, slate: [1, 2] })).toBe(2);
    expect(declaredPrCount({ slug: "a", total: null, slate: [] })).toBeUndefined();
    expect(declaredPrCount({ slug: "a" })).toBeUndefined();
  });

  test("poolFor returns null only when nothing has ever shipped", () => {
    expect(poolFor(buildPricing([]), "muninn")).toBeNull();
  });
});

describe("calibration", () => {
  test("scores shipped plans against their own band, at their ACTUAL PR count", () => {
    // Three muninn plans at 20/30/40 $/PR ⇒ band 25–35. Only the middle one
    // lands inside; the outer two are the p25/p75 endpoints themselves and sit
    // just outside their own interpolated band.
    const plans = [
      mkShipped("u1", "muninn", 2, 40),
      mkShipped("u2", "muninn", 2, 60),
      mkShipped("u3", "muninn", 2, 80),
    ];
    const cal = calibration(plans, buildPricing(plans));
    expect(cal.n).toBe(3);
    expect(cal.inside).toBe(1);
    expect(cal.insideShare).toBeCloseTo(1 / 3, 10);
    // |60 − 40|/40 = 0.5 · |60 − 60|/60 = 0 · |60 − 80|/80 = 0.25 ⇒ median 0.25
    expect(cal.medianRelError).toBeCloseTo(0.25, 10);
  });

  test("an empty sample reports null shares rather than NaN", () => {
    const cal = calibration([], buildPricing([]));
    expect(cal).toEqual({ n: 0, inside: 0, insideShare: null, medianRelError: null });
  });

  test("runs over the real fixture", () => {
    const cal = calibration(FIXTURE_PLANS, buildPricing(FIXTURE_PLANS));
    expect(cal.n).toBeGreaterThan(0);
    expect(cal.insideShare).toBeGreaterThanOrEqual(0);
    expect(cal.insideShare).toBeLessThanOrEqual(1);
    expect(cal.medianRelError).toBeGreaterThanOrEqual(0);
  });
});

function mkShipped(slug: string, repo: string, landed: number, cost: number): LedgerPlan {
  return {
    slug,
    planStatus: "shipped",
    landed,
    costUSD: cost,
    total: landed,
    slate: Array.from({ length: landed }, (_, i) => i + 1),
    prs: Array.from({ length: landed }, () => ({ repo: `/Users/rune/source/private/${repo}` })),
  };
}

function mkActive(slug: string, repo: string, total: number | undefined): LedgerPlan {
  return {
    slug,
    planStatus: "proposed",
    total: total ?? null,
    slate: total ? Array.from({ length: total }, (_, i) => i + 1) : [],
    prs: [{ repo: `/Users/rune/source/private/${repo}` }],
  };
}
