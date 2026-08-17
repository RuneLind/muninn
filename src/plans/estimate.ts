/**
 * What a plan is likely to cost — the module every number on the `/plans` board
 * comes from.
 *
 * Pure by construction: rows in, numbers out. No fetch, no fs, no clock. That is
 * not tidiness — it is what lets the whole pricing rule be tested against a
 * checked-in fixture instead of against whatever the live ledger happens to say
 * this week.
 *
 * **The rule**, in one sentence: *per repo family, the median $/PR of that
 * family's shipped plans, times the PR count the plan declares, shown as a
 * p25–p75 band.* Around that sentence sit five qualifications, each of which
 * exists because the live corpus breaks the naive version:
 *
 *   - **Repo strings are dirty and must be normalized before bucketing.** The
 *     live payload carries `/Users/rune/source/private/claude-usage;` (trailing
 *     semicolon) beside the clean path, plus `/private/tmp`, a bare
 *     `/Users/rune/source/private`, `…/huginn/huginn-jarvis`, short
 *     `RuneLind/muninn` forms and casing/`.git` variants. Unnormalized,
 *     `claude-usage;` becomes its own one-sample family and prices two plans off
 *     a single data point.
 *   - **A thin pool prices nothing it cannot back.** Under
 *     `MIN_FAMILY_SAMPLES` shipped plans a family falls back to the global pool
 *     and says so — and a GLOBAL pool that thin returns no estimate at all,
 *     because a band whose width came from two observations is a decoration.
 *   - **A plan that declares no PR count gets the pool's median count, FLAGGED.**
 *     The board renders it muted — an assumed count must never look like a
 *     declared one.
 *   - **A plan spanning two repos is bucketed by its MAJORITY repo**, and the
 *     result names which, because "why is this priced like a muninn plan" is the
 *     first question a mixed plan raises. Majority means a strict majority of
 *     ALL its PRs, unnormalizable ones included; short of that the PRs have not
 *     decided anything (see {@link planFamily}).
 *   - **A plan with no usable PRs is bucketed by its SLUG.** Most of the live
 *     corpus's cards have not started, so `prs` is empty and the repo is only
 *     written on the front of the name (`muninn-…`, `claude-usage-…`). Reading
 *     PRs alone drops every one of them into the global pool.
 *
 * And the honesty check: {@link calibration} scores the rule against the shipped
 * plans it was built from — what share land inside their own band, and by how
 * much the median estimate misses. It is **in-sample** (each plan sits in its own
 * pool), so it is an upper bound on accuracy, not a forecast. The board renders
 * that sentence from these numbers rather than asserting a quality nobody
 * measured.
 */

import type { LedgerPlan, LedgerPr } from "./ledger.ts";

/**
 * Repo basenames the corpus actually contains, after stripping. A path segment
 * has to match one of these to count as a repo — which is what maps
 * `…/huginn/huginn-jarvis` to `huginn` and lets `/private/tmp` and the bare
 * `/Users/rune/source/private` fall through to the global pool instead of
 * inventing a `tmp` family.
 *
 * An allowlist rather than a deny-list because the wrong answer differs in cost:
 * an unknown repo landing in the global pool is priced from a wider sample, while
 * a non-repo path segment promoted to a family invents a distribution.
 * {@link normalizeRepo} returns null for anything unmatched, and callers can
 * count those (see `unknownRepoStrings`) rather than losing them silently.
 */
export const KNOWN_REPOS: readonly string[] = [
  "muninn",
  "huginn",
  "mimir",
  "yggdrasil",
  "claude-usage",
  "claude-skills",
  "claude-hivemind",
  "torrent-manager",
  "samsung-tv-media",
];

/** The one documented family GROUPING: the three `claude-*` tool repos share a
 *  shape (small TS services, same dev loop) and individually run thin. Every
 *  other family is just its normalized repo. */
export const CLAUDE_FAMILY = "claude-*";

