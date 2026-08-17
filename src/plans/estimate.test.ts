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

  test("case and a trailing .git are normalization, not new repos", () => {
    expect(normalizeRepo("RuneLind/Muninn")).toBe("muninn");
    expect(normalizeRepo("/Users/rune/source/private/MUNINN")).toBe("muninn");
    expect(normalizeRepo("RuneLind/muninn.git")).toBe("muninn");
    expect(normalizeRepo("git@github.com:RuneLind/muninn.git")).toBe("muninn");
    expect(normalizeRepo("https://github.com/RuneLind/huginn.git")).toBe("huginn");
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

  test("a tie does NOT depend on PR array order", () => {
    // Array order is the ledger's, not a fact about the plan: reversing it must
    // not re-price the card.
    const prs = [{ repo: "…/mimir" }, { repo: "…/muninn" }];
    const a = planFamily(prs);
    const b = planFamily([...prs].reverse());
    expect(a.family).toBe(b.family);
    expect(a.counts).toEqual(b.counts);
  });

  test("a tie prefers the family the SLUG names, then the thicker pool", () => {
    const prs = [{ repo: "…/mimir" }, { repo: "…/muninn" }];
    expect(planFamily(prs, { slug: "muninn-some-plan" }).family).toBe("muninn");
    expect(planFamily([...prs].reverse(), { slug: "muninn-some-plan" }).family).toBe("muninn");
    expect(planFamily(prs, { slug: "mimir-some-plan" }).family).toBe("mimir");
    // No slug to go on ⇒ the pool with more samples behind it wins.
    const poolSize = (f: string) => (f === "muninn" ? 9 : 1);
    expect(planFamily(prs, { poolSize }).family).toBe("muninn");
    expect(planFamily([...prs].reverse(), { poolSize }).family).toBe("muninn");
  });

  test("no known repo ⇒ no family", () => {
    expect(planFamily([{ repo: "/private/tmp" }]).family).toBeNull();
    expect(planFamily([]).family).toBeNull();
    expect(planFamily(null).family).toBeNull();
    expect(planFamily([]).familySource).toBeNull();
  });

  test("a plan with no PRs is bucketed by its slug, and says so", () => {
    // 78 of the live corpus's 185 cards carry no PR row at all (measured
    // 2026-08-17 against /api/plans); reading only `prs` drops every one of
    // those into the global pool even when the repo is written on the front of
    // its name.
    const fam = planFamily([], { slug: "muninn-plan-board-join" });
    expect(fam.family).toBe("muninn");
    expect(fam.familySource).toBe("slug");
    expect(planFamily(null, { slug: "claude-hivemind-builtin-messaging" }).family).toBe(
      CLAUDE_FAMILY,
    );
    expect(planFamily([], { slug: "huginn-x" }).family).toBe("huginn");
    expect(planFamily([], { slug: "mac-mini-headless-agent-setup" }).family).toBeNull();
    expect(planFamily([], { slug: "consolidate-working-docs-into-mimir" }).family).toBeNull();
  });

  test("PRs beat the slug when they actually agree on a repo", () => {
    const fam = planFamily([{ repo: "…/huginn" }, { repo: "…/huginn" }], { slug: "muninn-thing" });
    expect(fam.family).toBe("huginn");
    expect(fam.familySource).toBe("prs");
    expect(fam.confident).toBe(true);
  });

  test("unnormalizable repo strings count as `unknown` and cost the family its majority", () => {
    // The live shape: one muninn PR beside five bare `/Users/rune/source/private`
    // strings. Reading only the known ones calls that a confident muninn plan.
    const fam = planFamily(
      [
        { repo: "/Users/rune/source/private/muninn" },
        ...Array.from({ length: 5 }, () => ({ repo: "/Users/rune/source/private" })),
      ],
      { slug: "muninn-code-review-fixes" },
    );
    expect(fam.counts).toEqual([
      { family: "unknown", prs: 5 },
      { family: "muninn", prs: 1 },
    ]);
    expect(fam.mixed).toBe(true);
    expect(fam.confident).toBe(false);
    // …and with no strict majority, the slug is the better evidence.
    expect(fam.family).toBe("muninn");
    expect(fam.familySource).toBe("slug");
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

  test("the trailing-punctuation strip is what keeps a dirty string in its family", () => {
    // Deliberately a NON-`claude-` string and a slug that names no repo: the
    // claude-* version of this assertion passes with the strip removed (the
    // clean PRs and the slug both still say claude-*), which makes it inert.
    const dirty = "/Users/rune/source/private/muninn;";
    const p = buildPricing([
      {
        slug: "some-unprefixed-plan",
        planStatus: "shipped",
        landed: 2,
        costUSD: 50,
        prs: [{ repo: dirty }, { repo: dirty }],
      },
    ]);
    expect(p.unknownRepoStrings.map((u) => u.repo)).not.toContain(dirty);
    expect([...p.families.keys()]).toEqual(["muninn"]);
    expect(p.samples[0]!.family).toBe("muninn");
  });

  test("a shipped plan with zero PRs contributes no sample but is not an error", () => {
    expect(pricing.samples.map((s) => s.slug)).not.toContain("claude-skills-followup-audit-fixes");
  });

  test("the checked-in corpus exercises the FAMILY path, not only the global one", () => {
    // A fixture where every family is thin would let a family-pool regression
    // ship green — every card would fall back to global and still look right.
    const thick = [...pricing.families.values()].filter((f) => f.n >= MIN_FAMILY_SAMPLES);
    expect(thick.length).toBeGreaterThan(0);
    expect(pricing.families.get("muninn")!.n).toBeGreaterThanOrEqual(MIN_FAMILY_SAMPLES);
  });

  test("the live repo-string zoo normalizes the way the board assumes", () => {
    const strings = new Set<string>();
    for (const plan of FIXTURE_PLANS) for (const pr of plan.prs ?? []) if (pr.repo) strings.add(pr.repo);
    // The four shapes the live payload actually carries beyond a clean path.
    expect(strings).toContain("RuneLind/muninn");
    expect(strings).toContain("RuneLind/huginn");
    expect(strings).toContain("/private/tmp");
    expect(strings).toContain("/Users/rune/source/private/huginn/huginn-jarvis");
    // Only the genuinely repo-less ones are reported as unknown.
    expect(pricing.unknownRepoStrings.map((u) => u.repo).sort()).toEqual([
      "/Users/rune/source/private",
      "/private/tmp",
    ]);
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

  test("declaredPrCount refuses a count that is not a positive whole number", () => {
    // A `total` of 2.5 or -1 is upstream garbage, and multiplying a band by it
    // renders a confident wrong number rather than an honest assumed one.
    expect(declaredPrCount({ slug: "a", total: 2.5 })).toBeUndefined();
    expect(declaredPrCount({ slug: "a", total: -1 })).toBeUndefined();
    expect(declaredPrCount({ slug: "a", total: 0 })).toBeUndefined();
    expect(declaredPrCount({ slug: "a", total: Number.NaN })).toBeUndefined();
  });

  test("a zero countOverride means 'no override', not a zero-PR plan", () => {
    const pricing = buildPricing([
      mkShipped("u1", "muninn", 2, 40),
      mkShipped("u2", "muninn", 2, 60),
      mkShipped("u3", "muninn", 2, 80),
    ]);
    const est = estimate(mkActive("x", "muninn", 3), pricing, 0);
    expect(est.prCount).toBe(3);
    expect(est.assumedCount).toBe(false);
  });

  test("a plan with no PRs is priced off the family its SLUG names", () => {
    // The live shape: `claude-hivemind-builtin-messaging` declares 2 PRs and has
    // landed none, so `prs` is empty and only the slug says claude-*.
    const plan = FIXTURE_PLANS.find((p) => p.slug === "claude-hivemind-builtin-messaging")!;
    expect(plan.prs ?? []).toHaveLength(0);
    expect(plan.total).toBe(2);
    const pricing = buildPricing(FIXTURE_PLANS);
    const est = estimate(plan, pricing);
    expect(est.family).toBe(CLAUDE_FAMILY);
    expect(est.familySource).toBe("slug");
    expect(est.pool).toBe("family");
    expect(est.poolKey).toBe(CLAUDE_FAMILY);
    expect(est.prCount).toBe(2);
  });

  test("poolFor returns null only when nothing has ever shipped", () => {
    expect(poolFor(buildPricing([]), "muninn")).toBeNull();
  });

  test("a global pool thinner than MIN_FAMILY_SAMPLES prices nothing at all", () => {
    // Two shipped plans is not a distribution either. Falling back to a
    // two-sample global pool renders a band whose width is an accident.
    const pricing = buildPricing([mkShipped("u1", "muninn", 2, 40), mkShipped("m1", "mimir", 2, 60)]);
    expect(pricing.global.n).toBe(2);
    expect(poolFor(pricing, "muninn")).toBeNull();
    const est = estimate(mkActive("x", "muninn", 3), pricing);
    expect(est.pool).toBe("none");
    expect(est.low).toBeNull();
    expect(est.high).toBeNull();
  });
});

describe("calibration", () => {
  test("a plan sitting exactly ON its band's endpoint counts as inside", () => {
    // Three identical plans ⇒ p25 = p50 = p75 = 7.7/3, and (7.7/3)*3 is
    // 7.700000000000001 in binary floating point. Compared exactly, every plan
    // in a perfectly calibrated pool scores OUTSIDE its own band.
    const plans = [1, 2, 3].map((i) => ({
      slug: `p${i}`,
      planStatus: "shipped",
      landed: 3,
      costUSD: 7.7,
      total: 3,
      prs: Array.from({ length: 3 }, () => ({ repo: "/Users/rune/source/private/muninn" })),
    }));
    const cal = calibration(plans, buildPricing(plans));
    expect(cal.n).toBe(3);
    expect(cal.inside).toBe(3);
    expect(cal.insideShare).toBe(1);
  });

  test("scores shipped plans against their own band, at their ACTUAL PR count", () => {
    // Three muninn plans at 20/30/40 $/PR ⇒ interpolated band 25–35. Only the
    // middle one lands inside; the outer two are the pool's extremes and sit
    // outside the quartiles their own spread produced.
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
    expect(cal).toEqual({
      n: 0,
      inside: 0,
      insideShare: null,
      medianRelError: null,
      asPriced: null,
    });
  });

  test("the as-priced triple scores the number the BOARD would have shown", () => {
    // The headline triple hands each plan its actual landed count, so it scores
    // the $/PR band alone. The as-priced one re-scores with the count the card
    // would have carried (declared, or the pool's median) — a worse number, and
    // the honest one for "how close was the board".
    const cal = calibration(FIXTURE_PLANS, buildPricing(FIXTURE_PLANS));
    expect(cal.asPriced!.n).toBe(cal.n);
    expect(cal.asPriced!.insideShare).toBeGreaterThanOrEqual(0);
    expect(cal.asPriced!.insideShare).toBeLessThanOrEqual(1);
    expect(cal.asPriced!.medianRelError).toBeGreaterThanOrEqual(0);
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
