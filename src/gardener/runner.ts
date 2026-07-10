/**
 * Wiki-gardener pipeline orchestration.
 *
 * `runGardener` wires the pure stages (harvest → cluster → target-resolve →
 * draft → shape-gate) around injected seams so it stays unit-testable, persists
 * each proposal AS ITS DRAFTING COMPLETES (a mid-run timeout must not strand
 * undrafted proposals silently), and returns one watcher alert announcing what
 * was persisted.
 */

import path from "node:path";
import type { WatcherAlert } from "../types.ts";
import type { WikiIndex } from "../wiki/store.ts";
import type { Tracer } from "../tracing/index.ts";
import type {
  InsertWikiProposalParams,
  WikiProposal,
  WikiProposalSourceDoc,
} from "../db/wiki-proposals.ts";
import type { Cluster, HarvestedDoc, ListedDoc, RawFetchedDoc } from "./types.ts";
import { harvestDocs } from "./harvest.ts";
import { buildClusterPrompt, filterClusters, parseClusters } from "./cluster.ts";
import { resolveTarget } from "./target-resolve.ts";
import { buildDraftPrompt, normalizeDraftOutput, shapeGate } from "./draft.ts";
import { sha256, todayOslo } from "./util.ts";
import { getLog } from "../logging.ts";

const log = getLog("gardener", "runner");

export interface GardenerDeps {
  botName: string;
  /** Absolute wiki root (the bot's `wikiDir`) — the path-confinement anchor. */
  wikiDir: string;
  /** Summary collections to harvest (defaults to SUMMARY_SOURCES collections). */
  collections: string[];
  minClusterSize: number;
  lookbackDays: number;
  maxProposalsPerRun: number;
  /** Per-draft one-shot timeout, ms. */
  draftTimeoutMs: number;
  now: () => number;
  tracer?: Tracer;

  // Harvest seams.
  listDocs: (collection: string) => Promise<ListedDoc[]>;
  fetchDoc: (collection: string, id: string) => Promise<RawFetchedDoc | null>;

  // Cluster seams.
  callCluster: (prompt: string) => Promise<string>;
  loadInterestProfile: () => Promise<string | null>;

  // Resolve seam.
  getWikiIndex: () => Promise<WikiIndex | null>;

  // Draft seams.
  callDraft: (prompt: string, timeoutMs: number) => Promise<string>;
  readWikiFile: (absPath: string) => Promise<string | null>;

  // DB seams.
  liveTopicKeys: () => Promise<string[]>;
  rejectedTopicKeys: () => Promise<string[]>;
  consumedDocIds: () => Promise<Set<string>>;
  insertProposal: (params: InsertWikiProposalParams) => Promise<WikiProposal | null>;

  // Progress + soft-cancel seams (backlog drain only — the weekly checker passes
  // none, so behavior is byte-identical). `onProgress` reports at the same points
  // the tracer already marks; `shouldAbort` is polled at the top of each draft
  // iteration (and once right after clustering) — a true value breaks the draft
  // loop, keeping already-persisted proposals; `onAborted` fires once on that
  // break with the doc keys the cancel prevented from drafting (minus docs whose
  // cluster already produced a proposal, since clusters may share a doc).
  onProgress?: (p: GardenerProgress) => void;
  shouldAbort?: () => boolean;
  onAborted?: (skippedClusterDocKeys: string[]) => void;
}

/** One progress report emitted by a run (drafts fields present only while drafting). */
export interface GardenerProgress {
  stage: "harvesting" | "clustering" | "resolving" | "drafting";
  draftsDone?: number;
  draftsTotal?: number;
  currentTopic?: string;
}

function sourceDocsFor(cluster: Cluster, byKey: Map<string, HarvestedDoc>): WikiProposalSourceDoc[] {
  const docs: WikiProposalSourceDoc[] = [];
  for (const key of cluster.docIds) {
    const d = byKey.get(key);
    if (d) docs.push({ collection: d.collection, docId: d.id, title: d.title, url: d.url });
  }
  return docs;
}

/**
 * Run one gardener pass. Returns the watcher alerts to surface (at most one),
 * or [] when nothing was drafted. Never throws for a single stage failure that
 * can be logged and skipped — but a hard harvest/cluster failure propagates so
 * the watcher runner records the error span.
 */
