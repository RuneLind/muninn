import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { renderYouTubePage } from "../views/youtube-page.ts";
import { createJob, getJob, getRecentJobs, subscribe as subscribeYouTubeJob } from "../../youtube/state.ts";
import { summarizeVideo } from "../../youtube/summarizer.ts";
import { discoverAllBots } from "../../bots/config.ts";

const log = getLog("dashboard");

const YT_COLLECTION = "youtube-summaries";

export function registerYouTubeRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  app.get("/youtube", (c) => {
    return c.html(renderYouTubePage());
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

    const jobId = createJob(video_id, title || url, url);

    const bots = discoverAllBots();
    if (bots.length === 0) {
      return c.json({ error: "No bots configured" }, 500);
    }

    // Fire and forget — background summarization
    summarizeVideo(jobId, video_id, title || url, url, config, bots[0]!).catch((err) => {
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

  app.get("/api/youtube/categories", async (c) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/youtube/categories`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      return c.json(await res.json());
    } catch (err) {
      log.warn("YouTube categories API failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  app.get("/api/youtube/documents", async (c) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/collection/${YT_COLLECTION}/documents`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      return c.json(await res.json());
    } catch (err) {
      log.warn("YouTube documents API failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  app.get("/api/youtube/document/*", async (c) => {
    const docId = c.req.path.replace("/api/youtube/document/", "");
    if (!docId) return c.json({ error: "Missing document ID" }, 400);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const encodedDocId = docId.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/document/${YT_COLLECTION}/${encodedDocId}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      return c.json(await res.json());
    } catch (err) {
      log.warn("YouTube document fetch failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });

  app.get("/api/youtube/similar", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "Missing query parameter" }, 400);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const params = new URLSearchParams({ q, collection: YT_COLLECTION, limit: "7" });
      const res = await fetch(`${KNOWLEDGE_API_URL}/api/search?${params}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return c.json({ error: "API returned " + res.status }, 502);
      return c.json(await res.json());
    } catch (err) {
      log.warn("YouTube similar search failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Knowledge API unreachable" }, 503);
    }
  });
}