/** Below this many shipped samples a family is not a distribution — fall back to
 *  the global pool and say so. */
export const MIN_FAMILY_SAMPLES = 3;

/**
 * Reduce a ledger repo string to a known repo name, or null.
 *
 * Strip trailing punctuation → walk path segments from the END → per segment,
 * drop a trailing `.git` and lowercase before matching. The walk (rather than
 * "take the last segment") is what maps a checkout SUBDIRECTORY like
 * `…/huginn/huginn-jarvis` onto its repo; the `.git`/case handling is what keeps
 * `RuneLind/Muninn`, `RuneLind/muninn.git` and
 * `git@github.com:RuneLind/muninn.git` from each inventing a family of one.
 */
export function normalizeRepo(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._/\\-]+$/, "");
  if (!cleaned) return null;
  const segments = cleaned.split(/[/\\]+/).filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    // Strip stray punctuation on the segment too — `claude-usage;` arrives as
    // the LAST segment, so the trailing-punctuation strip above already handled
    // it, but a mid-path one (`…/claude-usage;/sub`) would not be.
    const seg = segments[i]!.replace(/[^A-Za-z0-9._-]+$/, "").replace(/\.git$/i, "").toLowerCase();
    if (KNOWN_REPOS.includes(seg)) return seg;
  }
  return null;
}

/** Normalized repo → family. The `claude-*` grouping is the only mapping. */
export function repoFamily(repo: string | null): string | null {
  if (!repo) return null;
  return repo.startsWith("claude-") ? CLAUDE_FAMILY : repo;
}

/** The global pool's key, used wherever a family name is rendered. */
export const GLOBAL_POOL = "global";

/** The bucket a PR whose repo string names no known repo counts into. Kept in
 *  {@link PlanFamily.counts} rather than dropped, because a plan whose PRs are
 *  half unreadable is a MIXED plan, and a "majority" taken over only the
 *  readable half is a majority of the evidence that happened to parse. */
export const UNKNOWN_REPO = "unknown";

export interface PlanFamily {
  /** The family this plan buckets into, or null when neither its PRs nor its
   *  slug named a known repo. */
  family: string | null;
  /** Where {@link PlanFamily.family} came from. Null when there is no family. */
  familySource: "prs" | "slug" | null;
  /** True when the plan's PRs span more than one bucket — `unknown` counts. */
  mixed: boolean;
  /** True when one real family holds a STRICT MAJORITY of all counted PRs. When
   *  false the PRs did not decide the family; the slug (or, failing that, the
   *  plurality) did, and the board should say so rather than imply a majority. */
  confident: boolean;
  /** Per-bucket PR counts, highest first — what the decision was made on. */
  counts: Array<{ family: string; prs: number }>;
}

export interface PlanFamilyOptions {
  /** The plan's slug. Its leading segment names the repo for most of the corpus
   *  and is the ONLY evidence for a plan that has landed nothing yet. */
  slug?: string | null;
  /** How many shipped samples a family's pool holds — the second tie-break.
   *  Optional because pool construction itself calls this before any pool
   *  exists; see {@link planFamily}. */
  poolSize?: (family: string) => number;
}

/**
 * The family a slug names, or null.
 *
 * Longest known repo that the slug starts with, followed by a `-`. That is
 * exactly mimir's own naming convention for plan files (`muninn-…`,
 * `claude-usage-…`), and it deliberately matches nothing else: a
 * `mac-mini-headless-agent-setup` names a MACHINE, not a repo, and inventing a
 * family for it would price it off a pool of its own name.
 */
export function familyFromSlug(slug: string | null | undefined): string | null {
  if (typeof slug !== "string") return null;
  const lower = slug.trim().toLowerCase();
  if (!lower) return null;
  let best: string | null = null;
  for (const repo of KNOWN_REPOS) {
    if (lower.startsWith(`${repo}-`) && (best === null || repo.length > best.length)) best = repo;
  }
  return repoFamily(best);
}

