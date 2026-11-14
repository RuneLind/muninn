/**
 * The production services behind a discovery run (plan muninn-youtube-discovery):
 * the raw read, the two Haiku-tier calls, the yt-dlp search, the captured-video
 * listing and the details probe. One place, so the `/summaries` route and the
 * weekly `youtube-discovery` watcher (PR 3) run on the same calls and honour the
 * same e2e seam.
 */

import type { BotConfig } from "../bots/config.ts";
import type { Tracer } from "../tracing/tracer.ts";
import { fetchKnowledgeApi, fetchKnowledgeApiText, KnowledgeApiError } from "../ai/knowledge-api-client.ts";
import { callHaikuWithFallback } from "../ai/haiku-direct.ts";
import { encodeDocIdPath } from "../summaries/sources.ts";
import type { DiscoverVideoDetails } from "../db/youtube-discover.ts";
import { probeDiscoverDetails, searchYouTube, type YouTubeHit } from "./discover.ts";
import type { DiscoverTracer } from "./discover-run.ts";

export const YOUTUBE_SUMMARIES_COLLECTION = "youtube-summaries";
const RAW_READ_TIMEOUT_MS = 10_000;
const LISTING_TIMEOUT_MS = 10_000;
const MODEL_TIMEOUT_MS = 60_000;

/** One `youtube-summaries` document as huginn's listing names it. */
export interface CapturedDoc {
  id: string;
  url: string | null;
  /** `YYYY-MM-DD` (the capture's date), or null when the listing gives none. */
  date: string | null;
}

export interface DiscoverServices {
  /** The raw file, or `null` when huginn has no such document. Throws on any other failure. */
  readRaw: (collection: string, docId: string) => Promise<string | null>;
  queriesCall: (prompt: string, bot: BotConfig, tracer: DiscoverTracer | null) => Promise<string>;
  rankCall: (prompt: string, bot: BotConfig, tracer: DiscoverTracer | null) => Promise<string>;
  /** One search: hits, or `null` when it failed. */
  search: (query: string, n: number) => Promise<YouTubeHit[] | null>;
  /** Every `youtube-summaries` document. Throws on failure. */
  listCaptured: () => Promise<CapturedDoc[]>;
  /** One details probe: details, `"unavailable"` when the video is gone, or `null` when it failed. */
  probeDetails: (videoId: string, signal?: AbortSignal) => Promise<DiscoverVideoDetails | "unavailable" | null>;
}

/**
 * Test seam for `e2e/youtube-discover-boot.ts` ONLY: the two model calls, the
 * search, the listing and the details probe, replaced in-process before muninn
 * boots (the `findLinksTestSeam` precedent). Production never sets it.
 */
export const discoverTestSeam: Partial<DiscoverServices> = {};

const day = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m ? m[1]! : null;
};

/** huginn's listing rows → captured docs; a row with no id is dropped. */
export function parseCapturedListing(data: unknown): CapturedDoc[] {
  const docs = ((data as { documents?: unknown } | null)?.documents ?? []) as unknown[];
  const out: CapturedDoc[] = [];
  for (const d of Array.isArray(docs) ? docs : []) {
    const o = (d ?? {}) as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id) continue;
    out.push({
      id: o.id,
      url: typeof o.url === "string" && o.url ? o.url : null,
      date: day(o.date) ?? day(o.modifiedTime) ?? day(o.modified_time),
    });
  }
  return out;
}

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

export function defaultDiscoverServices(knowledgeApiUrl: string): DiscoverServices {
  const seam = discoverTestSeam;
  return {
    readRaw: async (collection, docId) => {
      try {
        return await fetchKnowledgeApiText(
          knowledgeApiUrl,
          `/api/document/${encodeURIComponent(collection)}/${encodeDocIdPath(docId)}?raw=1`,
          { timeoutMs: RAW_READ_TIMEOUT_MS },
        );
      } catch (err) {
        if (err instanceof KnowledgeApiError && err.upstreamStatus === 404) return null;
        throw err;
      }
    },
    queriesCall: (prompt, bot, tracer) =>
      seam.queriesCall ? seam.queriesCall(prompt, bot, tracer) : haiku(prompt, bot, tracer, "youtube-discover-queries"),
    rankCall: (prompt, bot, tracer) =>
      seam.rankCall ? seam.rankCall(prompt, bot, tracer) : haiku(prompt, bot, tracer, "youtube-discover-rank"),
    search: (query, n) => (seam.search ? seam.search(query, n) : searchYouTube(query, n)),
    listCaptured: async () => {
      if (seam.listCaptured) return seam.listCaptured();
      const data = await fetchKnowledgeApi(
        knowledgeApiUrl,
        `/api/collection/${YOUTUBE_SUMMARIES_COLLECTION}/documents?include_dates=1`,
        { timeoutMs: LISTING_TIMEOUT_MS },
      );
      return parseCapturedListing(data);
    },
    probeDetails: (videoId, signal) =>
      seam.probeDetails ? seam.probeDetails(videoId, signal) : probeDiscoverDetails(videoId, undefined, signal),
  };
}
