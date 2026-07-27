/**
 * Consolidation-gardener watcher checker.
 *
 * The weekly automation leg of the consolidation gardener: where the Atlas rail's
 * "Draft synthesis" button (PR 2) is a manual, one-cluster-at-a-time trigger, this
 * watcher scans a wiki's semantic overlay on a weekly cadence, finds the
 * synthesis-CANDIDATE clusters of the wiki's OWN pages (`computeClusters`, the same
 * union-find the rail uses), skips clusters already drafted/approved/applied
 * (topic-key dedup against `getLiveOrAppliedTopicKeysByWiki` — the PRIMARY dedup),
 * ranks the rest, and drafts the top `capPerRun` through the SAME PR 2 drafter seam
 * (`draftAndPersistSynthesis`) into the `wiki_proposals` gate under kind
 * `synthesis`. It alerts (🧩) with a per-run-unique id pointing at
 * `/wiki/gardener?wiki=<name>` when it drafted ≥1 proposal; a zero-draft run sends
 * NO alert (nothing to review).
 *
 * Config (on the watcher row's JSONB `config`):
 *   - `wiki`       — the wiki name to consolidate (required; e.g. "mimir").
 *   - `threshold`  — the similarity edge threshold for `computeClusters`
 *                    (default 0.98, the slider default).
 *   - `capPerRun`  — max real model drafts per run (default 2).
 *
 * Skip WITHOUT an alert (not an error, non-sticky): no registry entry / no
 * collections for the wiki, wiki index unreadable, huginn overlay unavailable, no
 * resolved synthesis bot. The run never throws for these — it warns and returns [].
 *
 * Telemetry: the runner threads its `watcher:consolidation-gardener` span in via
 * `telemetry.tracer`; each draft's traced one-shot attaches a `claude` child span
 * under it (mirrors how `wiki-gardener` reuses the runner span), so runs land on
 * /traces + /agents truthfully.
 */

import type { Watcher, WatcherAlert } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";
import { loadConfig } from "../config.ts";
import type { HaikuTelemetry } from "../scheduler/executor.ts";
import type { WikiRegistryEntry } from "../wiki/registry.ts";
import { findWiki } from "../wiki/registry.ts";
import { getWikiRegistry } from "../wiki/registry-memo.ts";
import { discoverAllBots, resolveWikiSynthesisBot } from "../bots/config.ts";
import { getWikiIndex } from "../wiki/store.ts";
import { getSemanticOverlay } from "../wiki/atlas-semantic.ts";
import {
  getLiveOrAppliedTopicKeysByWiki,
  getRecentlyRejectedTopicKeysByWiki,
} from "../db/wiki-proposals.ts";
import { GARDENER_DEFAULTS } from "../gardener/types.ts";
import {
  computeClusters,
  synthesisTopicKey,
  CLUSTER_ROLE_BY_TYPE,
  SEM_THRESHOLD_DEFAULT,
  type RailCluster,
  type SemanticOverlay,
} from "../dashboard/views/components/wiki-atlas-semantic.ts";
import { draftAndPersistSynthesis } from "../gardener/synthesis-drafter.ts";
import { openSourceHealth } from "./source-health.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "consolidation-gardener");

const DEFAULT_API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";

/** Default max real model drafts per weekly run — a small cap so a single run
 *  never floods the review gate; the tail drains over subsequent weeks. */
export const DEFAULT_CAP_PER_RUN = 2;

/** The consolidation-gardener watcher's JSONB `config` shape. */
export interface ConsolidationGardenerConfig {
  wiki?: string;
  threshold?: number;
  capPerRun?: number;
}

/** Injectable seams so the run logic is unit-tested without a live huginn/DB/model. */
export interface ConsolidationGardenerDeps {
  findWikiEntry: (wikiName: string) => WikiRegistryEntry | undefined;
  getBots: () => BotConfig[];
  getIndex: typeof getWikiIndex;
  getOverlay: typeof getSemanticOverlay;
  getLiveOrAppliedTopics: (wikiName: string) => Promise<string[]>;
  /** TopicKeys rejected within the TTL window — skipped so a human's reject on a
   *  synthesis draft isn't re-drafted every weekly run (mirrors the concept
   *  gardener's `getRecentlyRejectedTopicKeys` 7-day TTL). */
  getRecentlyRejectedTopics: (wikiName: string) => Promise<string[]>;
  draft: typeof draftAndPersistSynthesis;
  knowledgeApiUrl: string;
  config: Config;
}

function defaultDeps(): ConsolidationGardenerDeps {
  return {
    findWikiEntry: (wikiName) => findWiki(getWikiRegistry(), wikiName),
    getBots: () => discoverAllBots(),
    getIndex: getWikiIndex,
    getOverlay: getSemanticOverlay,
    getLiveOrAppliedTopics: getLiveOrAppliedTopicKeysByWiki,
    getRecentlyRejectedTopics: (wikiName) =>
      getRecentlyRejectedTopicKeysByWiki(wikiName, GARDENER_DEFAULTS.rejectedSkipDays),
    draft: draftAndPersistSynthesis,
    knowledgeApiUrl: DEFAULT_API_URL,
    config: loadConfig(),
  };
}

