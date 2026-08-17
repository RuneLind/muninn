/**
 * The `/plans` board's shared constants — mimir's contract values and the two
 * paths inside the wiki, with the enums' derived types.
 *
 * **This module imports NOTHING, deliberately.** `source.ts` owns these values
 * conceptually but resolves mimir through the wiki registry, which drags
 * `src/bots/config.ts` and `src/db/` in at import time; a caller that only needs
 * to know the status enum or where `queue.yaml` lives (the barrel, a route's
 * validation, a test fixture) must not pay for a database connection to get it.
 * `source.ts` re-exports every name here, so the older import path keeps working.
 */

/** Directory inside the wiki holding the plan pages. */
export const PLANS_DIR = "plans";

/** The queue file, relative to the wiki root. PR 4's writer targets this path. */
export const QUEUE_REL_PATH = `${PLANS_DIR}/queue.yaml`;

/** `plan_status` lifecycle values (mimir's contract, see
 *  `plans/mimir-plan-status-lifecycle.mdx`). Anything else is dropped. */
export const PLAN_STATUSES = [
  "proposed",
  "ready",
  "in-flight",
  "blocked",
  "shipped",
  "superseded",
  "abandoned",
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type PlanPriority = (typeof PLAN_PRIORITIES)[number];
