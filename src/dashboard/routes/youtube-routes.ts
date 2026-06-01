import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { renderYouTubePage } from "../views/youtube-page.ts";
import { createJob, getJob, getRecentJobs, subscribe as subscribeYouTubeJob } from "../../youtube/state.ts";
import { summarizeVideo } from "../../youtube/summarizer.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { knowledgeApiHandler, fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";

const log = getLog("dashboard");

const YT_COLLECTION = "youtube-summaries";

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

  app.get("/youtube", async (c) => {
    return c.html(await renderYouTubePage());
  });

  // CORS preflight for Chrome extension
  app.options("/api/youtube/summarize", () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
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
        dashboard_url: `/youtube?doc=${encodeURIComponent(existing.id)}&duplicate=1`,
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

    return c.json({ job_id: jobId, dashboard_url: `/youtube?job=${jobId}` });
  });

  app.get("/api/youtube/stream/:jobId", (c) => {
    const jobId = c.req.param("jobId");
    const job = getJob(jobId);

    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }

    return streamSSE(c, async (stream) => {
      // Replay current state
      await stream.writeSSE({ event: "status", data: JSON.stringify({ status: job.status }) });
      if (job.text) {
        await stream.writeSSE({ event: "text_delta", data: JSON.stringify({ text: job.text }) });
      }
      if (job.category) {
        await stream.writeSSE({ event: "category", data: JSON.stringify({ category: job.category }) });
      }
      if (job.similar) {
        await stream.writeSSE({ event: "similar", data: JSON.stringify({ articles: job.similar }) });
      }

      // If already terminal, send final event and close
      if (job.status === "complete") {
        await stream.writeSSE({ event: "complete", data: "{}" });
        return;
      }
      if (job.status === "error") {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: job.error }) });
        return;
      }

      // Subscribe to live updates
      let alive = true;
      const unsubscribe = subscribeYouTubeJob(jobId, async (event) => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          if (event.type === "complete" || event.type === "error") {
            alive = false;
          }
        } catch {
          alive = false;
        }
      });

      // Heartbeat every 30s
      const heartbeat = setInterval(async () => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: "heartbeat", data: "{}" });
        } catch {
          alive = false;
        }
      }, 30_000);

      stream.onAbort(() => {
        alive = false;
        unsubscribe();
        clearInterval(heartbeat);
      });

      while (alive) {
        await Bun.sleep(1000);
      }
      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  app.get("/api/youtube/jobs", (c) => {
    const limit = parseInt(c.req.query("limit") || "20", 10);
    const jobs = getRecentJobs(Math.min(Math.max(limit, 1), 100));
    return c.json({ jobs });
  });

  // --- YouTube browse (proxy to knowledge API) ---

  app.get("/api/youtube/categories", (c) => {
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, "/api/youtube/categories");
  });

  app.get("/api/youtube/documents", (c) => {
    // include_dates lets the page group articles by recency; it reads every doc
    // file upstream, so the duplicate-check path (findExistingByVideoId) omits it.
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/collection/${YT_COLLECTION}/documents?include_dates=1`, 10000);
  });

  app.get("/api/youtube/document/*", async (c) => {
    // Read the still-encoded path from the raw URL. c.req.path decodes lossily
    // (decodeURI-style: %20→space but reserved chars like %2C, %24 stay
    // encoded), so re-encoding it double-encodes the reserved ones and the
    // upstream 404s (surfaced here as 502). The client already
    // encodeURIComponent'd each segment, so forward that encoding verbatim.
    const encodedDocId = new URL(c.req.url).pathname.replace("/api/youtube/document/", "");
    if (!encodedDocId) return c.json({ error: "Missing document ID" }, 400);
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/document/${YT_COLLECTION}/${encodedDocId}`);
  });

  app.get("/api/youtube/similar", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "Missing query parameter" }, 400);
    const params = new URLSearchParams({ q, collection: YT_COLLECTION, limit: "7" });
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/search?${params}`, 10000);
  });
}
