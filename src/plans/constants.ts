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

/** The shared slug grammar — `queue.ts` rule 3. Leading letter, then letters, digits
 *  and hyphens; nothing else survives as a bare YAML scalar in both parsers. */
const SLUG_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
/** Words YAML resolves to a boolean or null in some casing. Never a slug, even
 *  quoted: the quoting is exactly what the other parser cannot see. */
const YAML_LITERALS = new Set(["true", "false", "null"]);

/** Whether a string is a legal queue slug under the grammar both parsers share. */
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !YAML_LITERALS.has(slug.toLowerCase());
}
