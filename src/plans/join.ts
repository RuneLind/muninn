/**
 * Joining the two sides of the `/plans` board.
 *
 * **Outer on the mimir side, on slug.** A plan with no ledger row is a real card
 * with no money on it — that is the normal state of a freshly written proposal,
 * not a data problem. The reverse (a ledger row naming no plan on disk) is the
 * genuinely odd case: it means the ledger's corpus and the wiki's have drifted,
 * usually because a plan was renamed or retired, so it is reported separately
 * rather than folded into the board.
 *
 * Pure. PR 2 renders this; PR 1 exports it so nobody re-derives the join.
 */

import type { PlanRecord } from "./source.ts";
import type { LedgerPlan } from "./ledger.ts";
import type { Pricing, PlanEstimate } from "./estimate.ts";
import { buildPricing, estimate } from "./estimate.ts";

export interface JoinedPlan {
  /** The mimir-side record — always present; it IS the card. */
  plan: PlanRecord;
  /** The ledger row, when one exists for this slug. */
  ledger: LedgerPlan | null;
  /** The priced band. Present only when there is a ledger row to price. */
  estimate: PlanEstimate | null;
}

export interface JoinResult {
  plans: JoinedPlan[];
  /** Ledger slugs matching no plan on disk. */
  ledgerOnlySlugs: string[];
  /** The pools the estimates were built from, so the page can render the family
   *  table and the calibration sentence without rebuilding them. */
  pricing: Pricing;
}

/**
 * Join, and price every joined plan off the pools built from the FULL ledger.
 *
 * Pricing deliberately uses every ledger row, including rows whose plan file is
 * gone: a retired plan's shipped cost is still evidence about what a PR in that
 * repo costs, and dropping it would thin exactly the families that have been
 * around longest.
 */
export function joinPlans(
  records: readonly PlanRecord[],
  ledgerRows: readonly LedgerPlan[],
  pricing: Pricing = buildPricing(ledgerRows),
): JoinResult {
  const bySlug = new Map<string, LedgerPlan>();
  for (const row of ledgerRows) {
    // First row wins — a duplicate slug upstream must not silently re-price a
    // card depending on array order.
    if (!bySlug.has(row.slug)) bySlug.set(row.slug, row);
  }

  const matched = new Set<string>();
  const plans: JoinedPlan[] = records.map((plan) => {
    const ledger = bySlug.get(plan.slug) ?? null;
    if (ledger) matched.add(plan.slug);
    return { plan, ledger, estimate: ledger ? estimate(ledger, pricing) : null };
  });

  const ledgerOnlySlugs = [...bySlug.keys()].filter((slug) => !matched.has(slug)).sort();

  return { plans, ledgerOnlySlugs, pricing };
}
