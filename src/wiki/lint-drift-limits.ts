/**
 * Check 9's thresholds that a browser bundle reads too (the `/wiki/gardener`
 * labels). Dependency-free on purpose: `lint-drift.ts` imports the store, which
 * a client bundle cannot carry.
 */

/** A draft lane older than this many days is reported (strictly more). */
export const DRAFT_LANE_MAX_DAYS = 2;
