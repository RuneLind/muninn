/**
 * Wiki-gardener pipeline types.
 *
 * The gardener clusters recently-ingested summaries (stored in huginn
 * collections) and drafts knowledge-wiki page proposals from them. PR 1 is the
 * proposal pipeline only — harvest → cluster → target-resolve → draft →
 * shape-gate → persist proposals → notify. No wiki writes, no review UI.
 */

export type ClusterKind = "concept" | "entity";
export type ClusterDomain = "ai" | "life";

/** Per-bot `config.json` `gardener` block. All fields optional (defaults below). */
export interface GardenerConfig {
  enabled?: boolean;
  minClusterSize?: number;
  lookbackDays?: number;
  maxProposalsPerRun?: number;
}

export const GARDENER_DEFAULTS = {
  minClusterSize: 3,
  lookbackDays: 14,
  maxProposalsPerRun: 3,
  /**
   * TTL (days) on the rejected-topic SKIP behavior. A rejection is a verdict on
   * one draft, not a permanent verdict on the topic — after this many days a
   * rejected topic becomes re-proposable, so a healthy cluster no longer dies on
   * a week-old rejection every run. The SQL predicate is `resolved_at > now() −
   * rejectedSkipDays`. Deliberately a **bare constant**, NOT a per-bot
   * `GardenerConfig` field — the cluster-prompt HINT still sees ALL rejections
   * (informed re-try, not amnesia), only the skip SET is TTL'd. Sub-TTL ops
   * escape hatch (for a bad-draft rejection on a healthy topic that shouldn't
   * wait out even this window): move the row OUT of the `rejected` status so it
   * drops from the skip predicate immediately — there is deliberately no
   * un-reject UI.
   */
  rejectedSkipDays: 7,
  /**
   * Max harvest-window docs inlined into the pass-1 doc→page MAP prompt (the
   * deterministic "does this doc squarely belong on an existing page?" call that
   * runs alongside the cluster call). Bounds the map prompt the same way the
   * cluster prompt bounds its existing-page list — a busy fortnight can harvest
   * well past this, so the map call sees the most-recent `mapMaxDocs` (docs are
   * date-prefixed ids ⇒ a descending id sort is a recency sort). The pass-0
   * cluster call is unaffected (it still sees every harvested doc).
   */
  mapMaxDocs: 60,
} as const;

/** Merge a partial config with the defaults into a fully-resolved shape. */
export function resolveGardenerConfig(config: GardenerConfig | undefined): {
  minClusterSize: number;
  lookbackDays: number;
  maxProposalsPerRun: number;
} {
  return {
    minClusterSize:
      typeof config?.minClusterSize === "number" && config.minClusterSize > 0
        ? config.minClusterSize
        : GARDENER_DEFAULTS.minClusterSize,
    lookbackDays:
      typeof config?.lookbackDays === "number" && config.lookbackDays > 0
        ? config.lookbackDays
        : GARDENER_DEFAULTS.lookbackDays,
    maxProposalsPerRun:
      typeof config?.maxProposalsPerRun === "number" && config.maxProposalsPerRun > 0
        ? config.maxProposalsPerRun
        : GARDENER_DEFAULTS.maxProposalsPerRun,
  };
}

/** A doc as returned by the collection documents listing (`?include_dates=1`). */
export interface ListedDoc {
  id: string;
  url?: string;
  date?: string;
}

/** Raw doc body from `GET /api/document/<collection>/<id>`. */
export interface RawFetchedDoc {
  id?: string;
  url?: string;
  modifiedTime?: string;
  text?: string;
  metadata?: {
    date?: string;
    url?: string;
    category?: string;
    author?: string;
    tags?: string[];
    [key: string]: unknown;
  };
}

/** A harvested doc, normalized for clustering + drafting. */
export interface HarvestedDoc {
  /** `<collection>/<id>` — the stable key echoed by the cluster model + stored in source_docs. */
  key: string;
  collection: string;
  id: string;
  url: string;
  title: string;
  category?: string;
  author?: string;
  /** Full body text (heading + prose), used in the draft prompt. */
  text: string;
}

/** One cluster proposed by the cluster model. */
export interface Cluster {
  topicKey: string;
  kind: ClusterKind;
  domain: ClusterDomain;
  label: string;
  /** `<collection>/<id>` keys — validated against the harvested set. */
  docIds: string[];
  rationale?: string;
}

/** Target resolution result for a cluster. */
export interface ResolvedTarget {
  mode: "create" | "update";
  /** Wiki-relative path (e.g. `concepts/Context Compaction.md`). */
  targetPath: string;
  /** For update mode: the existing page's relative path (the confinement anchor). */
  existingRelPath?: string;
  /**
   * Set when the matched page's kind differs from the cluster's: the wiki's
   * existing classification wins over the cluster model's guess (an "entity"
   * cluster titled like an existing concept page updates that concept page).
   * The runner re-kinds the cluster with this before drafting.
   */
  kind?: ClusterKind;
}
