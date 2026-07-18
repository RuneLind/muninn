/**
 * Replay the wiki-gardener CLUSTER stage offline — a permanent diagnostic for the
 * "why did this run produce 0 clusters?" question. It rebuilds the exact inputs the
 * weekly checker feeds the cluster model (harvest window + existing-page hints +
 * rejected/live skip sets + interest profile), makes ONE Haiku cluster call, then
 * mirrors production's full verdict pipeline — pre-resolve `filterClusters`
 * (strip/skip/duplicate) → `resolveTarget` (create/update, read from the live wiki
 * index) → post-resolve `gateResolvedClusters` (CREATE-only size floor + shared cap
 * with a reserved update slot) — and prints a per-cluster KEPT/DROP table using the
 * drop taxonomy (`size` / `skip` / `hallucinated` / `duplicate` / `cap`). Resolve is
 * READ-ONLY: it reads the same wiki index the runner passes to resolveTarget, no
 * gardener-state writes — so the offline verdict matches the real run.
 *
 * READ-ONLY on gardener state: no writes to wiki_proposals, the offered set, traces,
 * or the wiki. (The Haiku call itself records one incidental `haiku_usage` telemetry
 * row per run via `seams.callCluster` — nothing else touches the DB.) It never calls
 * a draft — the whole point is to inspect the cluster verdict cheaply (one Haiku call).
 * Same read-only stance as `scripts/triage-backlog-tail.ts` (which this borrows its
 * conventions from), minus that script's optional `--unoffer` write path.
 *
 * Usage:
 *   bun scripts/replay-gardener-cluster.ts                 # replay the weekly window for jarvis
 *   bun scripts/replay-gardener-cluster.ts --show-prompt   # also dump the cluster prompt
 *   OWNER_BOT_NAME=jarvis bun scripts/replay-gardener-cluster.ts
 *
 * Two footguns honored (see the gardener CLAUDE.md): (1) `initDb` takes the whole
 * `Config` object, NOT a URL string; (2) the weekly `listDocs` endpoint is
 * `GET {knowledgeApiUrl}/api/collection/<c>/documents?include_dates=1` (singular
 * "collection"), replicated inline here — it is not exposed via `buildGardenerSeams`.
 *
 * Env: OWNER_BOT_NAME (default "jarvis").
 */
import { loadConfig } from "../src/config.ts";
import { initDb, closeDb } from "../src/db/client.ts";
import { discoverAllBots } from "../src/bots/config.ts";
import { fetchKnowledgeApi } from "../src/ai/knowledge-api-client.ts";
import { getWikiGardenerWatcher } from "../src/db/watchers.ts";
import {
  getConsumedDocIds,
  getLiveTopicKeys,
  getRejectedTopicKeys,
  getRecentlyRejectedTopicKeys,
} from "../src/db/wiki-proposals.ts";
import { getWikiIndex } from "../src/wiki/store.ts";
import { loadInterestProfile, loadInterestProfileForBot } from "../src/profile/generator.ts";
import { harvestDocs } from "../src/gardener/harvest.ts";
import {
  buildClusterPrompt,
  existingPageLines,
  parseClusters,
  filterClusters,
  gateResolvedClusters,
  summarizeClusterDrops,
} from "../src/gardener/cluster.ts";
import { resolveTarget } from "../src/gardener/target-resolve.ts";
import {
  buildDocPageMapPrompt,
  mappablePages,
  mergeDocPageMappings,
  parseDocPageMap,
} from "../src/gardener/doc-page-map.ts";
import { buildGardenerSeams } from "../src/watchers/wiki-gardener.ts";
import { resolveGardenerConfig, GARDENER_DEFAULTS } from "../src/gardener/types.ts";
import { SUMMARY_SOURCES } from "../src/summaries/sources.ts";
import type { ListedDoc } from "../src/gardener/types.ts";

const showPrompt = process.argv.includes("--show-prompt");

