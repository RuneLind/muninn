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
import { buildDraftPrompt, shapeGate } from "./draft.ts";
import { getLog } from "../logging.ts";

const log = getLog("gardener", "runner");

const OSLO_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Oslo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

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
}

function todayOslo(now: number): string {
  return OSLO_DATE_FMT.format(new Date(now));
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
  const [interestProfile, liveKeys, rejectedKeys] = await Promise.all([
    deps.loadInterestProfile(),
    deps.liveTopicKeys(),
    deps.rejectedTopicKeys(),
  ]);
  const rejectedHint = [...new Set([...rejectedKeys, ...liveKeys])];
  const clusterPrompt = buildClusterPrompt(docs, {
    interestProfile,
    rejectedLabels: rejectedHint,
  });
  const clusterRaw = await deps.callCluster(clusterPrompt);
  const clusters = filterClusters(parseClusters(clusterRaw), {
    validDocKeys,
    minClusterSize: deps.minClusterSize,
    maxProposalsPerRun: deps.maxProposalsPerRun,
    liveTopicKeys: new Set(liveKeys),
    rejectedTopicKeys: new Set(rejectedKeys),
  });
  tracer?.end("cluster", { clusters: clusters.length });

  if (clusters.length === 0) {
    log.info("Gardener: no clusters passed the skip/size filter", { botName });
    return [];
  }

  // --- Target-resolve ---
  tracer?.start("resolve");
  const index = await deps.getWikiIndex();
  const resolved = clusters.map((c) => ({ cluster: c, target: resolveTarget(c, index) }));
  tracer?.end("resolve", {
    creates: resolved.filter((r) => r.target.mode === "create").length,
    updates: resolved.filter((r) => r.target.mode === "update").length,
  });

  // --- Draft + persist (each proposal persisted as its draft completes) ---
  tracer?.start("draft");
  const persisted: WikiProposal[] = [];
  for (const { cluster, target } of resolved) {
    const clusterDocs = cluster.docIds
      .map((k) => byKey.get(k))
      .filter((d): d is HarvestedDoc => !!d);

    let currentBody: string | null = null;
    let baseHash: string | null = null;
    if (target.mode === "update" && target.existingRelPath) {
      currentBody = await deps.readWikiFile(path.join(deps.wikiDir, target.existingRelPath));
      if (currentBody) baseHash = sha256(currentBody);
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
      draftText = await deps.callDraft(prompt, deps.draftTimeoutMs);
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
      summary: `${persisted.length} wiki draft(s) pending review — ${labels.join(", ")}`,
      urgency: "low",
    },
  ];
}
