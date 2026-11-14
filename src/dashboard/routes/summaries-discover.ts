/**
 * ▶ Find on YouTube for `/summaries` (plan muninn-youtube-discovery, PR 1).
 *
 * `POST /api/summaries/discover` `{source: "youtube", docId}` — one Haiku-tier
 * call turns the stored summary into 3–5 queries, each runs one yt-dlp search
 * (10 results, concurrently), the union drops the seed and every video
 * `youtube-summaries` already holds, and a second Haiku-tier call (the YouTube
 * gate) ranks the rest; the top {@link DISCOVER_MAX_SHOWN} by score come back.
 * Writes nothing and captures nothing (D2): the panel's Summarize is a click on
 * the existing `POST /api/youtube/summarize`.
 *
 * `application/json` required (415). Errors are `{error, code}`. Pure half and
 * the search: `src/youtube/discover.ts`.
 */

import type { Context, Hono } from "hono";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { fetchKnowledgeApi, fetchKnowledgeApiText, KnowledgeApiError } from "../../ai/knowledge-api-client.ts";
import { callHaikuWithFallback } from "../../ai/haiku-direct.ts";
import { Tracer } from "../../tracing/tracer.ts";
import { encodeDocIdPath, getSummarySource, isSafeDocId } from "../../summaries/sources.ts";
import { readStoredCapture, titleFromDocId } from "../../summaries/summary-save.ts";
import { stripSummaryFactcheckBlock } from "../../summaries/factcheck-block.ts";
import { readerSimilarQuery } from "../../summaries/reader-article.ts";
import { extractYouTubeVideoId } from "../../youtube/url.ts";
import {
  buildDiscoverQueriesPrompt,
  buildDiscoverRankPrompt,
  DISCOVER_MAX_SHOWN,
  DISCOVER_MIN_SCORE,
  DISCOVER_RESULTS_PER_QUERY,
  parseDiscoverQueries,
  searchYouTube,
  type DiscoverQuery,
  type YouTubeHit,
} from "../../youtube/discover.ts";
import { indexScoresByN, parseGateScores } from "../../watchers/gate-scores.ts";
import { withInterestProfile } from "../../profile/inject.ts";
import { loadInterestProfileForBot } from "../../profile/generator.ts";
import { authMode } from "../../auth/policy.ts";
import { requireJsonRequest } from "./json-request.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "summaries-discover");

const RAW_READ_TIMEOUT_MS = 10_000;
const MODEL_TIMEOUT_MS = 60_000;
/** How long the known-video set is reused (the Stats tab's TTL). */
export const KNOWN_IDS_TTL_MS = 5 * 60_000;
const YOUTUBE_COLLECTION = "youtube-summaries";

export type DiscoverTracer = Pick<Tracer, "start" | "end" | "finish">;

export interface SummariesDiscoverDeps {
  /** The raw file, or `null` when huginn has no such document. Throws on any other failure. */
  readRaw: (collection: string, docId: string) => Promise<string | null>;
  bots: () => BotConfig[];
  queriesCall: (prompt: string, bot: BotConfig, tracer: DiscoverTracer | null) => Promise<string>;
  rankCall: (prompt: string, bot: BotConfig, tracer: DiscoverTracer | null) => Promise<string>;
  /** One search: hits, or `null` when it failed. */
  search: (query: string, n: number) => Promise<YouTubeHit[] | null>;
  /** Every `url` the `youtube-summaries` listing carries. Throws on failure. */
  listKnownUrls: () => Promise<string[]>;
  /** The interest profile to rank with, or `null`. */
  profile: (bot: BotConfig) => Promise<string | null>;
  tracer?: (bot: BotConfig) => DiscoverTracer | null;
  now?: () => number;
}

/**
 * Test seam for `e2e/youtube-discover-boot.ts` ONLY: the two model calls and
 * the search, replaced in-process before muninn boots (the `findLinksTestSeam`
 * precedent). Production never sets it.
 */
export const discoverTestSeam: Partial<Pick<SummariesDiscoverDeps, "queriesCall" | "rankCall" | "search">> = {};

async function haiku(prompt: string, bot: BotConfig, tracer: DiscoverTracer | null, source: string): Promise<string> {
  const res = await callHaikuWithFallback(prompt, {
    source,
    entrypoint: "youtube-discover",
    botName: bot.name,
    connector: bot.connector,
    haikuBackend: bot.haikuBackend,
    timeoutMs: MODEL_TIMEOUT_MS,
    ...(tracer ? { tracer: tracer as Tracer } : {}),
  });
  return res.result;
}