/**
 * Which family a plan belongs to.
 *
 * Decided by a STRICT MAJORITY of its PRs — all of them, including the ones
 * whose repo string normalizes to nothing. Short of a majority the PRs have not
 * settled it (a 1-muninn/5-unreadable plan is not a muninn plan on that
 * evidence), and the SLUG is consulted instead; only if the slug names no repo
 * either does the plurality stand, flagged `confident: false`.
 *
 * Ties are broken deterministically — slug-named family, then the thicker pool,
 * then alphabetically — because the PR array's order is the ledger's, not a fact
 * about the plan, and reversing it must not re-price the card. The pool tie-break
 * is available only when the caller can supply pool sizes; {@link buildPricing}
 * cannot (it is building those pools), so bucketing a SAMPLE uses slug then
 * alphabetical.
 */
export function planFamily(
  prs: readonly LedgerPr[] | null | undefined,
  opts: PlanFamilyOptions = {},
): PlanFamily {
  const slugFamily = familyFromSlug(opts.slug);
  const counts = new Map<string, number>();
  let total = 0;
  for (const pr of prs ?? []) {
    const raw = typeof pr?.repo === "string" ? pr.repo.trim() : "";
    // A PR carrying no repo string at all is not evidence of anything, unlike
    // one carrying a string nothing recognizes.
    if (!raw) continue;
    const fam = repoFamily(normalizeRepo(raw)) ?? UNKNOWN_REPO;
    counts.set(fam, (counts.get(fam) ?? 0) + 1);
    total++;
  }

  const poolSize = opts.poolSize;
  const ordered = [...counts.entries()]
    .map(([family, prs]) => ({ family, prs }))
    .sort((a, b) => {
      if (b.prs !== a.prs) return b.prs - a.prs;
      if (a.family === slugFamily) return -1;
      if (b.family === slugFamily) return 1;
      if (poolSize) {
        const diff = poolSize(b.family) - poolSize(a.family);
        if (diff !== 0) return diff;
      }
      return a.family.localeCompare(b.family);
    });

  const mixed = ordered.length > 1;
  const top = ordered.find((e) => e.family !== UNKNOWN_REPO) ?? null;
  const confident = top !== null && top.prs * 2 > total;
  if (confident) {
    return { family: top!.family, familySource: "prs", mixed, confident, counts: ordered };
  }
  if (slugFamily) {
    return { family: slugFamily, familySource: "slug", mixed, confident: false, counts: ordered };
  }
  if (top) {
    return { family: top.family, familySource: "prs", mixed, confident: false, counts: ordered };
  }
  return { family: null, familySource: null, mixed, confident: false, counts: ordered };
}

/** One shipped plan's contribution to a pool. */
export interface ShippedSample {
  slug: string;
  family: string | null;
  /** Landed PRs — the divisor. */
  landedPRs: number;
  costUSD: number;
  dollarsPerPR: number;
}

/** Linear-interpolated quantile over an ASCENDING array. Empty ⇒ NaN. */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export interface PoolStats {
  key: string;
  /** Number of shipped plans in the pool. */
  n: number;
  /** $/PR distribution. */
  p25: number;
  p50: number;
  p75: number;
  /** Median landed PRs per plan — the count an undeclared plan assumes. */
  medianPRs: number;
}

export interface Pricing {
  /** Family key → stats. Only families with ≥1 sample appear. */
  families: Map<string, PoolStats>;
  /** Every shipped sample, pooled. */
  global: PoolStats;
  samples: ShippedSample[];
  /** Repo strings no known repo matched, with how often each occurred — the
   *  operator-visible signal that a new repo needs adding to {@link KNOWN_REPOS}
   *  rather than quietly diluting the global pool. */
  unknownRepoStrings: Array<{ repo: string; prs: number }>;
}

