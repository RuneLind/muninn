/**
 * The `/plans` board payload — one pure function from "what mimir has on disk"
 * plus "what claude-usage knows" to the object the page renders and
 * `GET /api/plans/board` serves.
 *
 * Pure and injectable on purpose: the route does the two I/O calls
 * (`loadPlanSource` + `fetchPlanLedger`) and hands the results here, so column
 * membership, the meters and the degrade rules are testable against fixtures
 * with no filesystem and no socket.
 *
 * Three things it is responsible for, and they are the ones that go wrong:
 *
 *   1. **The tile and the cards cannot disagree.** The meters are computed from
 *      the very `cards[]` the payload carries, through the same
 *      `computeMeters` the browser re-runs after a filter change — not from a
 *      second pass over the join.
 *   2. **Money is one switch, named.** A ledger that is unreachable, that says
 *      its own rebuild failed, that has no plans directory, or that carries
 *      fewer shipped plans than it takes to price anything, produces a board
 *      with every column, every priority and every hand order intact and NO
 *      money at all — and `money.reason` says which of those it was. Half-money
 *      (an estimate here, a "—" there) is how a reader ends up trusting a
 *      number built on a failed rebuild.
 *   3. **The family survives the degrade.** A card's repo family is resolved
 *      from the ledger's PRs when there are any and from the slug otherwise, so
 *      the repo filter still works on a board with no ledger at all.
 */

import {
  calibration,
  planFamily,
  UNKNOWN_REPO,
  MIN_FAMILY_SAMPLES,
  type Calibration,
  type PoolStats,
  type Pricing,
} from "./estimate.ts";
import { joinPlans, type JoinedPlan } from "./join.ts";
import type { PlanRecord, PlanSourceResult } from "./source.ts";
import type { LedgerPlan, LedgerPr, PlanLedgerResult } from "./ledger.ts";
import { PLANS_WIKI_NAME } from "./source.ts";
import {
  ageInDays,
  columnForStatus,
  computeMeters,
  familyCounts,
  BOARD_COLUMNS,
  type BoardCard,
  type BoardColumnMeta,
  type BoardLedgerFacts,
  type BoardMeters,
  type BoardOrder,
  type BoardPr,
} from "./board-client-pure.ts";

/**
 * The substring `ledger.ts` puts in the error it raises for upstream's
 * `refreshError`. Coupled on purpose and pinned by a test that builds the error
 * through `fetchPlanLedger` itself, so a reworded message fails loudly here
 * instead of quietly re-enabling money on a ledger whose rebuild threw.
 */
export const LEDGER_REBUILD_MARKER = "last rebuild failed:";

export interface BoardPricingSummary {
  /** Shipped plans in the global pool. */
  globalSamples: number;
  global: PoolPublic | null;
  families: PoolPublic[];
  /** Repo strings no known repo matched — the signal that `KNOWN_REPOS` needs
   *  a new entry rather than the global pool quietly absorbing it. */
  unknownRepoStrings: Array<{ repo: string; prs: number }>;
}

export interface PoolPublic {
  key: string;
  n: number;
  p25: number;
  p50: number;
  p75: number;
  medianPRs: number;
}

export interface BoardPayload {
  /** When this payload was assembled, epoch ms. */
  generatedAt: number;
  wiki: { name: string; registered: boolean; root: string | null };
  ledger: {
    baseUrl: string;
    urlConfigured: boolean;
    ledgerConfigured: boolean | null;
    reachable: boolean;
    fetchedAt: number;
    /** claude-usage's own build instant. */
    generatedAt: string | null;
    refreshedAt: string | null;
    errors: string[];
  };
  /** Whether the board may show money at all, and why not when it may not. */
  money: { available: boolean; reason: string | null };
  columns: BoardColumnMeta[];
  cards: BoardCard[];
  /** The hand order as it is ON DISK — the client's overlay never overwrites a
   *  column that appears here. `hash` rides along for PR 4's compare-and-swap. */
  queue: { order: BoardOrder; hash: string | null };
  meters: BoardMeters;
  families: Array<{ family: string; count: number }>;
  pricing: BoardPricingSummary;
  calibration: Calibration | null;
  /** The rendered sentence — computed from `calibration`, never hard-coded. */
  calibrationSentence: string | null;
  /** Everything the source dropped, in words. Rendered as a caveat, not an error. */
  warnings: string[];
  /** Ledger rows naming no plan on disk (a rename or a retirement upstream). */
  ledgerOnlySlugs: string[];
}

