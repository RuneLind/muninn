import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { renderXArticlePage } from "../views/x-article-page.ts";
import { createJob, getJob, getRecentJobs, subscribe as subscribeJob } from "../../x-article/state.ts";
import { summarizeArticle } from "../../x-article/summarizer.ts";
import { discoverAllBots } from "../../bots/config.ts";
import { knowledgeApiHandler } from "./knowledge-api-client.ts";

const log = getLog("dashboard");

const XA_COLLECTION = "x-articles";

export function registerXArticleRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  app.get("/x-articles", async (c) => {
    return c.html(await renderXArticlePage());
  });

  // CORS preflight for Chrome extension
  app.options("/api/x-articles/summarize", () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  });

  app.post("/api/x-articles/summarize", async (c) => {
    c.header("Access-Control-Allow-Origin", "*");

    const body = await c.req.json<{
      title?: string;
      url?: string;
      article_id?: string;
      author?: string;
      article_text?: string;
    }>();
    const { title, url, article_id, author, article_text } = body;

    if (!url || !article_id || !article_text) {
      return c.json({ error: "Missing required fields: url, article_id, article_text" }, 400);
    }

    const jobId = createJob(article_id, title || url, url, author || "unknown");

    const bots = discoverAllBots();
    if (bots.length === 0) {
      return c.json({ error: "No bots configured" }, 500);
    }

    // Fire and forget — background summarization
    summarizeArticle(jobId, article_id, title || url, url, author || "unknown", article_text, config, bots[0]!).catch((err) => {
      log.error("X article summarization failed: {error}", { error: err instanceof Error ? err.message : String(err) });
    });

    return c.json({ job_id: jobId, dashboard_url: `/x-articles?job=${jobId}` });
  });

  app.get("/api/x-articles/stream/:jobId", (c) => {
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
      const unsubscribe = subscribeJob(jobId, async (event) => {
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

  app.get("/api/x-articles/jobs", (c) => {
    const limit = parseInt(c.req.query("limit") || "20", 10);
    const jobs = getRecentJobs(Math.min(Math.max(limit, 1), 100));
    return c.json({ jobs });
  });

  // --- X articles browse (proxy to knowledge API) ---

  app.get("/api/x-articles/documents", (c) => {
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/collection/${XA_COLLECTION}/documents`, 10000);
  });

  app.get("/api/x-articles/document/*", async (c) => {
    const docId = c.req.path.replace("/api/x-articles/document/", "");
    if (!docId) return c.json({ error: "Missing document ID" }, 400);
    const encodedDocId = docId.split("/").map(encodeURIComponent).join("/");
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/document/${XA_COLLECTION}/${encodedDocId}`);
  });

  app.get("/api/x-articles/similar", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "Missing query parameter" }, 400);
    const params = new URLSearchParams({ q, collection: XA_COLLECTION, limit: "7" });
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/search?${params}`, 10000);
  });
}
