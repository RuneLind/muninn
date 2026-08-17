/**
 * `/plans` — the kanban board over mimir's `plans/` directory, priced from the
 * claude-usage ledger.
 *
 * Four modules, one job each, and the split is deliberate: {@link estimate} and
 * {@link queue} are pure so the pricing rule and the file grammar are testable
 * against a fixture, {@link source} touches only the filesystem, {@link ledger}
 * touches only the network.
 *
 * **This barrel is deliberately IMPORT-LIGHT**: types, the pure functions, and
 * the network proxy. `source.ts`'s runtime is NOT re-exported, because it
 * resolves mimir through the wiki registry and so drags `src/bots/config.ts` and
 * `src/db/` in at import time. A caller that needs the filesystem side imports
 * `./source.ts` directly and pays for it knowingly; a caller that only wants to
 * price something does not pay at all.
 */

export type {
  PlanRecord,
  PlanQueue,
  PlanSourceResult,
  PlanSourceOptions,
} from "./source.ts";

// Runtime values, not just types: the enums and the two wiki-relative paths come
// from `constants.ts`, which imports nothing — so re-exporting them here costs
// the barrel none of `source.ts`'s registry/`src/db/` weight.
export {
  PLANS_DIR,
  QUEUE_REL_PATH,
  PLAN_STATUSES,
  PLAN_PRIORITIES,
  type PlanStatus,
  type PlanPriority,
} from "./constants.ts";

export {
  parseQueueYaml,
  serializeQueue,
  isValidSlug,
  QUEUE_COLUMNS,
  type QueueColumn,
  type QueueOrder,
  type QueueParseResult,
} from "./queue.ts";

export {
  fetchPlanLedger,
  defaultPlanLedgerDeps,
  ledgerWarnKey,
  type LedgerPlan,
  type LedgerPr,
  type PlanLedgerDeps,
  type PlanLedgerResult,
} from "./ledger.ts";

export {
  buildPricing,
  estimate,
  calibration,
  poolFor,
  planFamily,
  familyFromSlug,
  normalizeRepo,
  repoFamily,
  declaredPrCount,
  quantile,
  KNOWN_REPOS,
  CLAUDE_FAMILY,
  GLOBAL_POOL,
  MIN_FAMILY_SAMPLES,
  UNKNOWN_REPO,
  type Pricing,
  type PoolStats,
  type PlanEstimate,
  type PlanFamily,
  type ShippedSample,
  type Calibration,
  type CalibrationScore,
  type PlanFamilyOptions,
} from "./estimate.ts";

export { joinPlans, type JoinedPlan, type JoinResult } from "./join.ts";