function statsOf(key: string, samples: readonly ShippedSample[]): PoolStats {
  const dollars = samples.map((s) => s.dollarsPerPR).sort((a, b) => a - b);
  const counts = samples.map((s) => s.landedPRs).sort((a, b) => a - b);
  return {
    key,
    n: samples.length,
    p25: quantile(dollars, 0.25),
    p50: quantile(dollars, 0.5),
    p75: quantile(dollars, 0.75),
    medianPRs: quantile(counts, 0.5),
  };
}

/** A shipped plan with real landed PRs and a real cost — the only rows that can
 *  price anything. A shipped plan with 0 landed PRs is a real card and a real
 *  record; it just carries no $/PR. `landed` must be a whole number: it is the
 *  DIVISOR, and a fractional one silently skews the pool it lands in. */
function isPricingSample(plan: LedgerPlan): boolean {
  return (
    plan.planStatus === "shipped" &&
    typeof plan.landed === "number" &&
    Number.isInteger(plan.landed) &&
    plan.landed >= 1 &&
    typeof plan.costUSD === "number" &&
    Number.isFinite(plan.costUSD) &&
    plan.costUSD > 0
  );
}

/**
 * Build every pool from the ledger's shipped plans.
 *
 * A sample's $/PR divides by `landed`, while the family it lands in is decided
 * over ALL of `prs` — the two differ on plans whose slate outran what merged,
 * and that is deliberate: what a PR in a repo COST is evidence from every PR of
 * the plan, while what the plan cost PER PR can only divide by what landed.
 */
export function buildPricing(plans: readonly LedgerPlan[]): Pricing {
  const samples: ShippedSample[] = [];
  const unknown = new Map<string, number>();
  for (const plan of plans) {
    for (const pr of plan.prs ?? []) {
      const raw = typeof pr?.repo === "string" ? pr.repo.trim() : "";
      if (raw && normalizeRepo(raw) === null) unknown.set(raw, (unknown.get(raw) ?? 0) + 1);
    }
    if (!isPricingSample(plan)) continue;
    const landedPRs = plan.landed as number;
    const costUSD = plan.costUSD as number;
    samples.push({
      slug: plan.slug,
      // No `poolSize` tie-break here: these ARE the pools being built.
      family: planFamily(plan.prs, { slug: plan.slug }).family,
      landedPRs,
      costUSD,
      dollarsPerPR: costUSD / landedPRs,
    });
  }

  const byFamily = new Map<string, ShippedSample[]>();
  for (const s of samples) {
    if (!s.family) continue;
    const list = byFamily.get(s.family);
    if (list) list.push(s);
    else byFamily.set(s.family, [s]);
  }
  const families = new Map<string, PoolStats>();
  for (const [key, list] of byFamily) families.set(key, statsOf(key, list));

  return {
    families,
    global: statsOf(GLOBAL_POOL, samples),
    samples,
    unknownRepoStrings: [...unknown.entries()]
      .map(([repo, prs]) => ({ repo, prs }))
      .sort((a, b) => b.prs - a.prs || a.repo.localeCompare(b.repo)),
  };
}

/**
 * Pick the pool a plan prices from: its family when the family is thick enough,
 * otherwise the global pool — and NOTHING when even the global pool is thin.
 *
 * The floor applies to both pools for the same reason. With one or two shipped
 * plans in the whole corpus, p25 and p75 collapse onto the samples themselves:
 * the band's width is then an artefact of which two plans happened to ship, and
 * a one-sample pool renders a zero-width band that looks like precision.
 */
export function poolFor(pricing: Pricing, family: string | null): {
  pool: PoolStats;
  source: "family" | "global";
} | null {
  if (family) {
    const fam = pricing.families.get(family);
    if (fam && fam.n >= MIN_FAMILY_SAMPLES) return { pool: fam, source: "family" };
  }
  if (pricing.global.n < MIN_FAMILY_SAMPLES) return null;
  return { pool: pricing.global, source: "global" };
}