export function defaultSummariesDiscoverDeps(
  config: Config,
  opts: { loadProfile?: typeof loadInterestProfileForBot } = {},
): SummariesDiscoverDeps {
  const loadProfile = opts.loadProfile ?? loadInterestProfileForBot;
  return {
    readRaw: async (collection, docId) => {
      try {
        return await fetchKnowledgeApiText(
          config.knowledgeApiUrl,
          `/api/document/${encodeURIComponent(collection)}/${encodeDocIdPath(docId)}?raw=1`,
          { timeoutMs: RAW_READ_TIMEOUT_MS },
        );
      } catch (err) {
        if (err instanceof KnowledgeApiError && err.upstreamStatus === 404) return null;
        throw err;
      }
    },
    bots: discoverAllBots,
    queriesCall: (prompt, bot, tracer) =>
      discoverTestSeam.queriesCall ? discoverTestSeam.queriesCall(prompt, bot, tracer) : haiku(prompt, bot, tracer, "youtube-discover-queries"),
    rankCall: (prompt, bot, tracer) =>
      discoverTestSeam.rankCall ? discoverTestSeam.rankCall(prompt, bot, tracer) : haiku(prompt, bot, tracer, "youtube-discover-rank"),
    search: (query, n) => (discoverTestSeam.search ? discoverTestSeam.search(query, n) : searchYouTube(query, n)),
    listKnownUrls: async () => {
      const data = await fetchKnowledgeApi(config.knowledgeApiUrl, `/api/collection/${YOUTUBE_COLLECTION}/documents`, {
        timeoutMs: 10_000,
      });
      const docs = (data?.documents ?? []) as { url?: unknown }[];
      return docs.map((d) => (typeof d.url === "string" ? d.url : "")).filter(Boolean);
    },
    // An authenticating instance has many readers: a bot-wide profile is someone else's interests.
    profile: async (bot) => (authMode() === "off" ? loadProfile(bot.name) : null),
    tracer: (bot) => new Tracer("youtube-discover", { botName: bot.name, platform: "youtube-discover" }),
  };
}