async function main() {
  const config = loadConfig();
  initDb(config); // NB: the Config object, not a URL string (footgun #1).

  const botName = process.env.OWNER_BOT_NAME ?? "jarvis";
  const bot = discoverAllBots().find((b) => b.name.toLowerCase() === botName.toLowerCase());
  if (!bot) {
    console.error(`No discovered bot named "${botName}". Set OWNER_BOT_NAME to a real bot.`);
    process.exit(1);
  }
  if (!bot.wikiDir) {
    console.error(`Bot "${bot.name}" has no wikiDir configured — nothing to cluster against.`);
    process.exit(1);
  }
  const wikiDir = bot.wikiDir;
  const apiUrl = config.knowledgeApiUrl;
  const resolved = resolveGardenerConfig(bot.gardener);
  const collections = SUMMARY_SOURCES.map((s) => s.collection);

  console.log(`Bot:            ${bot.name}`);
  console.log(`Wiki:           ${wikiDir}`);
  console.log(`Knowledge API:  ${apiUrl}`);
  console.log(
    `Window:         lookbackDays=${resolved.lookbackDays}, minClusterSize=${resolved.minClusterSize}, ` +
      `maxProposalsPerRun=${resolved.maxProposalsPerRun}`,
  );
  console.log(`Collections:    ${collections.join(", ")}`);
  console.log();

  // The watcher row gives the run's owner (the identity personalization keys on) —
  // absent ⇒ fall back to the bot-default profile like the manual drain does.
  const watcher = await getWikiGardenerWatcher(bot.name);
  const profileUserId = watcher?.userId;

  const seams = buildGardenerSeams({ botConfig: bot, config, apiUrl, wikiDir });

  // ── Harvest (weekly listDocs endpoint replicated inline — footgun #2) ─────────
  const listDocs = async (collection: string): Promise<ListedDoc[]> => {
    const data = await fetchKnowledgeApi(
      apiUrl,
      `/api/collection/${encodeURIComponent(collection)}/documents?include_dates=1`,
    );
    return Array.isArray(data?.documents) ? data.documents : [];
  };

  const consumed = await getConsumedDocIds(bot.name);
  console.log(`Harvesting (consumed set: ${consumed.size} docs excluded)…`);
  const docs = await harvestDocs(
    collections,
    { listDocs, fetchDoc: seams.fetchDoc },
    { lookbackDays: resolved.lookbackDays, consumed, now: Date.now(), botName: bot.name },
  );
  console.log(`Harvested ${docs.length} doc(s) in the window.`);
  if (docs.length < resolved.minClusterSize) {
    console.log(
      `\nOnly ${docs.length} doc(s) harvested (< minClusterSize ${resolved.minClusterSize}) — ` +
        `the real run would return early WITHOUT a cluster call. Nothing to replay.`,
    );
    return;
  }
  const validDocKeys = new Set(docs.map((d) => d.key));

  // ── Assemble the cluster prompt inputs (mirrors runGardener) ──────────────────
  const [interestProfile, liveKeys, rejectedKeys, recentlyRejectedKeys, index] = await Promise.all([
    profileUserId ? loadInterestProfile(profileUserId, bot.name) : loadInterestProfileForBot(bot.name),
    getLiveTopicKeys(bot.name),
    getRejectedTopicKeys(bot.name),
    getRecentlyRejectedTopicKeys(bot.name, GARDENER_DEFAULTS.rejectedSkipDays),
    getWikiIndex({ root: wikiDir }),
  ]);
  const rejectedHint = [...new Set([...rejectedKeys, ...liveKeys])];
  const existingPages = existingPageLines(index);
  console.log(
    `Prompt inputs:  interestProfile=${interestProfile ? "yes" : "none"}, ` +
      `existingPages=${existingPages.length}, rejectedHint=${rejectedHint.length}, ` +
      `skip(live+recentlyRejected)=${new Set([...liveKeys, ...recentlyRejectedKeys]).size}`,
  );

  const clusterPrompt = buildClusterPrompt(docs, {
    interestProfile,
    rejectedLabels: rejectedHint,
    existingPages,
  });
  if (showPrompt) {
    console.log("\n─── CLUSTER PROMPT ───────────────────────────────────────────");
    console.log(clusterPrompt);
    console.log("──────────────────────────────────────────────────────────────\n");
  }

  // ── One Haiku cluster call ────────────────────────────────────────────────────
  console.log("\nCalling the cluster model (one Haiku call)…");
  const clusterRaw = await seams.callCluster(clusterPrompt);
  const parsed = parseClusters(clusterRaw);
  console.log(`Model proposed ${parsed.length} well-formed cluster(s).`);

  // ── Verdict: filter → resolve → gate (mirrors runGardener) ────────────────────
  const { kept: filtered, dropped: clusterDropped } = filterClusters(parsed, {
    validDocKeys,
    skipTopicKeys: new Set([...liveKeys, ...recentlyRejectedKeys]),
  });
  const resolvedAll = filtered.map((c) => ({ cluster: c, target: resolveTarget(c, index) }));

  // ── Pass-1 doc→page map (mirrors runGardener: after resolve, before the gate) ─
  const candidatePages = mappablePages(index);
  let mapSkipDrops: import("../src/gardener/cluster.ts").ClusterDropEntry[] = [];
  if (candidatePages.length > 0) {
    console.log(`\nCalling the doc→page map model (one Haiku call, ${candidatePages.length} candidate pages)…`);
    const mapRaw = await seams.callDocPageMap(buildDocPageMapPrompt(docs, candidatePages));
    const mappings = parseDocPageMap(mapRaw);
    console.log(`Model proposed ${mappings.length} raw mapping(s).`);
    const needle = process.env.TARGET_DOC ?? "Claude prepares for the END GAME";
    for (const m of mappings) {
      if (m.docId.includes(needle)) console.log(`  → target doc raw-mapped to page: "${m.pageTitle}"`);
    }
    const preLen = resolvedAll.length; // synthesized clusters are appended past here
    const merged = mergeDocPageMappings(resolvedAll, mappings, {
      pages: candidatePages,
      index,
      validDocKeys,
      skipTopicKeys: new Set([...liveKeys, ...recentlyRejectedKeys]),
      botName: bot.name,
    });
    mapSkipDrops = merged.skipDrops;
    const o = merged.outcome;
    console.log(
      `Map outcome:    mapped:${o.mapped} synthesized:${o.synthesized} appended:${o.appended} ` +
        `covered-skipped:${o.coveredSkipped} skip-dropped:${mapSkipDrops.length}`,
    );
    for (const r of resolvedAll.slice(preLen)) {
      console.log(
        `  + SYNTH  ${r.cluster.topicKey} (${r.cluster.kind}, ${r.target.mode}, n:${r.cluster.docIds.length}) — ` +
          `${r.cluster.label} ← ${r.cluster.docIds.join(", ")}`,
      );
    }
  } else {
    console.log("\nNo concept/entity pages in the wiki index — pass-1 map skipped.");
  }

  // Diagnostic-only: MAX_PROPOSALS env overrides the resolved weekly cap (default
  // 3). Lets the replay show what the backlog drain (cap 8) would keep — the weekly
  // cap, not the two-pass mapping, is the binding constraint on a mature wiki.
  const capOverride = process.env.MAX_PROPOSALS ? Number(process.env.MAX_PROPOSALS) : undefined;
  const effectiveCap = capOverride && capOverride > 0 ? capOverride : resolved.maxProposalsPerRun;
  if (effectiveCap !== resolved.maxProposalsPerRun) {
    console.log(`\n(cap override: maxProposalsPerRun ${resolved.maxProposalsPerRun} → ${effectiveCap})`);
  }
  const { kept: gated, dropped: gateDropped } = gateResolvedClusters(resolvedAll, {
    minClusterSize: resolved.minClusterSize,
    maxProposalsPerRun: effectiveCap,
  });
  const dropped = [...clusterDropped, ...mapSkipDrops, ...gateDropped];
  const tally = summarizeClusterDrops(dropped);

  console.log("\n═══ VERDICT ══════════════════════════════════════════════════");
  console.log(`KEPT: ${gated.length}   DROPPED: ${dropped.length}`);
  console.log(
    `  by reason — size:${tally.clusters_dropped_size} skip:${tally.clusters_dropped_skip} ` +
      `hallucinated:${tally.clusters_dropped_hallucinated} duplicate:${tally.clusters_dropped_duplicate} ` +
      `cap:${tally.clusters_dropped_cap}`,
  );
  console.log();

  for (const r of gated) {
    const c = r.cluster;
    console.log(`  ✓ KEPT   ${c.topicKey} (${c.kind}, ${r.target.mode}, n:${c.docIds.length}) — ${c.label}`);
  }
  for (const d of dropped) {
    const strip = d.stripped ? `, strip:${d.stripped}` : "";
    console.log(`  ✗ DROP   ${d.topicKey} (${d.kind}, n:${d.size}${strip}) — reason: ${d.reason}`);
  }
  const kept = gated;

  // ── Acceptance tracker: where did a specific target doc end up? ───────────────
  // Set TARGET_DOC to a substring of the harvested doc key (default: the END GAME
  // acceptance doc). Reports whether it landed in a KEPT update-mode cluster.
  const targetNeedle = process.env.TARGET_DOC ?? "Claude prepares for the END GAME";
  const targetKeys = [...validDocKeys].filter((k) => k.includes(targetNeedle));
  console.log(`\n─── TARGET DOC ("${targetNeedle}") ─────────────────────────────`);
  if (targetKeys.length === 0) {
    console.log("  NOT IN WINDOW — the target doc was not harvested this run (consumed or out of lookback).");
  } else {
    for (const key of targetKeys) {
      const keptHit = gated.find((r) => r.cluster.docIds.includes(key));
      if (keptHit) {
        console.log(
          `  ✓ KEPT   ${key}\n           in cluster "${keptHit.cluster.topicKey}" ` +
            `(${keptHit.cluster.kind}, ${keptHit.target.mode}, n:${keptHit.cluster.docIds.length}) — ${keptHit.cluster.label}`,
        );
      } else {
        const inCluster = resolvedAll.find((r) => r.cluster.docIds.includes(key));
        if (!inCluster) {
          console.log(`  ✗ UNCLUSTERED  ${key} — neither pass-0 nor pass-1 placed it in a cluster.`);
        } else {
          const drop = dropped.find((d) => d.topicKey === inCluster.cluster.topicKey);
          console.log(
            `  ✗ DROPPED  ${key}\n           was in cluster "${inCluster.cluster.topicKey}" ` +
              `(${inCluster.target.mode}) but that cluster was dropped${drop ? ` — reason: ${drop.reason}` : ""}.`,
          );
        }
      }
    }
  }

  if (kept.length === 0) {
    console.log(
      "\n0 clusters kept — the tally above is exactly what the trace's `cluster` span " +
        "and the per-run log line now carry, so a zero-cluster run is self-explanatory.",
    );
  }
}

main()
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  })
  .finally(() => closeDb());