export interface BuildBoardInput {
  source: PlanSourceResult;
  ledger: PlanLedgerResult;
  now?: number;
}

// ---- Ledger extras --------------------------------------------------------
//
// `LedgerPlan` types only the fields PR 1 needed to PRICE a plan. The drawer
// shows a few more that the live payload carries (`activeHours`, `findings`,
// `maxRounds`, `handovers`, and `legs` as an array of sessions). They are read
// defensively rather than added to the upstream contract type: every one of
// them is display-only, and a missing or re-typed field must degrade to "not
// shown", never to a compile error or a `NaN` on the card.

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function ledgerPr(pr: LedgerPr): BoardPr {
  const extra = pr as unknown as Record<string, unknown>;
  return {
    number: num(pr.prNumber),
    url: str(pr.url),
    repo: str(pr.repo),
    mergedAt: str(pr.mergedAt),
    reviewed: typeof pr.reviewed === "boolean" ? pr.reviewed : null,
    findings: num(extra.findings),
    rounds: num(extra.rounds),
    subject: str(pr.subject),
  };
}

function ledgerFacts(row: LedgerPlan): BoardLedgerFacts {
  const extra = row as unknown as Record<string, unknown>;
  const legs = extra.legs;
  return {
    costUSD: num(row.costUSD),
    landed: num(row.landed),
    merges: num(row.merges),
    activeHours: num(extra.activeHours),
    findings: num(row.findings),
    maxRounds: num(extra.maxRounds),
    handovers: num(extra.handovers),
    sessions: Array.isArray(legs) ? legs.length : num(legs),
    prs: (row.prs ?? []).map(ledgerPr),
  };
}

function poolPublic(pool: PoolStats): PoolPublic {
  return {
    key: pool.key,
    n: pool.n,
    p25: pool.p25,
    p50: pool.p50,
    p75: pool.p75,
    medianPRs: pool.medianPRs,
  };
}

function pricingSummary(pricing: Pricing): BoardPricingSummary {
  return {
    globalSamples: pricing.global.n,
    global: pricing.global.n > 0 ? poolPublic(pricing.global) : null,
    families: [...pricing.families.values()]
      .map(poolPublic)
      .sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : 1)),
    unknownRepoStrings: pricing.unknownRepoStrings,
  };
}

/**
 * Why the board may not show money — the first reason that applies, in the
 * order a reader would ask about them. Null means "show it".
 */
export function moneyBlockedReason(ledger: PlanLedgerResult, pricing: Pricing): string | null {
  if (!ledger.reachable) {
    return `the claude-usage ledger at ${ledger.baseUrl} did not answer`;
  }
  if (ledger.errors?.some((e) => e.includes(LEDGER_REBUILD_MARKER))) {
    return `the ledger at ${ledger.baseUrl} says its last rebuild failed, so its rows cannot be trusted`;
  }
  if (ledger.ledgerConfigured === false) {
    return `the ledger at ${ledger.baseUrl} has no plans directory configured`;
  }
  if (pricing.global.n < MIN_FAMILY_SAMPLES) {
    return `the ledger has ${pricing.global.n} shipped plan(s) with a cost — ${MIN_FAMILY_SAMPLES} are needed before a band means anything`;
  }
  return null;
}

/** The reader link for a plan page in muninn's own wiki reader. Relative on
 *  purpose: the board is reached over the tailnet as often as over loopback,
 *  and an absolute link would name whichever host rendered it. */
export function planWikiUrl(slug: string): string {
  return `/wiki?wiki=${encodeURIComponent(PLANS_WIKI_NAME)}&page=${encodeURIComponent(slug)}`;
}

