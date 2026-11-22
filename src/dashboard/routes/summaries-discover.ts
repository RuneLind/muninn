/**
 * ▶ Find on YouTube and the Discover page for `/summaries` (plan
 * muninn-youtube-discovery, PRs 1–2).
 *
 * `POST /api/summaries/discover` `{source: "youtube", docId}` runs one discovery
 * from that summary (`runDiscovery`, `src/youtube/discover-run.ts`: queries,
 * yt-dlp searches, known-video dedup, the YouTube gate) and STORES it as a shelf
 * (`src/db/youtube-discover.ts`); the answer carries the run id and the shelf's
 * address. A failed save still answers the results, with `runId: null`.
 * Captures nothing (D2): Summarize is a click on `POST /api/youtube/summarize`.
 *
 * `GET /summaries/discover` — the page: the newest run of each seed as a shelf,
 * at most 40 plus every older one holding a Later video (`listDiscoverShelfPage`).
 * `POST /api/summaries/discover/state` `{videoId, state, ifState?}` — Later,
 * Dismiss, Undo, and `queued` after a Summarize started; a dismissed or queued
 * video joins the known set and is never suggested again. With `ifState` the
 * write applies only while the video is in that state (409 `state_changed`
 * otherwise): a failed capture puts a video back only while it is still `queued`.
 * `POST /api/summaries/discover/details` `{videoId}` — the drawer's details: one
 * yt-dlp probe for a STORED video (a POST because it spawns a process), one at a
 * time process-wide, cached on its hit rows.
 *
 * `application/json` required on every POST (415). Errors are `{error, code}`.
 */

import type { Context, Hono } from "hono";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { Tracer } from "../../tracing/tracer.ts";
import { getSummarySource, isSafeDocId } from "../../summaries/sources.ts";
import { extractYouTubeVideoId } from "../../youtube/url.ts";
import type { YouTubeHit } from "../../youtube/discover.ts";
import { defaultDiscoverServices, discoverTestSeam, type CapturedDoc } from "../../youtube/discover-deps.ts";
import { seedCategories, toSeedDocs } from "../../youtube/discover-seeds.ts";
import { runDiscovery, type DiscoverResult, type DiscoverTracer } from "../../youtube/discover-run.ts";
import { YOUTUBE_FRAME_SOURCE, isFrameId } from "../../summaries/frames.ts";
import {
  getDiscoverKnownVideoIds,
  getDiscoverVideoDetails,
  isDiscoverHitState,
  listDiscoverShelfPage,
  saveDiscoverRun,
  saveDiscoverVideoDetails,
  setDiscoverVideoState,
  type DiscoverHitInput,
  type DiscoverHitState,
  type DiscoverRunInput,
  type DiscoverShelfPage,
  type DiscoverVideoDetails,
} from "../../db/youtube-discover.ts";
import { renderSummariesDiscoverPage } from "../views/summaries-discover-page.ts";
import { loadInterestProfileForBot } from "../../profile/generator.ts";
import { authMode } from "../../auth/policy.ts";
import { requireJsonRequest } from "./json-request.ts";
import { getLog } from "../../logging.ts";

export type { DiscoverResult, DiscoverTracer };

const log = getLog("dashboard", "summaries-discover");

/** How long a video YouTube called unavailable is answered 410 without a probe. */
export const UNAVAILABLE_TTL_MS = 6 * 60 * 60_000;
/** How long the captured-video set is reused (the Stats tab's TTL). */
export const KNOWN_IDS_TTL_MS = 5 * 60_000;

/** The seed bar lists at most this many summaries (1,640 on 2026-11-14). */
const SEEDS_LISTED_MAX = 5000;