export interface PlanEstimate {
  slug: string;
  /** The family the plan bucketed into, null when unknown. */
  family: string | null;
  /** Whether that family came from the plan's PRs or from its slug. */
  familySource: "prs" | "slug" | null;
  /** True when a real family held a strict majority of the plan's PRs. False
   *  means the family is the slug's word, or a plurality — worth muting. */
  familyConfident: boolean;
  /** True when the plan's PRs span more than one family (`unknown` counts). */
  mixedRepos: boolean;
  /** Which pool the numbers came from. `"none"` ⇒ nothing has ever shipped. */
  pool: "family" | "global" | "none";
  /** The pool's key, for the "priced off N muninn plans" sub-line. */
  poolKey: string;
  /** Samples in that pool. */
  sampleSize: number;
  /** PR count the band multiplies. */
  prCount: number;
  /** True when `prCount` is the pool's median rather than the plan's own
   *  declaration — the board renders it muted. */
  assumedCount: boolean;
  /** $/PR quartiles of the pool, before multiplication. */
  dollarsPerPR: { p25: number; p50: number; p75: number } | null;
  /** The band, in dollars. Null when nothing could be priced. */
  low: number | null;
  mid: number | null;
  high: number | null;
}

/** The PR count a plan DECLARES, or undefined. The ledger reports `total: null`
 *  exactly when the plan declares no slate. A count must be a positive WHOLE
 *  number to be believed — the band is multiplied by it, so upstream garbage
 *  (`2.5`, `-1`) would render as a confident wrong figure instead of an honest
 *  assumed one. */
export function declaredPrCount(plan: LedgerPlan): number | undefined {
  const total = plan.total;
  if (typeof total === "number" && Number.isInteger(total) && total > 0) return total;
  const slate = plan.slate;
  if (Array.isArray(slate) && slate.length > 0) return slate.length;
  return undefined;
}

/**
 * Price one plan. `countOverride` exists for {@link calibration}, which must hand
 * each shipped plan its ACTUAL landed count rather than its declared one — the
 * whole question there is whether the $/PR band is right, not whether the plan
 * guessed its own size. A non-positive or fractional override means "no
 * override", not "a zero-PR plan".
 */
export function estimate(
  plan: LedgerPlan,
  pricing: Pricing,
  countOverride?: number,
): PlanEstimate {
  const fam = planFamily(plan.prs, {
    slug: plan.slug,
    poolSize: (family) => pricing.families.get(family)?.n ?? 0,
  });
  const picked = poolFor(pricing, fam.family);
  const override =
    typeof countOverride === "number" && Number.isInteger(countOverride) && countOverride > 0
      ? countOverride
      : undefined;
  const declared = override ?? declaredPrCount(plan);

  if (!picked) {
    return {
      slug: plan.slug,
      family: fam.family,
      familySource: fam.familySource,
      familyConfident: fam.confident,
      mixedRepos: fam.mixed,
      pool: "none",
      poolKey: GLOBAL_POOL,
      sampleSize: 0,
      prCount: declared ?? 0,
      assumedCount: declared === undefined,
      dollarsPerPR: null,
      low: null,
      mid: null,
      high: null,
    };
  }

  const { pool, source } = picked;
  // An assumed count is rounded, because "2.5 PRs" is not a thing a board can
  // say and the number is a guess either way. Floored at 1: a pool median can
  // round to 0 only on a corpus of single-PR plans, and a $0 band is worse than
  // a one-PR one.
  const assumedCount = declared === undefined;
  const prCount = assumedCount ? Math.max(1, Math.round(pool.medianPRs)) : declared!;

  return {
    slug: plan.slug,
    family: fam.family,
    familySource: fam.familySource,
    familyConfident: fam.confident,
    mixedRepos: fam.mixed,
    pool: source,
    poolKey: pool.key,
    sampleSize: pool.n,
    prCount,
    assumedCount,
    dollarsPerPR: { p25: pool.p25, p50: pool.p50, p75: pool.p75 },
    low: pool.p25 * prCount,
    mid: pool.p50 * prCount,
    high: pool.p75 * prCount,
  };
}