export interface DiscoverResult {
  videoId: string;
  title: string;
  channel: string | null;
  durationSec: number | null;
  viewCount: number | null;
  url: string;
  score: number;
  why: string;
  /** The first query that found it. */
  query: string;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const fail = (c: Context, status: 400 | 404 | 409 | 502 | 503, code: string, error: string) => c.json({ error, code }, status);

export function registerSummariesDiscoverRoutes(
  app: Hono,
  config: Config,
  deps: SummariesDiscoverDeps = defaultSummariesDiscoverDeps(config),
): void {
  const now = deps.now ?? Date.now;
  /** One discovery per document at a time. */
  const running = new Set<string>();
  let known: { ids: Set<string>; at: number } | null = null;
  let knownInFlight: Promise<Set<string>> | null = null;

  /** The video ids `youtube-summaries` holds, cached and single-flighted. A failed listing is not cached. */
  function knownIds(): Promise<Set<string>> {
    if (known && now() - known.at < KNOWN_IDS_TTL_MS) return Promise.resolve(known.ids);
    knownInFlight ??= (async () => {
      try {
        const ids = new Set<string>();
        for (const url of await deps.listKnownUrls()) {
          const id = extractYouTubeVideoId(url);
          if (id) ids.add(id);
        }
        known = { ids, at: now() };
        return ids;
      } finally {
        knownInFlight = null;
      }
    })();
    return knownInFlight;
  }

  app.post("/api/summaries/discover", async (c) => {
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    const parsed: unknown = await c.req.json().catch(() => null);
    const body = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
    const sourceId = typeof body.source === "string" ? body.source.trim() : "";
    const docId = typeof body.docId === "string" ? body.docId.trim() : "";
    const source = getSummarySource(sourceId);
    if (!source) return fail(c, 400, "bad_source", `unknown summary source "${sourceId}"`);
    if (sourceId !== "youtube") return fail(c, 400, "not_youtube", "Find on YouTube works on YouTube summaries only.");
    if (!docId || !isSafeDocId(docId)) return fail(c, 400, "bad_doc_id", "docId is not a document path");
    const bot = resolveSummarizerBot(deps.bots());
    if (!bot) return fail(c, 503, "no_bot", "No bots are configured to run the search.");

    const key = docId;
    if (running.has(key)) return fail(c, 409, "running", "A search from this summary is already running.");
    running.add(key);
    const tracer = deps.tracer?.(bot) ?? null;
    try {
      let raw: string | null;
      try {
        raw = await deps.readRaw(source.collection, docId);
      } catch (err) {
        log.warn("Find on YouTube: raw read failed for {doc}: {error}", { doc: docId, error: errText(err) });
        tracer?.finish("error", { error: "read failed" });
        return fail(c, 502, "upstream", "Could not read the stored document.");
      }
      if (raw === null) {
        tracer?.finish("error", { error: "not found" });
        return fail(c, 404, "not_found", "No such document.");
      }
      const stored = readStoredCapture(raw);
      const title = titleFromDocId(docId);
      const seedId = extractYouTubeVideoId(stored.frontmatter.url ?? "");
      const opening = readerSimilarQuery(stripSummaryFactcheckBlock(stored.body));

      // 1. Queries.
      let queries: DiscoverQuery[] | null;
      tracer?.start("queries", { doc: docId });
      try {
        const answer = await deps.queriesCall(buildDiscoverQueriesPrompt(title, opening), bot, tracer);
        queries = parseDiscoverQueries(answer);
        tracer?.end("queries", { queries: queries?.length ?? 0 });
      } catch (err) {
        tracer?.end("queries", { error: errText(err) }, "error");
        tracer?.finish("error");
        log.warn("Find on YouTube: queries call failed for {doc}: {error}", { doc: docId, error: errText(err) });
        return fail(c, 502, "model_failed", "The call that writes the search queries failed. Try again.");
      }
      if (!queries || queries.length === 0) {
        tracer?.finish("error", { error: "no queries" });
        return fail(c, 502, "model_unparseable", "The model answered no usable search queries. Try again.");
      }

      // 2. Searches, concurrently; union by id in query order.
      tracer?.start("search", { queries: queries.length });
      const answers = await Promise.all(queries.map((q) => deps.search(q.query, DISCOVER_RESULTS_PER_QUERY).catch(() => null)));
      const failed = answers.filter((a) => a === null).length;
      tracer?.end("search", { failed }, failed === answers.length ? "error" : "ok");
      if (failed === answers.length) {
        tracer?.finish("error", { error: "every search failed" });
        return fail(c, 503, "search_failed", "Every YouTube search failed. Is yt-dlp installed and up to date?");
      }
      const union = new Map<string, { hit: YouTubeHit; query: string }>();
      answers.forEach((hits, i) => {
        for (const hit of hits ?? []) if (!union.has(hit.videoId)) union.set(hit.videoId, { hit, query: queries[i]!.query });
      });

      // 3. Drop the seed and everything already captured.
      let knownSet: Set<string>;
      try {
        knownSet = await knownIds();
      } catch (err) {
        // Degrade: a result may be a video already captured, and the Summarize answer says `duplicate`.
        log.warn("Find on YouTube: known-video listing failed: {error}", { error: errText(err) });
        knownSet = new Set();
      }
      const fresh = [...union.values()].filter(({ hit }) => hit.videoId !== seedId && !knownSet.has(hit.videoId));
      const searched = union.size;
      const knownDropped = searched - fresh.length;
      if (fresh.length === 0) {
        tracer?.finish("ok", { searched, known: knownDropped, shown: 0 });
        return c.json({ queries, results: [], searched, known: knownDropped });
      }

      // 4. Rank (the YouTube gate), profile last.
      const profile = await deps.profile(bot).catch(() => null);
      const prompt = withInterestProfile(buildDiscoverRankPrompt(title, fresh.map((f) => f.hit)), profile);
      let scores: ReturnType<typeof indexScoresByN>;
      tracer?.start("rank", { candidates: fresh.length, profile: profile ? "yes" : "no" });
      try {
        const answer = await deps.rankCall(prompt, bot, tracer);
        try {
          scores = indexScoresByN(parseGateScores(answer), fresh.length);
        } catch {
          tracer?.end("rank", { error: "unparseable" }, "error");
          tracer?.finish("error");
          return fail(c, 502, "model_unparseable", "The ranking call answered no list. Try again.");
        }
        tracer?.end("rank", { scored: scores.size });
      } catch (err) {
        tracer?.end("rank", { error: errText(err) }, "error");
        tracer?.finish("error");
        log.warn("Find on YouTube: rank call failed for {doc}: {error}", { doc: docId, error: errText(err) });
        return fail(c, 502, "model_failed", "The ranking call failed. Try again.");
      }
      const results: DiscoverResult[] = fresh
        .map((f, i) => ({ f, s: scores.get(i + 1), i }))
        .filter(
          (x): x is { f: (typeof fresh)[number]; s: NonNullable<typeof x.s>; i: number } =>
            x.s !== undefined && x.s.score >= DISCOVER_MIN_SCORE,
        )
        .sort((a, b) => b.s.score - a.s.score || a.i - b.i)
        .slice(0, DISCOVER_MAX_SHOWN)
        .map(({ f, s }) => ({ ...f.hit, score: s.score, why: s.why, query: f.query }));
      tracer?.finish("ok", { searched, known: knownDropped, shown: results.length });
      return c.json({ queries, results, searched, known: knownDropped });
    } catch (err) {
      tracer?.finish("error", { error: errText(err) });
      log.error("Find on YouTube failed for {doc}: {error}", { doc: docId, error: errText(err) });
      return c.json({ error: "Find on YouTube failed unexpectedly.", code: "internal" }, 500);
    } finally {
      running.delete(key);
    }
  });
}
