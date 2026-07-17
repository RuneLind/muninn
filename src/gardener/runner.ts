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
import { buildClusterPrompt, existingPageLines, filterClusters, parseClusters } from "./cluster.ts";
import { resolveTarget } from "./target-resolve.ts";
import {
  appendPendingIngestionCallout,
  buildDraftPrompt,
  containDraftBodyLinks,
  isHttpUrl,
  normalizeDraftOutput,
  replaceUnresolvedSourceLinks,
  shapeGate,
  stripOwnedAliases,
} from "./draft.ts";
import { parseFrontmatter } from "../wiki/store.ts";
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
  /**
   * Optional content-dedup seam: return existing wiki pages possibly related to a
   * query (huginn search over the bot's `wikiCollections`), inlined into the draft
   * prompt so the drafter folds into / See-also's them instead of duplicating.
   * Omitted entirely when the bot has no `wikiCollections` (absent ⇒ no block,
   * never an unscoped search). Errors degrade to no block — never abort the draft.
   */
  searchRelated?: (query: string) => Promise<{ title: string; snippet: string }[]>;

  // DB seams.
  liveTopicKeys: () => Promise<string[]>;
  /** ALL rejected topicKeys — feeds the cluster-prompt HINT only (informed re-try). */
  rejectedTopicKeys: () => Promise<string[]>;
  /** Rejected within the TTL window — feeds the cluster-time SKIP set only. */
  recentlyRejectedTopicKeys: () => Promise<string[]>;
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
  const [interestProfile, liveKeys, rejectedKeys, recentlyRejectedKeys, index] = await Promise.all([
    deps.loadInterestProfile(),
    deps.liveTopicKeys(),
    deps.rejectedTopicKeys(),
    deps.recentlyRejectedTopicKeys(),
    deps.getWikiIndex(),
  ]);
  // The HINT sees ALL rejections (+ live) so the model reuses a prior topicKey
  // instead of coining a near-synonym; the SKIP set below only suppresses live +
  // RECENTLY-rejected topics, so an expired rejection is re-proposable.
  const rejectedHint = [...new Set([...rejectedKeys, ...liveKeys])];
  // Concept/entity pages only — the kinds the gardener drafts. Source pages
  // (hundreds of video/article titles) would bloat the prompt without ever
  // being a duplicate target.
  const existingPages = existingPageLines(index);
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
    skipTopicKeys: new Set([...liveKeys, ...recentlyRejectedKeys]),
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

    // Cross-kind title match: the wiki's classification wins — re-kind the
    // cluster so the draft (prompt + shape-gate + proposal row) matches the
    // canonical page it updates.
    const effective = target.kind && target.kind !== cluster.kind
      ? { ...cluster, kind: target.kind }
      : cluster;
    if (effective !== cluster) {
      log.info("Gardener re-kinded cluster {topic} {from} → {to} to match existing page {path}", {
        botName,
        topic: cluster.topicKey,
        from: cluster.kind,
        to: effective.kind,
        path: target.existingRelPath,
      });
    }

    const clusterDocs = effective.docIds
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

    // Content-dedup visibility: surface possibly-related existing pages so the
    // drafter folds into them. Best-effort — an absent seam or any error yields
    // no block and never aborts the draft.
    let related: { title: string; snippet: string }[] = [];
    if (deps.searchRelated) {
      const query = [effective.label, ...clusterDocs.slice(0, 3).map((d) => d.title)]
        .filter((s) => s && s.trim())
        .join(" ")
        .slice(0, 200);
      try {
        related = await deps.searchRelated(query);
      } catch (err) {
        log.warn("Gardener searchRelated failed for topic {topic}: {error}", {
          botName,
          topic: cluster.topicKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const prompt = buildDraftPrompt({
      cluster: effective,
      mode: target.mode,
      docs: clusterDocs,
      today: todayOslo(runStart),
      currentBody,
      related,
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
      kind: effective.kind,
      targetPath: target.targetPath,
      wikiDir: deps.wikiDir,
      domain: effective.domain,
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

    // Alias-hijack guard: drop aliases another page already owns, so a new
    // page can't steal wikilink resolution from the canonical one.
    const dealiased = stripOwnedAliases(draftText, {
      index,
      selfRelPath: target.existingRelPath,
    });
    if (dealiased.stripped.length > 0) {
      log.warn("Gardener draft for {topic}: stripped alias(es) owned by other pages: {aliases}", {
        botName,
        topic: cluster.topicKey,
        aliases: dealiased.stripped.join(", "),
      });
    }

    // Source-link guard: replace unresolved `[[source page]]` refs in the
    // frontmatter `sources:` list with the cluster's real source_docs URLs — the
    // drafter can't see which source pages exist, so an invented ref is a broken
    // link. Mutates the stored draft, so it must run before insert.
    // Only PUBLIC (http/https) URLs may be appended into `sources:`. huginn
    // stores a machine-local `file://…` path for a not-yet-ingested local doc
    // (harvest.ts flows it straight into HarvestedDoc.url); filtering it here —
    // and again inside replaceUnresolvedSourceLinks — stops that path leaking
    // into a shipped page's citation trail. An empty `sources: []` is fine.
    const sourceDocs = sourceDocsFor(cluster, byKey);
    const sourceUrls = sourceDocs.map((d) => d.url).filter((u): u is string => isHttpUrl(u));
    const relinked = replaceUnresolvedSourceLinks(dealiased.draft, { index, urls: sourceUrls });
    if (relinked.replaced.length > 0) {
      log.warn("Gardener draft for {topic}: replaced unresolved source link(s) with URLs: {links}", {
        botName,
        topic: cluster.topicKey,
        links: relinked.replaced.join(", "),
      });
    }
    if (relinked.droppedLiterals.length > 0) {
      // Model-authored non-http(s) literals (e.g. a file:// path copied from a
      // summary header) dropped from `sources:` — the pending-ingestion callout
      // below names the affected docs, so the citation stays honest.
      log.warn("Gardener draft for {topic}: dropped non-http(s) source literal(s): {literals}", {
        botName,
        topic: cluster.topicKey,
        literals: relinked.droppedLiterals.join(", "),
      });
    }

    // Body-link containment (symmetric with the source-link guard above): de-link
    // unresolvable body `[[wikilinks]]` to plain bold text — a wikilink is a claim
    // that a page exists, and only the index can make that claim. With a NULL index
    // we can't tell resolvable from phantom, so we SKIP containment entirely rather
    // than de-link a whole draft on an index outage (the read-time scan chip still
    // surfaces the links on the review gate). selfTitle comes from the draft's own
    // frontmatter so an update-mode page linking itself is de-linked too.
    let containedDraft = relinked.draft;
    let containedLinks: string[] = [];
    if (index) {
      const fm = parseFrontmatter(containedDraft);
      const selfTitle = Array.isArray(fm.title) ? fm.title[0] : fm.title;
      const contained = containDraftBodyLinks(containedDraft, {
        resolve: index.resolve,
        selfTitle,
      });
      containedDraft = contained.draft;
      containedLinks = contained.delinked;
      if (containedLinks.length > 0) {
        log.warn("Gardener draft for {topic}: de-linked unresolvable body link(s): {links}", {
          botName,
          topic: cluster.topicKey,
          links: containedLinks.join(", "),
        });
      }
    } else {
      log.warn("Gardener draft for {topic}: null wiki index — skipping body-link containment", {
        botName,
        topic: cluster.topicKey,
      });
    }

    // Pending-ingestion callout (after containment, before insert): for any
    // cluster doc whose URL was filtered out above (non-http/https or empty),
    // append ONE callout listing them so the citation is honest — the source
    // exists but has no public URL yet. Byte-identical to today when every doc
    // has a real URL (the common case): appendPendingIngestionCallout no-ops.
    const pendingDocs = sourceDocs.filter((d) => !isHttpUrl(d.url));
    const finalDraft = appendPendingIngestionCallout(containedDraft, pendingDocs);
    if (pendingDocs.length > 0) {
      log.info("Gardener draft for {topic}: {count} source(s) pending ingestion (no public URL)", {
        botName,
        topic: cluster.topicKey,
        count: pendingDocs.length,
      });
    }

    // Persist the top-3 related existing pages (resolving titles to relPaths via
    // the fresh index where possible) so the apply-time wire stage can add
    // inbound See-also links back from them — the retrieval that only fed the
    // draft prompt before is now durable. Empty array (seam absent / no hits) is
    // stored as [] and reads back as "no inbound links, but not pre-migration";
    // a genuine NULL only appears on rows drafted before this column.
    const relatedPages = related.slice(0, 3).map((r) => {
      const page = index?.resolve(r.title);
      return page ? { title: r.title, relPath: page.relPath } : { title: r.title };
    });

    try {
      const row = await deps.insertProposal({
        botName,
        topicKey: cluster.topicKey,
        kind: effective.kind,
        mode: target.mode,
        targetPath: target.targetPath,
        baseHash,
        draft: finalDraft.trim(),
        sourceDocs,
        rationale: cluster.rationale ?? null,
        containedLinks: containedLinks.length > 0 ? { delinked: containedLinks } : null,
        relatedPages,
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