/** Where a stored run's shelf is. */
export const discoverShelfUrl = (runId: string): string => `/summaries/discover#run-${runId}`;

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
  /** Every `youtube-summaries` document with its date, for the seed bar. Throws on failure. */
  listCaptured: () => Promise<CapturedDoc[]>;
  /** The interest profile to rank with, or `null`. */
  profile: (bot: BotConfig) => Promise<string | null>;
  tracer?: (bot: BotConfig) => DiscoverTracer | null;
  now?: () => number;
  /** The store (`src/db/youtube-discover.ts`). */
  store: {
    saveRun: (run: DiscoverRunInput, hits: readonly DiscoverHitInput[]) => Promise<string>;
    knownIds: () => Promise<Set<string>>;
    /** Rows changed; with `ifState`, only rows still in that state change. */
    setState: (videoId: string, state: DiscoverHitState, ifState?: DiscoverHitState) => Promise<number>;
    getDetails: (videoId: string) => Promise<DiscoverVideoDetails | null | undefined>;
    saveDetails: (videoId: string, details: DiscoverVideoDetails) => Promise<void>;
    /** The page's shelves and how many older ones it left out. */
    listShelves: () => Promise<DiscoverShelfPage>;
  };
  /** One details probe: details, `"unavailable"` when the video is gone, or `null` when it failed. `signal` aborts when no caller is left. */
  probeDetails: (videoId: string, signal?: AbortSignal) => Promise<DiscoverVideoDetails | "unavailable" | null>;
}

/** Re-exported: `e2e/youtube-discover-boot.ts` sets it before muninn boots. */
export { discoverTestSeam };

export const DISCOVER_STORE: SummariesDiscoverDeps["store"] = {
  saveRun: saveDiscoverRun,
  knownIds: getDiscoverKnownVideoIds,
  setState: setDiscoverVideoState,
  getDetails: getDiscoverVideoDetails,
  saveDetails: saveDiscoverVideoDetails,
  listShelves: () => listDiscoverShelfPage(),
};

