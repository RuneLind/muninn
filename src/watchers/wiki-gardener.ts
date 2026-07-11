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
import { loadInterestProfileForBot } from "../profile/generator.ts";
import { getWikiIndex } from "../wiki/store.ts";
import { SUMMARY_SOURCES } from "../summaries/sources.ts";
import { Tracer } from "../tracing/index.ts";
import {
  getConsumedDocIds,
  getLiveTopicKeys,
  getRejectedTopicKeys,
  insertWikiProposal,
} from "../db/wiki-proposals.ts";
import { resolveGardenerConfig } from "../gardener/types.ts";
import { runGardener, type GardenerDeps } from "../gardener/runner.ts";
import { DRAFT_TIMEOUT_MS, runExclusive } from "../gardener/backlog.ts";
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
  | "loadInterestProfile"
  | "getWikiIndex"
  | "callDraft"
  | "readWikiFile"
  | "liveTopicKeys"
  | "rejectedTopicKeys"
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

export interface GardenerSeamContext {
  botConfig: BotConfig;
  config: Config;
  apiUrl: string;
  wikiDir: string;
}

export function buildGardenerSeams(ctx: GardenerSeamContext): SharedGardenerSeams {
  const { botConfig, config, apiUrl, wikiDir } = ctx;
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
      });
      return result;
    },
    loadInterestProfile: () => loadInterestProfileForBot(name),
    getWikiIndex: () => getWikiIndex({ root: wikiDir }),
    callDraft: async (prompt, timeoutMs) => {
      // Drafting is mechanical synthesis — don't inherit the bot's chat-tuned
      // thinking budget (jarvis: 40k), which makes one-shots slow and variable.
      const draftBotConfig = { ...botConfig, thinkingMaxTokens: DRAFT_THINKING_MAX_TOKENS };
      const { result } = await executeOneShot(prompt, config, draftBotConfig, { timeoutMs });
      return result;
    },
    readWikiFile: async (absPath) => {
      try {
        return await Bun.file(absPath).text();
      } catch {
        return null;
      }
    },
    liveTopicKeys: () => getLiveTopicKeys(name),
    rejectedTopicKeys: () => getRejectedTopicKeys(name),
    insertProposal: (params) => insertWikiProposal(params),
  };

  // Omit the seam entirely when the bot has no backing collections — an absent
  // seam means no possibly-related block, never an unscoped (all-corpora) search.
  if (collections.length > 0) {
    seams.searchRelated = (query) => searchRelatedPages(apiUrl, collections, query);
  }
  return seams;
}

export async function checkWikiGardener(
  watcher: Watcher,
  botConfig: BotConfig,
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

  const tracer = new Tracer("wiki-gardener", { botName: name, userId: watcher.userId });

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

      listDocs: async (collection) => {
        const data = await fetchKnowledgeApi(
          apiUrl,
          `/api/collection/${encodeURIComponent(collection)}/documents?include_dates=1`,
        );
        return Array.isArray(data?.documents) ? data.documents : [];
      },
      consumedDocIds: () => getConsumedDocIds(name),
      ...buildGardenerSeams({ botConfig, config, apiUrl, wikiDir }),
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
    tracer.finish("ok", { skippedForBacklogRun: true });
    return [];
  }

  try {
    const alerts = await run;
    tracer.finish("ok", { alertsSent: alerts.length });
    return alerts;
  } catch (err) {
    tracer.error(err instanceof Error ? err : String(err));
    throw err;
  }
}