/** A candidate cluster after dedup, carrying its ranking key. */
export interface RankedCandidate {
  cluster: RailCluster;
  topicKey: string;
  /** Members whose page type maps to the "narrative" consolidation role. */
  narrativeCount: number;
}

/**
 * Rank the surviving candidates: size DESC, then narrative-member SHARE desc
 * (narrativeCount / size), then id asc for a deterministic tie-break. Pure +
 * exported so the ranking is unit-tested directly. `computeClusters` already
 * marked each cluster `candidate`; this only orders the survivors.
 */
export function rankCandidates(
  candidates: RailCluster[],
  overlay: SemanticOverlay,
): RankedCandidate[] {
  const nodeType = overlay.nodeType ?? {};
  const ranked: RankedCandidate[] = candidates.map((cluster) => {
    let narrativeCount = 0;
    for (const m of cluster.members) {
      if (CLUSTER_ROLE_BY_TYPE[nodeType[m] ?? ""] === "narrative") narrativeCount++;
    }
    return { cluster, topicKey: synthesisTopicKey(cluster.label), narrativeCount };
  });
  ranked.sort((a, b) => {
    if (b.cluster.size !== a.cluster.size) return b.cluster.size - a.cluster.size;
    const shareA = a.narrativeCount / a.cluster.size;
    const shareB = b.narrativeCount / b.cluster.size;
    if (shareB !== shareA) return shareB - shareA;
    return a.cluster.id < b.cluster.id ? -1 : a.cluster.id > b.cluster.id ? 1 : 0;
  });
  return ranked;
}

/**
 * Run the consolidation gardener for one watcher row. Returns the alert(s) to send
 * (empty when nothing was drafted, or on any non-sticky skip). Never throws for a
 * degraded external source — warns + returns [].
 */