export interface CalibrationScore {
  /** Shipped plans with ≥1 landed PR that could be scored. */
  n: number;
  /** How many landed inside their own p25–p75 band. */
  inside: number;
  /** `inside / n`, or null for an empty sample. */
  insideShare: number | null;
  /** Median of `|mid − actual| / actual`, or null for an empty sample. */
  medianRelError: number | null;
}

export interface Calibration extends CalibrationScore {
  /**
   * The same score computed at the count the BOARD would have shown — the
   * plan's declared slate, or the pool's median where it declares none —
   * instead of what actually landed. Null for an empty sample.
   *
   * The headline triple isolates the $/PR band; this one includes the error in
   * the PR count, which is the number a reader of the card is actually exposed
   * to. It is always the worse of the two, and it is the honest answer to "how
   * close was the board".
   */
  asPriced: CalibrationScore | null;
}

/** Two costs are "the same" within floating-point noise. A perfectly calibrated
 *  pool puts every sample ON an endpoint, where `p50 * count` reconstructs the
 *  cost through a divide and a multiply — `(7.7/3)*3` is `7.700000000000001`,
 *  and an exact compare scores that plan OUTSIDE its own band. */
function withinBand(value: number, low: number, high: number): boolean {
  const tol = 1e-9 * Math.max(Math.abs(low), Math.abs(high), Math.abs(value), 1);
  return value >= low - tol && value <= high + tol;
}

function scoreOf(inside: number, relErrors: number[]): CalibrationScore {
  const n = relErrors.length;
  relErrors.sort((a, b) => a - b);
  return {
    n,
    inside,
    insideShare: n > 0 ? inside / n : null,
    medianRelError: n > 0 ? quantile(relErrors, 0.5) : null,
  };
}

/**
 * Score the rule against the plans it was built from.
 *
 * **In-sample by construction** — each plan sits inside the pool that prices it,
 * so this is the ceiling on how well the rule can do, not a prediction of how it
 * will do on the next plan. It is worth rendering anyway: it is the difference
 * between a board that shows a band and a board that shows a band it has
 * measured, and a share far off 50% is the signal that the pooling is wrong.
 *
 * The headline triple hands each plan its ACTUAL landed count, so it scores the
 * $/PR band alone — not whether the plan guessed its own size. {@link
 * Calibration.asPriced} re-scores the same plans at the count the card would
 * have carried.
 */
export function calibration(plans: readonly LedgerPlan[], pricing: Pricing): Calibration {
  let inside = 0;
  let insideAsPriced = 0;
  const relErrors: number[] = [];
  const relErrorsAsPriced: number[] = [];
  for (const plan of plans) {
    if (!isPricingSample(plan)) continue;
    const actualCount = plan.landed as number;
    const actualCost = plan.costUSD as number;
    const est = estimate(plan, pricing, actualCount);
    if (est.low === null || est.high === null || est.mid === null) continue;
    if (withinBand(actualCost, est.low, est.high)) inside++;
    relErrors.push(Math.abs(est.mid - actualCost) / actualCost);

    // …and the same plan priced the way the board prices an unfinished one.
    const shown = estimate(plan, pricing);
    if (shown.low !== null && shown.high !== null && shown.mid !== null) {
      if (withinBand(actualCost, shown.low, shown.high)) insideAsPriced++;
      relErrorsAsPriced.push(Math.abs(shown.mid - actualCost) / actualCost);
    }
  }
  const headline = scoreOf(inside, relErrors);
  return {
    ...headline,
    asPriced: headline.n > 0 ? scoreOf(insideAsPriced, relErrorsAsPriced) : null,
  };
}
