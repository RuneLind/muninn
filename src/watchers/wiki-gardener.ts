/**
 * Wiki-gardener watcher checker.
 *
 * `runChecker` (runner.ts) passes the bot's full `BotConfig` through, so this
 * checker only resolves the muninn `Config` (for `executeOneShot`) and reads the
 * knowledge-API URL from env (like x.ts). It wires the real seams and delegates
 * to `runGardener`.
 *
 * PR 1: proposals accumulate in Postgres and a Telegram alert announces them —
 * no wiki writes, no review UI (those land in PR 2).
 */

import type { Watcher, WatcherAlert } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";
import { loadConfig } from "../config.ts";
import { fetchKnowledgeApi } from "../ai/knowledge-api-client.ts";
import { callHaikuWithFallback } from "../ai/haiku-direct.ts";
import { executeOneShot } from "../ai/one-shot.ts";
import { trackUsage, type HaikuTelemetry } from "../scheduler/executor.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import { loadInterestProfile, loadInterestProfileForBot } from "../profile/generator.ts";
import { getWikiIndex } from "../wiki/store.ts";
import { SUMMARY_SOURCES } from "../summaries/sources.ts";
import type { Tracer } from "../tracing/index.ts";
import {
  getConsumedDocIds,
  getLiveTopicKeys,
  getRejectedTopicKeys,
  getRecentlyRejectedTopicKeys,
  insertWikiProposal,
} from "../db/wiki-proposals.ts";
import { resolveGardenerConfig, GARDENER_DEFAULTS } from "../gardener/types.ts";
import { runGardener, type GardenerDeps } from "../gardener/runner.ts";
import {
  DRAFT_TIMEOUT_MS,
  runExclusive,
  WIKI_GARDENER_WEEKLY_RUN_KEY,
  type WeeklyGardenerRun,
} from "../gardener/backlog.ts";
import type { ClusterDropEntry, ClusterDropTally } from "../gardener/cluster.ts";
import { setWatcherSnapshot } from "../db/watchers.ts";
import type { Config } from "../config.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "wiki-gardener");

const DEFAULT_API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";
const DRAFT_THINKING_MAX_TOKENS = 8_000;
const DOC_FETCH_TIMEOUT_MS = 15_000;

/** The seams shared by the weekly checker and the manual backlog run — the
 *  gardener wiring that both paths must keep identical (fetch, cluster, draft,
 *  wiki index, DB reads, proposal insert). Only harvest's `listDocs`/`consumed`
 *  and the run-shape numbers differ between the two callers. */
export type SharedGardenerSeams = Pick<
  GardenerDeps,
  | "fetchDoc"
  | "callCluster"
  | "callDocPageMap"
  | "loadInterestProfile"
  | "getWikiIndex"
  | "callDraft"
  | "readWikiFile"
  | "liveTopicKeys"
  | "rejectedTopicKeys"
  | "recentlyRejectedTopicKeys"
  | "insertProposal"
  // Optional content-dedup seam — threaded through here so both the weekly
  // checker and the backlog drain wire it identically. Without this member the
  // optional seam would silently never reach `runGardener` and the feature would
  // no-op. `buildGardenerSeams` omits it when the bot has no `wikiCollections`.
  | "searchRelated"
>;

const RELATED_SEARCH_TIMEOUT_MS = 8_000;
/** Max possibly-related pages inlined per draft (merged across collections). */
const RELATED_SEARCH_TOP_N = 3;

/**
 * Content-dedup search seam: one huginn `/api/search` per backing collection
 * (brief mode, corrective off), merged by descending relevance and capped to the
 * top N overall. Per-collection failures degrade silently (warn + skip that
 * collection); an all-failed search returns [] ⇒ no block. jarvis has TWO
 * collections (`wiki`, `wiki-life`) — searching only one would miss siblings.
 */