export async function runGardener(deps: GardenerDeps): Promise<WatcherAlert[]> {
  const { botName, tracer, now } = deps;
  const runStart = now();

  // --- Harvest ---
  tracer?.start("harvest");
  deps.onProgress?.({ stage: "harvesting" });
  const consumed = await deps.consumedDocIds();
  const docs = await harvestDocs(deps.collections, deps, {
    lookbackDays: deps.lookbackDays,
    consumed,
    now: runStart,
    botName,
  });
  tracer?.end("harvest", { docs: docs.length });

  if (docs.length < deps.minClusterSize) {
    log.info("Gardener: only {n} doc(s) harvested (< minClusterSize {min}) — nothing to cluster", {
      botName,
      n: docs.length,
      min: deps.minClusterSize,
    });
    return [];
  }

  const byKey = new Map(docs.map((d) => [d.key, d]));
  const validDocKeys = new Set(byKey.keys());

  // --- Cluster ---
  tracer?.start("cluster");
  deps.onProgress?.({ stage: "clustering" });
  // The wiki index is loaded BEFORE clustering (not just for target-resolve):
  // the cluster model must know which pages already exist so it labels an
  // already-covered topic with the canonical title verbatim — that exact match
  // is what flips target-resolve to UPDATE instead of creating a near-duplicate
  // sibling page ("AI-Assisted Coding Workflows" next to "AI Coding Workflows").
  const [interestProfile, liveKeys, rejectedKeys, index] = await Promise.all([
    deps.loadInterestProfile(),
    deps.liveTopicKeys(),
    deps.rejectedTopicKeys(),
    deps.getWikiIndex(),
  ]);
  const rejectedHint = [...new Set([...rejectedKeys, ...liveKeys])];
  // Concept/entity pages only — the kinds the gardener drafts. Source pages
  // (hundreds of video/article titles) would bloat the prompt without ever
  // being a duplicate target.
  const existingPages = (index?.pages ?? [])
    .filter((p) => p.type === "concept" || p.type === "entity")
    .map((p) => (p.aliases.length > 0 ? `${p.title} (aliases: ${p.aliases.join(", ")})` : p.title));
  const clusterPrompt = buildClusterPrompt(docs, {
    interestProfile,
    rejectedLabels: rejectedHint,
    existingPages,
  });
  const clusterRaw = await deps.callCluster(clusterPrompt);
  const clusters = filterClusters(parseClusters(clusterRaw), {
    validDocKeys,
    minClusterSize: deps.minClusterSize,
    maxProposalsPerRun: deps.maxProposalsPerRun,
    skipTopicKeys: new Set([...liveKeys, ...rejectedKeys]),
  });
  tracer?.end("cluster", { clusters: clusters.length });

  if (clusters.length === 0) {
    log.info("Gardener: no clusters passed the skip/size filter", { botName });
    return [];
  }

  // Cancel checkpoint right after clustering — a cancel during harvest/clustering
  // shouldn't wait for resolve + the first draft. `resolved` doesn't exist yet, so
  // the skipped set is the union of every surviving cluster's docs (nothing drafted
  // to subtract); `draftsTotal = clusters.length` so the outcome records k/n, not 0/0.
  if (deps.shouldAbort?.()) {
    deps.onProgress?.({ stage: "drafting", draftsDone: 0, draftsTotal: clusters.length });
    deps.onAborted?.([...new Set(clusters.flatMap((c) => c.docIds))]);
    log.info("Gardener run cancelled after 0/{n} drafts (before drafting)", {
      botName,
      n: clusters.length,
    });
    return [];
  }

  // --- Target-resolve (reuses the index loaded before clustering) ---
  tracer?.start("resolve");
  deps.onProgress?.({ stage: "resolving" });
  const resolved = clusters.map((c) => ({ cluster: c, target: resolveTarget(c, index) }));
  tracer?.end("resolve", {
    creates: resolved.filter((r) => r.target.mode === "create").length,
    updates: resolved.filter((r) => r.target.mode === "update").length,
  });

  // --- Draft + persist (each proposal persisted as its draft completes) ---
  tracer?.start("draft");
  // Emit the total before the loop: a cancel that lands during the resolve await
  // aborts at iteration 0, before any per-iteration progress has carried
  // `draftsTotal` — without this the outcome would record 0/0.
  deps.onProgress?.({ stage: "drafting", draftsDone: 0, draftsTotal: resolved.length });
  const persisted: WikiProposal[] = [];
  // Docs whose cluster already produced a proposal — subtracted from the aborted
  // set so a doc a proposal already covers never returns to the queue on cancel.
  const draftedDocKeys = new Set<string>();
  for (let i = 0; i < resolved.length; i++) {
    const { cluster, target } = resolved[i]!;

    // Soft cancel: honor a cancel request at the top of each iteration. The
    // in-flight draft (if any) already finished; we keep every persisted proposal
    // and return the not-yet-drafted clusters' docs (minus already-drafted docs)
    // to the queue via `onAborted`, then fall through to the normal notify path.
    if (deps.shouldAbort?.()) {
      const skipped = new Set<string>();
      for (let j = i; j < resolved.length; j++) {
        for (const k of resolved[j]!.cluster.docIds) {
          if (!draftedDocKeys.has(k)) skipped.add(k);
        }
      }
      deps.onAborted?.([...skipped]);
      log.info("Gardener run cancelled after {k}/{n} drafts", {
        botName,
        k: persisted.length,
        n: resolved.length,
      });
      break;
    }

    deps.onProgress?.({
      stage: "drafting",
      draftsDone: persisted.length,
      draftsTotal: resolved.length,
      currentTopic: cluster.label,
    });

    const clusterDocs = cluster.docIds
      .map((k) => byKey.get(k))
      .filter((d): d is HarvestedDoc => !!d);

    let currentBody: string | null = null;
    let baseHash: string | null = null;
    if (target.mode === "update" && target.existingRelPath) {
      currentBody = await deps.readWikiFile(path.join(deps.wikiDir, target.existingRelPath));
      // Null check, not truthiness — an existing-but-empty page must still get a
      // baseHash, or apply would always report it stale.
      if (currentBody !== null) baseHash = sha256(currentBody);
    }

    const prompt = buildDraftPrompt({
      cluster,
      mode: target.mode,
      docs: clusterDocs,
      today: todayOslo(runStart),
      currentBody,
    });

    let draftText: string;
    try {
      draftText = normalizeDraftOutput(await deps.callDraft(prompt, deps.draftTimeoutMs));
    } catch (err) {
      log.error("Gardener draft failed for topic {topic}: {error}", {
        botName,
        topic: cluster.topicKey,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const gate = shapeGate(draftText, {
      kind: cluster.kind,
      targetPath: target.targetPath,
      wikiDir: deps.wikiDir,
      domain: cluster.domain,
      existingRelPath: target.existingRelPath,
    });
    if (!gate.ok) {
      log.warn("Gardener draft dropped for topic {topic}: {reason}", {
        botName,
        topic: cluster.topicKey,
        reason: gate.reason,
      });
      continue;
    }

    try {
      const row = await deps.insertProposal({
        botName,
        topicKey: cluster.topicKey,
        kind: cluster.kind,
        mode: target.mode,
        targetPath: target.targetPath,
        baseHash,
        draft: draftText.trim(),
        sourceDocs: sourceDocsFor(cluster, byKey),
        rationale: cluster.rationale ?? null,
      });
      if (row) {
        persisted.push(row);
        for (const k of cluster.docIds) draftedDocKeys.add(k);
        deps.onProgress?.({
          stage: "drafting",
          draftsDone: persisted.length,
          draftsTotal: resolved.length,
          currentTopic: cluster.label,
        });
        log.info("Gardener persisted proposal {id} for topic {topic} ({mode})", {
          botName,
          id: row.id,
          topic: cluster.topicKey,
          mode: target.mode,
        });
      } else {
        log.info("Gardener proposal for topic {topic} skipped (live proposal already exists)", {
          botName,
          topic: cluster.topicKey,
        });
      }
    } catch (err) {
      log.error("Gardener failed to persist proposal for topic {topic}: {error}", {
        botName,
        topic: cluster.topicKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  tracer?.end("draft", { persisted: persisted.length });

  if (persisted.length === 0) return [];

  // Map cluster labels back onto persisted rows for the notification.
  const labelByTopic = new Map(clusters.map((c) => [c.topicKey, c.label]));
  const labels = persisted.map((p) => labelByTopic.get(p.topicKey) ?? p.topicKey);
  const ids = persisted.map((p) => p.id);

  // Per-run-unique alert id — the runner's lastNotifiedIds dedup runs
  // unconditionally, so a static id would silently drop every run after the first.
  return [
    {
      id: `wiki-gardener:${ids.join(",")}`,
      source: "wiki-gardener",
      summary: `${persisted.length} wiki draft(s) pending review — ${labels.join(", ")} — /wiki/gardener`,
      urgency: "low",
    },
  ];
}
