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
 * p25–p75 band.* Around that sentence sit four qualifications, each of which
 * exists because the live corpus breaks the naive version:
 *
 *   - **Repo strings are dirty and must be normalized before bucketing.** The
 *     live payload carries `/Users/rune/source/private/claude-usage;` (trailing
 *     semicolon) beside the clean path, plus `/private/tmp`, a bare
 *     `/Users/rune/source/private`, `…/huginn/huginn-jarvis` and short
 *     `RuneLind/muninn` forms. Unnormalized, `claude-usage;` becomes its own
 *     one-sample family and prices two plans off a single data point.
 *   - **A thin family falls back to the global pool, and says so.** Fewer than
 *     `MIN_FAMILY_SAMPLES` shipped plans is not a distribution; pretending
 *     otherwise puts a confident band on one observation.
 *   - **A plan that declares no PR count gets the pool's median count, FLAGGED.**
 *     The board renders it muted (`3 PRs?`) — an assumed count must never look
 *     like a declared one.
 *   - **A plan spanning two repos is bucketed by its MAJORITY repo**, and the
 *     result names which, because "why is this priced like a muninn plan" is the
 *     first question a mixed plan raises.
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
 * Basename → strip trailing punctuation → walk path segments from the END for a
 * known repo. The walk (rather than "take the last segment") is what maps a
 * checkout SUBDIRECTORY like `…/huginn/huginn-jarvis` onto its repo.
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
    const seg = segments[i]!.replace(/[^A-Za-z0-9._-]+$/, "");
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

export interface PlanFamily {
  /** The family this plan buckets into, or null when no PR named a known repo. */
  family: string | null;
  /** True when the plan's PRs span more than one family. */
  mixed: boolean;
  /** Per-family PR counts, highest first — what "majority" was decided on. */
  counts: Array<{ family: string; prs: number }>;
}

/**
 * Which family a plan belongs to, decided by MAJORITY of its PRs. Ties break on
 * the family that appeared first in PR order, so the answer is deterministic
 * across runs rather than depending on Map iteration luck.
 */
export function planFamily(prs: readonly LedgerPr[] | null | undefined): PlanFamily {
  const counts = new Map<string, number>();
  for (const pr of prs ?? []) {
    const fam = repoFamily(normalizeRepo(pr?.repo));
    if (!fam) continue;
    counts.set(fam, (counts.get(fam) ?? 0) + 1);
  }
  if (counts.size === 0) return { family: null, mixed: false, counts: [] };
  // Insertion order IS first-seen order, so a stable sort on count alone gives
  // the first-seen tie-break for free.
  const ordered = [...counts.entries()]
    .map(([family, prs]) => ({ family, prs }))
    .sort((a, b) => b.prs - a.prs);
  return { family: ordered[0]!.family, mixed: counts.size > 1, counts: ordered };
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
 *  price anything. A shipped plan with 0 PRs (33 of them live) is a real card
 *  and a real record; it just carries no $/PR. */
function isPricingSample(plan: LedgerPlan): boolean {
  return (
    plan.planStatus === "shipped" &&
    typeof plan.landed === "number" &&
    plan.landed >= 1 &&
    typeof plan.costUSD === "number" &&
    Number.isFinite(plan.costUSD) &&
    plan.costUSD > 0
  );
}

/** Build every pool from the ledger's shipped plans. */
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
      family: planFamily(plan.prs).family,
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

/** Pick the pool a plan prices from: its family when the family is thick enough,
 *  otherwise the global pool. Returns null only when nothing has been priced. */
export function poolFor(pricing: Pricing, family: string | null): {
  pool: PoolStats;
  source: "family" | "global";
} | null {
  if (family) {
    const fam = pricing.families.get(family);
    if (fam && fam.n >= MIN_FAMILY_SAMPLES) return { pool: fam, source: "family" };
  }
  if (pricing.global.n === 0) return null;
  return { pool: pricing.global, source: "global" };
}

export interface PlanEstimate {
  slug: string;
  /** The family the plan bucketed into (majority repo), null when unknown. */
  family: string | null;
  /** True when the plan's PRs span more than one family. */
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
 *  exactly when the plan declares no slate. */
export function declaredPrCount(plan: LedgerPlan): number | undefined {
  const total = plan.total;
  if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;
  const slate = plan.slate;
  if (Array.isArray(slate) && slate.length > 0) return slate.length;
  return undefined;
}

/**
 * Price one plan. `countOverride` exists for {@link calibration}, which must hand
 * each shipped plan its ACTUAL landed count rather than its declared one — the
 * whole question there is whether the $/PR band is right, not whether the plan
 * guessed its own size.
 */
export function estimate(
  plan: LedgerPlan,
  pricing: Pricing,
  countOverride?: number,
): PlanEstimate {
  const fam = planFamily(plan.prs);
  const picked = poolFor(pricing, fam.family);
  const declared = countOverride ?? declaredPrCount(plan);

  if (!picked) {
    return {
      slug: plan.slug,
      family: fam.family,
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

export interface Calibration {
  /** Shipped plans with ≥1 landed PR that could be scored. */
  n: number;
  /** How many landed inside their own p25–p75 band. */
  inside: number;
  /** `inside / n`, or null for an empty sample. */
  insideShare: number | null;
  /** Median of `|mid − actual| / actual`, or null for an empty sample. */
  medianRelError: number | null;
}

/**
 * Score the rule against the plans it was built from.
 *
 * **In-sample by construction** — each plan sits inside the pool that prices it,
 * so this is the ceiling on how well the rule can do, not a prediction of how it
 * will do on the next plan. It is worth rendering anyway: it is the difference
 * between a board that shows a band and a board that shows a band it has
 * measured, and a share far off 50% is the signal that the pooling is wrong.
 */
export function calibration(plans: readonly LedgerPlan[], pricing: Pricing): Calibration {
  let inside = 0;
  const relErrors: number[] = [];
  for (const plan of plans) {
    if (!isPricingSample(plan)) continue;
    const actualCount = plan.landed as number;
    const actualCost = plan.costUSD as number;
    // Hand it its ACTUAL PR count: this measures the $/PR band, not the plan's
    // ability to predict its own slate.
    const est = estimate(plan, pricing, actualCount);
    if (est.low === null || est.high === null || est.mid === null) continue;
    if (actualCost >= est.low && actualCost <= est.high) inside++;
    relErrors.push(Math.abs(est.mid - actualCost) / actualCost);
  }
  const n = relErrors.length;
  relErrors.sort((a, b) => a - b);
  return {
    n,
    inside,
    insideShare: n > 0 ? inside / n : null,
    medianRelError: n > 0 ? quantile(relErrors, 0.5) : null,
  };
}