async function searchRelatedPages(
  apiUrl: string,
  collections: string[],
  query: string,
): Promise<{ title: string; snippet: string }[]> {
  const merged: { title: string; snippet: string; relevance: number }[] = [];
  await Promise.all(
    collections.map(async (collection) => {
      try {
        const params = new URLSearchParams({
          q: query,
          collection,
          brief: "1",
          corrective: "off",
        });
        const data = await fetchKnowledgeApi(apiUrl, `/api/search?${params}`, {
          timeoutMs: RELATED_SEARCH_TIMEOUT_MS,
        });
        for (const r of (data?.results ?? []) as any[]) {
          if (!r?.title) continue;
          merged.push({
            title: String(r.title).replace(/\.md$/i, ""),
            snippet: typeof r.snippet === "string" ? r.snippet : "",
            relevance: typeof r.relevance === "number" ? r.relevance : 0,
          });
        }
      } catch (err) {
        log.warn("Wiki-gardener related-search failed for collection {collection}: {error}", {
          collection,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
  merged.sort((a, b) => b.relevance - a.relevance);
  const seen = new Set<string>();
  const out: { title: string; snippet: string }[] = [];
  for (const r of merged) {
    const key = r.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: r.title, snippet: r.snippet });
    if (out.length >= RELATED_SEARCH_TOP_N) break;
  }
  return out;
}

/**
 * Stamp a `claude` child span under the gardener's "draft" stage span carrying
 * the draft one-shot's model + tokens — the dominant gardener cost, otherwise
 * left with only a coarse stage-duration span. For `/traces` legibility only.
 *
 * CHILD SPAN ONLY (HARD INVARIANT): the tokens must NEVER be stamped onto the
 * parent `watcher:wiki-gardener` span's OWN attributes. `/agents` Recent already
 * surfaces the gardener's tokens via the `wiki_gardener_draft` extractor row
 * (`getRecentExtractorUsage` allow-list), and the documented rule is "never both"
 * — a token-bearing watcher span would double-count against that row. Attaching
 * under the "draft" stage span (not the root) also keeps `getRecentAgentTraces`'
 * root-child `claude` join from ever reading these tokens onto the watcher row.
 *
 * No-op when `tracer` is undefined (tracing off, or the checker invoked outside
 * the runner) — every call is null-guarded.
 *
 * Ordering caveat: `addChildSpan("draft", …)` resolves the parent by label and
 * falls back to the ROOT span when no "draft" span is open — so this must only
 * be called while `runGardener`'s draft stage span is live. Moving the call
 * outside that window would silently attach under the watcher root and leak
 * `model` into the Recent row's model column.
 */
export function stampDraftClaudeSpan(
  tracer: Tracer | undefined,
  exec: Pick<ClaudeExecResult, "model" | "inputTokens" | "outputTokens">,
  durationMs: number,
  connector?: string,
): void {
  tracer?.addChildSpan("draft", "claude", durationMs, {
    model: exec.model,
    inputTokens: exec.inputTokens,
    outputTokens: exec.outputTokens,
    // Stopgap connector stamp — the draft runs the bot's connector via
    // executeOneShot. This span is a CHILD of the "draft" stage span (never a
    // direct root child), so getRecentTraces' `c`/`w` joins skip it and the walk
    // aggregate reads it — un-blanking the gardener draft's connector on /traces.
    ...(connector ? { connector } : {}),
  });
}

export interface GardenerSeamContext {
  botConfig: BotConfig;
  config: Config;
  apiUrl: string;
  wikiDir: string;
  /**
   * The identity the run personalizes against — the weekly checker passes
   * `watcher.userId` (the watcher's owner), the manual dashboard drain passes
   * nothing (no watcher in scope) and falls back to `loadInterestProfileForBot`.
   * PR2: keeps one user's interests out of another's alerts on a multi-user bot.
   */
  profileUserId?: string;
  /**
   * The run's tracer (the runner's `watcher:wiki-gardener` span for the weekly
   * checker, or the drain's own root). Threaded into the Haiku cluster call (so
   * its `wiki_gardener_cluster` `haiku_usage` row joins the trace via `trace_id`)
   * and the draft seam (so each draft stamps a `claude` child span + a joined
   * `wiki_gardener_draft` row). Optional — absent ⇒ every tracer call is a no-op.
   */
  tracer?: Tracer;
}

export function buildGardenerSeams(ctx: GardenerSeamContext): SharedGardenerSeams {
  const { botConfig, config, apiUrl, wikiDir, profileUserId, tracer } = ctx;
  const name = botConfig.name;
  const collections = (botConfig.wikiCollections ?? []).filter((c) => c && c.trim());
  const seams: SharedGardenerSeams = {
    fetchDoc: async (collection, id) =>
      fetchKnowledgeApi(
        apiUrl,
        `/api/document/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
        { timeoutMs: DOC_FETCH_TIMEOUT_MS },
      ),
    callCluster: async (prompt) => {
      const { result } = await callHaikuWithFallback(prompt, {
        source: "wiki_gardener_cluster",
        entrypoint: `${name}-watcher`,
        botName: name,
        connector: botConfig.connector,
        haikuBackend: botConfig.haikuBackend,
        // Thread the run's tracer so the cluster's `wiki_gardener_cluster`
        // haiku_usage row ties back to the trace (trackUsage stamps
        // `tracer.traceId`; NULL without it) — the #267 join, now for the
        // gardener cluster/triage rows too.
        tracer,
      });
      return result;
    },
    callDocPageMap: async (prompt) => {
      // Pass-1 doc→page map — same backend + thinking conventions as `callCluster`
      // (a cheap Haiku call). Its `wiki_gardener_map` haiku_usage row joins the
      // trace via the threaded tracer, exactly like the cluster row.
      const { result } = await callHaikuWithFallback(prompt, {
        source: "wiki_gardener_map",
        entrypoint: `${name}-watcher`,
        botName: name,
        connector: botConfig.connector,
        haikuBackend: botConfig.haikuBackend,
        tracer,
      });
      return result;
    },
    loadInterestProfile: () =>
      profileUserId ? loadInterestProfile(profileUserId, name) : loadInterestProfileForBot(name),
    getWikiIndex: () => getWikiIndex({ root: wikiDir }),
    callDraft: async (prompt, timeoutMs) => {
      // Drafting is mechanical synthesis — don't inherit the bot's chat-tuned
      // thinking budget (jarvis: 40k), which makes one-shots slow and variable.
      const draftBotConfig = { ...botConfig, thinkingMaxTokens: DRAFT_THINKING_MAX_TOKENS };
      const startedAt = performance.now();
      const exec = await executeOneShot(prompt, config, draftBotConfig, { timeoutMs });
      const durationMs = performance.now() - startedAt;
      // executeOneShot / one-shot.ts never calls trackUsage (many callers —
      // summarizers/research — where blanket usage rows would be scope creep), so
      // the draft's tokens exist nowhere unless captured here. Write a
      // `wiki_gardener_draft` row (allow-listed in getRecentExtractorUsage) so the
      // gardener's dominant token cost surfaces on /agents Recent. Best-effort.
      // `tracer.traceId` joins the row back to the trace (#267; NULL without it).
      trackUsage("wiki_gardener_draft", exec.model, exec.inputTokens, exec.outputTokens, name, tracer?.traceId);
      // …and a `claude` child span under the "draft" stage span so /traces shows
      // the dominant per-draft cost. CHILD SPAN ONLY — see stampDraftClaudeSpan
      // (never stamps tokens on the watcher span's own attrs → no double-count).
      stampDraftClaudeSpan(tracer, exec, durationMs, botConfig.connector ?? "claude-cli");
      return exec.result;
    },
    readWikiFile: async (absPath) => {
      try {
        return await Bun.file(absPath).text();
      } catch {
        return null;
      }
    },
    liveTopicKeys: () => getLiveTopicKeys(name),
    // Hint sees ALL rejections; skip set is TTL'd on resolved_at.
    rejectedTopicKeys: () => getRejectedTopicKeys(name),
    recentlyRejectedTopicKeys: () =>
      getRecentlyRejectedTopicKeys(name, GARDENER_DEFAULTS.rejectedSkipDays),
    insertProposal: (params) => insertWikiProposal(params),
  };

  // Omit the seam entirely when the bot has no backing collections — an absent
  // seam means no possibly-related block, never an unscoped (all-corpora) search.
  if (collections.length > 0) {
    seams.searchRelated = (query) => searchRelatedPages(apiUrl, collections, query);
  }
  return seams;
}

/**
 * Build the durable weekly-run snapshot from the aggregate drop tally the runner's
 * `onTally` hook emits. Pure + exported so the shape (and the `clustersFound === kept
 * + dropped` invariant) is unit-testable without a DB. The evicted-topic list is the
 * LOSSLESS structured tail — mapped straight off the raw `dropped` entries, never the
 * tally's trace-truncated `clusters_dropped_topics` string.
 */
export function buildWeeklyGardenerRun(
  dropTally: ClusterDropTally,
  keptClusters: number,
  dropped: ClusterDropEntry[],
  now: number = Date.now(),
): WeeklyGardenerRun {
  return {
    finishedAt: now,
    clustersFound: keptClusters + dropTally.clusters_dropped,
    kept: keptClusters,
    dropped: dropTally.clusters_dropped,
    dropTally,
    evictedTopics: dropped.map((d) => ({ topicKey: d.topicKey, reason: d.reason, size: d.size })),
  };
}

export async function checkWikiGardener(
  watcher: Watcher,
  botConfig: BotConfig,
  telemetry?: HaikuTelemetry,
): Promise<WatcherAlert[]> {
  const name = botConfig.name;
  if (!botConfig.wikiDir) {
    log.warn("Wiki-gardener: bot \"{name}\" has no wikiDir configured — skipping", {
      botName: name,
      name,
    });
    return [];
  }
  if (botConfig.gardener?.enabled === false) {
    log.info("Wiki-gardener: disabled via config for \"{name}\" — skipping", { botName: name, name });
    return [];
  }

  const config = loadConfig();
  const resolved = resolveGardenerConfig(botConfig.gardener);
  const apiUrl = DEFAULT_API_URL;
  const wikiDir = botConfig.wikiDir;

  // Reuse the runner's `watcher:wiki-gardener` span (already opened as a child of
  // `scheduler_tick`) as the gardener's tracer, instead of minting a second,
  // disconnected `wiki-gardener` root. Stage spans + the per-draft `claude` child
  // span then attach directly under it, so one logical run is ONE connected trace.
  // The runner OWNS this tracer's lifecycle (it calls finish/error), so we never
  // finish it here. Absent when tracing is off, or the checker is invoked outside
  // the runner — every tracer use is null-guarded.
  const tracer = telemetry?.tracer;

  // Captured from the runner's `onTally` hook (fires once after clustering, before
  // the draft loop) — persisted below as the durable weekly-run snapshot so the
  // review-gate strip can render "N found, K kept, D dropped" (the cap-eviction the
  // page showed nothing about). Undefined when the run early-returns at the harvest
  // floor (never clustered) or is skipped for an in-flight drain.
  let weeklyTally: { dropTally: ClusterDropTally; kept: number; dropped: ClusterDropEntry[] } | undefined;

  // Acquire the per-bot gardener mutex — if a manual backlog run is draining the
  // same wiki, skip this weekly fire (the in-flight batch covers the newest docs).
  // The runner still advances last_run_at, so that week's organic run is skipped.
  const run = runExclusive(name, () =>
    runGardener({
      botName: name,
      wikiDir,
      collections: SUMMARY_SOURCES.map((s) => s.collection),
      minClusterSize: resolved.minClusterSize,
      lookbackDays: resolved.lookbackDays,
      maxProposalsPerRun: resolved.maxProposalsPerRun,
      draftTimeoutMs: DRAFT_TIMEOUT_MS,
      now: () => Date.now(),
      tracer,
      onTally: (dropTally, kept, dropped) => {
        weeklyTally = { dropTally, kept, dropped };
      },

      listDocs: async (collection) => {
        const data = await fetchKnowledgeApi(
          apiUrl,
          `/api/collection/${encodeURIComponent(collection)}/documents?include_dates=1`,
        );
        return Array.isArray(data?.documents) ? data.documents : [];
      },
      // Concept/entity only: a doc that only ever became an `applied` SOURCE page
      // stays eligible for concept/entity synthesis (source + concept pages about
      // the same video are complementary). The backlog-crediting path keeps the
      // unfiltered set, so a source-paged doc still counts as ingested there.
      consumedDocIds: () => getConsumedDocIds(name, ["concept", "entity"]),
      ...buildGardenerSeams({ botConfig, config, apiUrl, wikiDir, profileUserId: watcher.userId, tracer }),
    }),
  );

  if (run === null) {
    // KNOWN/ACCEPTED: this also swallows a manual force-trigger that collides
    // with an in-flight backlog drain — the runner treats the returned [] as a
    // completed run, advances last_run_at, and clears force_next_run. Accepted
    // because the in-flight drain already covers the newest docs, and queueing
    // or erroring here would complicate the runner for a rare manual collision.
    log.info("Wiki-gardener: a backlog run is in flight for \"{name}\" — skipping this weekly run", {
      botName: name,
      name,
    });
    // Mark the skip as a point-in-time event on the runner's span (which the
    // runner finishes with its own alertsFound=0 attrs). Don't finish the tracer
    // here — the runner owns it.
    tracer?.event("skipped_for_backlog_run");
    return [];
  }

  // Errors propagate to the runner, whose catch calls `wt.error(...)` on this same
  // span — no local finish/error, so the run stays a single connected trace. The
  // `finally` persists the weekly-run snapshot on BOTH the success and the
  // throw-after-clustering paths (the tally fires before the draft loop, so its
  // cluster counts are honest even if a later draft throws); best-effort so a
  // snapshot write never masks the run's own error or breaks the checker.
  try {
    return await run;
  } finally {
    if (weeklyTally) {
      try {
        await setWatcherSnapshot(
          watcher.id,
          WIKI_GARDENER_WEEKLY_RUN_KEY,
          buildWeeklyGardenerRun(weeklyTally.dropTally, weeklyTally.kept, weeklyTally.dropped),
        );
      } catch (err) {
        log.warn("Wiki-gardener: persisting weekly-run snapshot failed for \"{name}\": {error}", {
          botName: name,
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
