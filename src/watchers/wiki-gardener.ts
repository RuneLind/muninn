/**
 * Wiki-gardener watcher checker.
 *
 * `runChecker` (runner.ts) passes only `(watcher, cwd, botName)`, so this checker
 * resolves the bot's `Config`/`BotConfig` via discovery (like the anthropic
 * summarizer's auto-promote path) and reads the knowledge-API URL from env (like
 * x.ts). It wires the real seams and delegates to `runGardener`.
 *
 * PR 1: proposals accumulate in Postgres and a Telegram alert announces them —
 * no wiki writes, no review UI (those land in PR 2).
 */

import type { Watcher, WatcherAlert } from "../types.ts";
import { discoverAllBots } from "../bots/config.ts";
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
import { runGardener } from "../gardener/runner.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "wiki-gardener");

const DEFAULT_API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";
const DRAFT_TIMEOUT_MS = 180_000;
const DOC_FETCH_TIMEOUT_MS = 15_000;

export async function checkWikiGardener(
  watcher: Watcher,
  _cwd?: string,
  botName?: string,
): Promise<WatcherAlert[]> {
  const name = botName ?? watcher.botName;
  const botConfig = discoverAllBots().find((b) => b.name === name);
  if (!botConfig) {
    log.warn("Wiki-gardener: bot \"{name}\" not discovered — skipping", { botName: name, name });
    return [];
  }
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

  try {
    const alerts = await runGardener({
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
      fetchDoc: async (collection, id) => {
        return await fetchKnowledgeApi(
          apiUrl,
          `/api/document/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
          { timeoutMs: DOC_FETCH_TIMEOUT_MS },
        );
      },

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
        const { result } = await executeOneShot(prompt, config, botConfig, { timeoutMs });
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
      consumedDocIds: () => getConsumedDocIds(name),
      insertProposal: (params) => insertWikiProposal(params),
    });

    tracer.finish("ok", { alertsSent: alerts.length });
    return alerts;
  } catch (err) {
    tracer.error(err instanceof Error ? err : String(err));
    throw err;
  }
}