function buildCard(
  joined: JoinedPlan,
  now: number,
  moneyAvailable: boolean,
  pricing: Pricing,
): BoardCard {
  const plan: PlanRecord = joined.plan;
  const row = joined.ledger;
  // The family is asked for SEPARATELY from the estimate: pricing can be off
  // (no ledger, a failed rebuild, too few samples) while the repo filter must
  // still work, and `planFamily` needs only the PRs and the slug.
  const fam = planFamily(row?.prs, {
    slug: plan.slug,
    poolSize: (family) => pricing.families.get(family)?.n ?? 0,
  });
  const est = joined.estimate;
  return {
    slug: plan.slug,
    title: plan.title,
    description: row ? str((row as unknown as Record<string, unknown>).description) : null,
    statusNote: plan.statusNote ?? null,
    planStatus: plan.planStatus ?? null,
    column: columnForStatus(plan.planStatus, plan.followupsOpen),
    statusDate: plan.statusDate ?? null,
    ageDays: ageInDays(plan.statusDate, now),
    mtimeMs: plan.mtimeMs,
    priority: plan.priority ?? null,
    tags: plan.tags,
    relPath: plan.relPath,
    hash: plan.hash,
    followupsOpen: plan.followupsOpen,
    wikiUrl: planWikiUrl(plan.slug),
    family: fam.family ?? UNKNOWN_REPO,
    familySource: fam.familySource,
    familyConfident: fam.confident,
    mixedRepos: fam.mixed,
    estimate:
      moneyAvailable && est
        ? {
            low: est.low,
            mid: est.mid,
            high: est.high,
            prCount: est.prCount,
            assumedCount: est.assumedCount,
            pool: est.pool,
            poolKey: est.poolKey,
            sampleSize: est.sampleSize,
            dollarsPerPR: est.dollarsPerPR,
          }
        : null,
    ledger: moneyAvailable && row ? ledgerFacts(row) : null,
  };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * The calibration sentence, rendered from the measured score.
 *
 * It deliberately does NOT sell the number as accuracy: the score is in-sample
 * (every plan sits inside the pool that prices it), and a p25–p75 band holds
 * about half its own samples by construction — so a share near 50% is the
 * expected shape, not a grade. The as-priced triple is the honest one and is
 * named as such, because it is the number a reader of a card is exposed to.
 */
export function calibrationSentence(cal: Calibration | null): string | null {
  if (!cal || cal.n === 0 || cal.insideShare === null || cal.medianRelError === null) return null;
  const head =
    `Over ${cal.n} shipped plans, the band held ${pct(cal.insideShare)} of the time; ` +
    `median error ${pct(cal.medianRelError)}.`;
  const caveat =
    " That is in-sample — each plan is one of the samples behind its own median — and a p25–p75 " +
    "band holds about half of them by construction, so read ~50% as the shape of the measure, not as accuracy.";
  const asPriced =
    cal.asPriced && cal.asPriced.insideShare !== null && cal.asPriced.medianRelError !== null
      ? ` Priced the way a card is priced (declared slate, or the pool's median where none is declared): ` +
        `${pct(cal.asPriced.insideShare)} inside, median error ${pct(cal.asPriced.medianRelError)}.`
      : "";
  return head + caveat + asPriced;
}

/**
 * Assemble the board payload. Never throws for a degraded input: an
 * unregistered wiki, an unreachable ledger and a corpus full of warnings all
 * produce a payload the page can render.
 */
export function buildBoardPayload(input: BuildBoardInput): BoardPayload {
  const { source, ledger } = input;
  const now = input.now ?? Date.now();
  const join = joinPlans(source.plans, ledger.plans);
  const reason = moneyBlockedReason(ledger, join.pricing);
  const moneyAvailable = reason === null;

  const cards = join.plans
    .map((joined) => buildCard(joined, now, moneyAvailable, join.pricing))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  const cal = moneyAvailable ? calibration(ledger.plans, join.pricing) : null;

  return {
    generatedAt: now,
    wiki: {
      name: PLANS_WIKI_NAME,
      registered: source.root !== null,
      root: source.root,
    },
    ledger: {
      baseUrl: ledger.baseUrl,
      urlConfigured: ledger.urlConfigured,
      ledgerConfigured: ledger.ledgerConfigured,
      reachable: ledger.reachable,
      fetchedAt: ledger.fetchedAt,
      generatedAt: ledger.generatedAt,
      refreshedAt: ledger.refreshedAt,
      errors: ledger.errors ?? [],
    },
    money: { available: moneyAvailable, reason },
    columns: [...BOARD_COLUMNS],
    cards,
    queue: { order: source.queue.order, hash: source.queue.hash },
    meters: computeMeters(cards, moneyAvailable),
    families: familyCounts(cards),
    pricing: pricingSummary(join.pricing),
    calibration: cal,
    calibrationSentence: calibrationSentence(cal),
    warnings: source.warnings,
    ledgerOnlySlugs: join.ledgerOnlySlugs,
  };
}
