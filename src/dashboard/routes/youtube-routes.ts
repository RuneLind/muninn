import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { createJob, getJob, getRecentJobs, subscribe } from "../../youtube/state.ts";
import { summarizeVideo } from "../../youtube/summarizer.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { getSummarySource } from "../../summaries/sources.ts";
import { registerSummaryVertical } from "./summary-vertical.ts";

const log = getLog("dashboard");

// Single source of truth for the collection name lives in the registry.
const YT_SOURCE = getSummarySource("youtube")!;
const YT_COLLECTION = YT_SOURCE.collection;

interface YtDocumentMeta { id: string; url?: string }

function extractYouTubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    if (u.hostname.endsWith("youtube.com")) return u.searchParams.get("v");
    return null;
  } catch {
    return null;
  }
}

async function findExistingByVideoId(
  baseUrl: string,
  videoId: string,
): Promise<YtDocumentMeta | null> {
  try {
    const data = await fetchKnowledgeApi(
      baseUrl,
      `/api/collection/${YT_COLLECTION}/documents`,
      { timeoutMs: 10000 },
    );
    const docs = (data?.documents ?? []) as YtDocumentMeta[];
    return docs.find((d) => d.url != null && extractYouTubeVideoId(d.url) === videoId) ?? null;
  } catch (err) {
    log.warn("YouTube duplicate check failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function registerYouTubeRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  // Shared plumbing: bare-path redirect, CORS preflight, SSE stream, jobs,
  // document/similar proxies (the /youtube page merged into /summaries).
  registerSummaryVertical(app, config, {
    apiBase: YT_SOURCE.apiBase,
    collection: YT_COLLECTION,
    store: { getJob, getRecentJobs, subscribe },
    redirect: { path: "/youtube", source: "youtube" },
    corsPreflight: true,
  });

  app.post("/api/youtube/summarize", async (c) => {
    c.header("Access-Control-Allow-Origin", "*");

    const body = await c.req.json<{ title?: string; url?: string; video_id?: string }>();
    const { title, url, video_id } = body;

    if (!video_id || !url) {
      return c.json({ error: "Missing required fields: url, video_id" }, 400);
    }

    const existing = await findExistingByVideoId(KNOWLEDGE_API_URL, video_id);
    if (existing) {
      log.info("YouTube duplicate detected for {videoId}: {docId}", {
        videoId: video_id,
        docId: existing.id,
      });
      return c.json({
        duplicate: true,
        document_id: existing.id,
        existing_url: existing.url,
        dashboard_url: `/summaries?source=youtube&doc=${encodeURIComponent(existing.id)}&duplicate=1`,
      });
    }

    const jobId = createJob(video_id, title || url, url);

    const summarizerBot = resolveSummarizerBot(discoverAllBots());
    if (!summarizerBot) {
      return c.json({ error: "No bots configured" }, 500);
    }

    // Fire and forget — background summarization
    summarizeVideo(jobId, video_id, title || url, url, config, summarizerBot).catch((err) => {
      log.error("YouTube summarization failed: {error}", { error: err instanceof Error ? err.message : String(err) });
    });

    return c.json({ job_id: jobId, dashboard_url: `/summaries?source=youtube&job=${jobId}` });
  });
}
