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
>;

export interface GardenerSeamContext {
  botConfig: BotConfig;
  config: Config;
  apiUrl: string;
  wikiDir: string;
}

export function buildGardenerSeams(ctx: GardenerSeamContext): SharedGardenerSeams {
  const { botConfig, config, apiUrl, wikiDir } = ctx;
  const name = botConfig.name;
  return {
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
