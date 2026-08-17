/**
 * `/plans` — the kanban board over mimir's `plans/` directory, priced from the
 * claude-usage ledger.
 *
 * This barrel is the surface PR 2's page and PR 4's write path consume. Three
 * modules, one job each, and the split is deliberate: {@link estimate} is pure so
 * the pricing rule is testable against a fixture, {@link source} touches only the
 * filesystem, {@link ledger} touches only the network.
 */

export {
  loadPlanSource,
  planRecordFromContent,
  resolvePlansRoot,
  PLAN_STATUSES,
  PLAN_PRIORITIES,
  PLANS_WIKI_NAME,
  PLANS_DIR,
  QUEUE_REL_PATH,
  type PlanRecord,
  type PlanStatus,
  type PlanPriority,
  type PlanQueue,
  type PlanSourceResult,
  type PlanSourceOptions,
} from "./source.ts";

export {
  parseQueueYaml,
  serializeQueue,
  QUEUE_COLUMNS,
  type QueueColumn,
  type QueueOrder,
  type QueueParseResult,
} from "./queue.ts";

export {
  fetchPlanLedger,
  defaultPlanLedgerDeps,
  CLAUDE_USAGE_DEFAULT_URL,
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
  normalizeRepo,
  repoFamily,
  declaredPrCount,
  quantile,
  KNOWN_REPOS,
  CLAUDE_FAMILY,
  GLOBAL_POOL,
  MIN_FAMILY_SAMPLES,
  type Pricing,
  type PoolStats,
  type PlanEstimate,
  type PlanFamily,
  type ShippedSample,
  type Calibration,
} from "./estimate.ts";

export { joinPlans, type JoinedPlan, type JoinResult } from "./join.ts";