export function defaultSummariesDiscoverDeps(
  config: Config,
  opts: { loadProfile?: typeof loadInterestProfileForBot } = {},
): SummariesDiscoverDeps {
  const loadProfile = opts.loadProfile ?? loadInterestProfileForBot;
  const services = defaultDiscoverServices(config.knowledgeApiUrl);
  return {
    readRaw: services.readRaw,
    bots: discoverAllBots,
    queriesCall: services.queriesCall,
    rankCall: services.rankCall,
    search: services.search,
    listKnownUrls: async () => (await services.listCaptured()).map((d) => d.url ?? "").filter(Boolean),
    listCaptured: services.listCaptured,
    // An authenticating instance has many readers: a bot-wide profile is someone else's interests.
    profile: async (bot) => (authMode() === "off" ? loadProfile(bot.name) : null),
    tracer: (bot) => new Tracer("youtube-discover", { botName: bot.name, platform: "youtube-discover" }),
    store: DISCOVER_STORE,
    probeDetails: services.probeDetails,
  };
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const fail = (c: Context, status: 400 | 404 | 409 | 410 | 502 | 503, code: string, error: string) => c.json({ error, code }, status);

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const parsed: unknown = await c.req.json().catch(() => null);
  return (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
}

const videoIdOf = (body: Record<string, unknown>): string | null => {
  const id = typeof body.videoId === "string" ? body.videoId.trim() : "";
  return isFrameId(YOUTUBE_FRAME_SOURCE, id) ? id : null;
};

export function registerSummariesDiscoverRoutes(
  app: Hono,
  config: Config,
  deps: SummariesDiscoverDeps = defaultSummariesDiscoverDeps(config),
): void {
  const now = deps.now ?? Date.now;
  /** One discovery per document at a time. */
  const running = new Set<string>();
  /**
   * One details probe per video at a time; a second click joins the first. The
   * probe's signal aborts when every caller waiting on it has gone, so a queued
   * probe nobody waits for never spawns.
   */
  const probing = new Map<string, { result: Promise<DiscoverVideoDetails | "unavailable" | null>; waiters: number; ctl: AbortController }>();
  /** Videos YouTube called unavailable, and when. */
  const unavailable = new Map<string, number>();
  let captured: { ids: Set<string>; at: number } | null = null;
  let capturedInFlight: Promise<Set<string>> | null = null;

  /** The video ids `youtube-summaries` holds, cached and single-flighted. A failed listing is not cached. */
  function capturedIds(): Promise<Set<string>> {
    if (captured && now() - captured.at < KNOWN_IDS_TTL_MS) return Promise.resolve(captured.ids);
    capturedInFlight ??= (async () => {
      try {
        const ids = new Set<string>();
        for (const url of await deps.listKnownUrls()) {
          const id = extractYouTubeVideoId(url);
          if (id) ids.add(id);
        }
        captured = { ids, at: now() };
        return ids;
      } finally {
        capturedInFlight = null;
      }
    })();
    return capturedInFlight;
  }

  /** Captured ∪ dismissed ∪ queued. Each half degrades to none on failure; the store half is read fresh. */
  async function knownIds(): Promise<Set<string>> {
    const [listed, stored] = await Promise.all([
      capturedIds().catch((err) => {
        log.warn("Find on YouTube: known-video listing failed: {error}", { error: errText(err) });
        return new Set<string>();
      }),
      deps.store.knownIds().catch((err) => {
        log.warn("Find on YouTube: dismissed/queued read failed: {error}", { error: errText(err) });
        return new Set<string>();
      }),
    ]);
    return new Set([...listed, ...stored]);
  }

  app.get("/summaries/discover", async (c) => {
    let page: DiscoverShelfPage;
    try {
      page = await deps.store.listShelves();
    } catch (err) {
      log.error("Discover page: shelves read failed: {error}", { error: errText(err) });
      return c.html(await renderSummariesDiscoverPage({ shelves: [], hidden: 0, error: "Could not read the stored shelves." }), 500);
    }
    return c.html(await renderSummariesDiscoverPage({ shelves: page.shelves, hidden: page.hidden }));
  });

  /** The seed bar's choices: every YouTube summary, newest first, and the categories. */
  app.get("/api/summaries/discover/seeds", async (c) => {
    try {
      const docs = toSeedDocs(await deps.listCaptured()).slice(0, SEEDS_LISTED_MAX);
      return c.json({ docs, categories: seedCategories(docs), now: now() });
    } catch (err) {
      log.warn("Discover: seed listing failed: {error}", { error: errText(err) });
      return fail(c, 502, "upstream", "Could not list the YouTube summaries.");
    }
  });

  /** The stored shelves, for the page to re-render after a run. */
  app.get("/api/summaries/discover/shelves", async (c) => {
    try {
      const page = await deps.store.listShelves();
      return c.json({ shelves: page.shelves, hidden: page.hidden });
    } catch (err) {
      log.error("Discover: shelves read failed: {error}", { error: errText(err) });
      return c.json({ error: "Could not read the stored shelves.", code: "internal" }, 500);
    }
  });

  app.post("/api/summaries/discover", async (c) => {
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    const body = await jsonBody(c);
    const sourceId = typeof body.source === "string" ? body.source.trim() : "";
    const docId = typeof body.docId === "string" ? body.docId.trim() : "";
    const source = getSummarySource(sourceId);
    if (!source) return fail(c, 400, "bad_source", `unknown summary source "${sourceId}"`);
    if (sourceId !== "youtube") return fail(c, 400, "not_youtube", "Find on YouTube works on YouTube summaries only.");
    if (!docId || !isSafeDocId(docId)) return fail(c, 400, "bad_doc_id", "docId is not a document path");
    const origin = body.origin === undefined ? "reader" : body.origin;
    if (origin !== "reader" && origin !== "page") return fail(c, 400, "bad_origin", "origin is reader or page");
    const bot = resolveSummarizerBot(deps.bots());
    if (!bot) return fail(c, 503, "no_bot", "No bots are configured to run the search.");

    if (running.has(docId)) return fail(c, 409, "running", "A search from this summary is already running.");
    running.add(docId);
    const tracer = deps.tracer?.(bot) ?? null;
    try {
      const out = await runDiscovery(
        {
          readRaw: deps.readRaw,
          queriesCall: deps.queriesCall,
          rankCall: deps.rankCall,
          search: deps.search,
          knownIds,
          profile: deps.profile,
        },
        bot,
        tracer,
        { collection: source.collection, docId },
      );
      if (!out.ok) {
        // PR 1 logged exactly these: a failed read or model call, with the error text.
        if (out.cause) log.warn("Find on YouTube: {code} for {doc}: {error}", { doc: docId, code: out.code, error: out.cause });
        return fail(c, out.status, out.code, out.error);
      }
      let runId: string | null = null;
      try {
        runId = await deps.store.saveRun(
          {
            seedSource: sourceId,
            seedDocId: docId,
            seedTitle: out.seed.title,
            seedVideoId: out.seed.videoId,
            seedCategory: out.seed.category,
            seedDate: out.seed.date,
            queries: out.queries,
            searched: out.searched,
            known: out.known,
            origin,
            botName: bot.name,
            failed: out.failed,
          },
          out.results,
        );
      } catch (err) {
        // The results are paid for: answer them even when the shelf could not be stored.
        log.warn("Find on YouTube: saving the run failed for {doc}: {error}", { doc: docId, error: errText(err) });
      }
      return c.json({
        queries: out.queries,
        results: out.results,
        searched: out.searched,
        known: out.known,
        runId,
        shelfUrl: runId ? discoverShelfUrl(runId) : null,
      });
    } catch (err) {
      tracer?.finish("error", { error: errText(err) });
      log.error("Find on YouTube failed for {doc}: {error}", { doc: docId, error: errText(err) });
      return c.json({ error: "Find on YouTube failed unexpectedly.", code: "internal" }, 500);
    } finally {
      running.delete(docId);
    }
  });

  app.post("/api/summaries/discover/state", async (c) => {
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    const body = await jsonBody(c);
    const videoId = videoIdOf(body);
    if (!videoId) return fail(c, 400, "bad_video_id", "videoId is not a YouTube video id");
    if (!isDiscoverHitState(body.state)) return fail(c, 400, "bad_state", "state is new, later, dismissed or queued");
    const ifState = body.ifState;
    if (ifState !== undefined && !isDiscoverHitState(ifState)) return fail(c, 400, "bad_state", "ifState is new, later, dismissed or queued");
    try {
      const changed = await deps.store.setState(videoId, body.state, ifState);
      if (changed === 0 && ifState) return fail(c, 409, "state_changed", `The video is no longer ${ifState}.`);
      if (changed === 0) return fail(c, 404, "unknown_video", "No stored suggestion has this video.");
      return c.json({ videoId, state: body.state });
    } catch (err) {
      log.error("Discover: state write failed for {video}: {error}", { video: videoId, error: errText(err) });
      return c.json({ error: "Could not save the change.", code: "internal" }, 500);
    }
  });

  app.post("/api/summaries/discover/details", async (c) => {
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    const body = await jsonBody(c);
    const videoId = videoIdOf(body);
    if (!videoId) return fail(c, 400, "bad_video_id", "videoId is not a YouTube video id");
    try {
      const cached = await deps.store.getDetails(videoId);
      // Only a stored suggestion may spend a probe: the route never spawns yt-dlp for an arbitrary id.
      if (cached === undefined) return fail(c, 404, "unknown_video", "No stored suggestion has this video.");
      if (cached) return c.json({ videoId, details: cached, cached: true });
      const goneAt = unavailable.get(videoId);
      if (goneAt !== undefined && now() - goneAt < UNAVAILABLE_TTL_MS) {
        return fail(c, 410, "video_unavailable", "This video is no longer available on YouTube.");
      }
      let entry = probing.get(videoId);
      // An entry whose last waiter left is aborted: joining it would answer a probe that never runs.
      if (!entry || entry.ctl.signal.aborted) {
        const ctl = new AbortController();
        const created = { result: deps.probeDetails(videoId, ctl.signal), waiters: 0, ctl };
        created.result = created.result.finally(() => {
          if (probing.get(videoId) === created) probing.delete(videoId);
        });
        probing.set(videoId, created);
        entry = created;
      }
      const joined = entry;
      joined.waiters++;
      const leave = () => {
        if (--joined.waiters === 0) joined.ctl.abort();
      };
      const reqSignal = c.req.raw.signal;
      reqSignal.addEventListener("abort", leave, { once: true });
      let details: DiscoverVideoDetails | "unavailable" | null;
      try {
        details = await joined.result;
      } finally {
        if (!reqSignal.aborted) {
          reqSignal.removeEventListener("abort", leave);
          joined.waiters--;
        }
      }
      if (details === "unavailable") {
        unavailable.set(videoId, now());
        log.info("Discover: {video} is unavailable on YouTube", { video: videoId });
        return fail(c, 410, "video_unavailable", "This video is no longer available on YouTube.");
      }
      if (!details) {
        log.warn("Discover: details probe failed for {video}", { video: videoId });
        return fail(c, 502, "probe_failed", "YouTube did not answer the details lookup. Try again.");
      }
      await deps.store.saveDetails(videoId, details).catch((err) => {
        log.warn("Discover: caching details failed for {video}: {error}", { video: videoId, error: errText(err) });
      });
      return c.json({ videoId, details, cached: false });
    } catch (err) {
      log.error("Discover: details failed for {video}: {error}", { video: videoId, error: errText(err) });
      return c.json({ error: "The details lookup failed unexpectedly.", code: "internal" }, 500);
    }
  });
}