export async function checkConsolidationGardener(
  watcher: Watcher,
  botConfig: BotConfig,
  telemetry?: HaikuTelemetry,
  depsOverride?: Partial<ConsolidationGardenerDeps>,
): Promise<WatcherAlert[]> {
  const deps = { ...defaultDeps(), ...depsOverride };
  const cfg = (watcher.config ?? {}) as ConsolidationGardenerConfig;

  const wikiName = typeof cfg.wiki === "string" ? cfg.wiki.trim() : "";
  if (!wikiName) {
    log.warn("consolidation-gardener: watcher {id} has no config.wiki — skipping", {
      botName: botConfig.name,
      id: watcher.id,
    });
    return [];
  }

  const threshold = typeof cfg.threshold === "number" ? cfg.threshold : SEM_THRESHOLD_DEFAULT;
  const capPerRun =
    typeof cfg.capPerRun === "number" && cfg.capPerRun > 0
      ? Math.floor(cfg.capPerRun)
      : DEFAULT_CAP_PER_RUN;

  // Per-source health (2026-07 audit). Every degrade below is a permanent kill for a
  // WEEKLY watcher: a renamed/removed WIKI_EXTRA entry or dropped collections silences it
  // for months at one warn line per week, with `last_run_at` advancing the whole time. No
  // data is lost (clusters persist; the Atlas "Draft synthesis" button is an independent
  // human path), but the feature is 100% dead and nothing says so.
  const health = await openSourceHealth(watcher.id, watcher.name);
  const SRC = `consolidation:${wikiName}`;

  // 1. Registry entry + collections.
  const entry = deps.findWikiEntry(wikiName);
  if (!entry) {
    log.warn("consolidation-gardener: no wiki registry entry for {wiki} — skipping", {
      botName: botConfig.name,
      wiki: wikiName,
    });
    health.mark(SRC, "error", `no wiki registry entry for "${wikiName}" (renamed or removed?)`);
    return health.finish();
  }
  const collections = entry.collections ?? [];
  if (collections.length === 0) {
    log.warn("consolidation-gardener: wiki {wiki} has no collections — skipping", {
      botName: botConfig.name,
      wiki: wikiName,
    });
    health.mark(SRC, "error", `wiki "${wikiName}" has no backing collections`);
    return health.finish();
  }

  // 2. Wiki index.
  const index = await deps.getIndex({ root: entry.root });
  if (!index) {
    log.warn("consolidation-gardener: wiki {wiki} index unreadable ({root}) — skipping", {
      botName: botConfig.name,
      wiki: wikiName,
      root: entry.root,
    });
    health.mark(SRC, "error", `wiki index unreadable at ${entry.root}`);
    return health.finish();
  }

  // 3. Semantic overlay (huginn down ⇒ null ⇒ non-sticky skip, no alert spam).
  const overlay = await deps.getOverlay(
    deps.knowledgeApiUrl,
    entry.name,
    index,
    collections,
    true,
  );
  if (!overlay) {
    log.warn("consolidation-gardener: semantic overlay unavailable for {wiki} — skipping", {
      botName: botConfig.name,
      wiki: wikiName,
    });
    // Documented as a non-sticky skip (huginn down), and one run is genuinely fine — but
    // "non-sticky" is an assumption about huginn, not a guarantee, so it accrues a streak.
    health.mark(SRC, "skipped", "semantic overlay unavailable (huginn down?)");
    return health.finish();
  }

  // 4. Clusters at threshold → badged candidates only (blob guard is inside).
  const candidates = computeClusters(overlay, threshold).filter((c) => c.candidate && !c.tooBroad);
  if (candidates.length === 0) {
    log.info("consolidation-gardener: no candidate clusters for {wiki} at threshold {t}", {
      botName: botConfig.name,
      wiki: wikiName,
      t: threshold,
    });
    // Reaching the clustering step at all means every external source answered.
    health.mark(SRC, "ok");
    return health.finish();
  }

  // 5. PRIMARY dedup — skip clusters already drafted/approved/applied for this
  //    wiki, PLUS clusters a human rejected within the TTL window. A rejection is a
  //    verdict on one draft, not a permanent verdict on the topic (mirrors the
  //    concept gardener's TTL), but without it a rejected synthesis passes dedup
  //    every weekly run and re-drafts + re-alerts forever, ignoring the reject.
  const [live, rejected] = await Promise.all([
    deps.getLiveOrAppliedTopics(entry.name),
    deps.getRecentlyRejectedTopics(entry.name),
  ]);
  const skip = new Set([...live, ...rejected]);
  const fresh = candidates.filter((c) => !skip.has(synthesisTopicKey(c.label)));
  if (fresh.length === 0) {
    log.info(
      "consolidation-gardener: all {n} candidate(s) for {wiki} already drafted/applied — nothing to do",
      { botName: botConfig.name, wiki: wikiName, n: candidates.length },
    );
    health.mark(SRC, "ok");
    return health.finish();
  }

  // 6. Resolve the synthesis bot for the DRAFT (attribution) — like Ask/digest.
  const { bot: synthesisBot } = resolveWikiSynthesisBot(entry, deps.getBots());
  if (!synthesisBot) {
    log.warn("consolidation-gardener: no synthesis bot for {wiki} — skipping", {
      botName: botConfig.name,
      wiki: wikiName,
    });
    health.mark(SRC, "error", `no synthesis bot resolves for wiki "${wikiName}"`);
    return health.finish();
  }

  // 7. Rank + draft the top capPerRun SEQUENTIALLY (avoids the per-wiki single-flight).
  const ranked = rankCandidates(fresh, overlay).slice(0, capPerRun);
  log.info(
    "consolidation-gardener: {wiki} — {fresh} fresh candidate(s), drafting top {cap} (of {total})",
    {
      botName: botConfig.name,
      wiki: wikiName,
      fresh: fresh.length,
      cap: ranked.length,
      total: candidates.length,
    },
  );

  const persistedIds: string[] = [];
  const persistedLabels: string[] = [];
  for (const rc of ranked) {
    const label = rc.cluster.label;
    try {
      const res = await deps.draft({
        wiki: entry,
        members: rc.cluster.members,
        label,
        index,
        config: deps.config,
        botConfig: synthesisBot,
        ...(telemetry?.tracer ? { tracer: telemetry.tracer } : {}),
      });
      if (res.ok && res.proposal) {
        persistedIds.push(res.proposal.id);
        persistedLabels.push(label);
        log.info("consolidation-gardener: drafted synthesis for {wiki} topic={topic}", {
          botName: botConfig.name,
          wiki: wikiName,
          topic: res.topicKey,
        });
      } else if (res.ok && !res.proposal) {
        // Live dedup conflict swallowed the insert — a concurrent path won the topic.
        log.info("consolidation-gardener: draft for {wiki} topic={topic} deduped (no-op insert)", {
          botName: botConfig.name,
          wiki: wikiName,
          topic: res.topicKey,
        });
      } else {
        log.warn("consolidation-gardener: draft for {wiki} topic={topic} rejected: {reason}", {
          botName: botConfig.name,
          wiki: wikiName,
          topic: rc.topicKey,
          reason: res.ok ? "" : res.reason,
        });
      }
    } catch (err) {
      // Best-effort per cluster — one draft failure never aborts the run.
      log.warn("consolidation-gardener: draft for {wiki} topic={topic} threw: {error}", {
        botName: botConfig.name,
        wiki: wikiName,
        topic: rc.topicKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // The run reached the drafting stage, so every external source answered. Whether any
  // individual draft persisted is a quality question, not a source-health one.
  health.mark(SRC, "ok");
  const healthAlerts = await health.finish();

  // 8. Alert only when ≥1 proposal actually persisted (per-run-unique id).
  if (persistedIds.length === 0) return healthAlerts;
  const wikiParam = encodeURIComponent(entry.name);
  return [
    ...healthAlerts,
    {
      id: `consolidation-gardener:${persistedIds.join(",")}`,
      source: "consolidation-gardener",
      summary: `${persistedIds.length} consolidation proposal(s) await review — ${persistedLabels.join(", ")} — /wiki/gardener?wiki=${wikiParam}`,
      urgency: "low",
    },
  ];
}
