import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { createJob, getJob, getRecentJobs, subscribe } from "../../x-article/state.ts";
import { summarizeArticle } from "../../x-article/summarizer.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { getSummarySource } from "../../summaries/sources.ts";
import { registerSummaryVertical } from "./summary-vertical.ts";

const log = getLog("dashboard");

// Single source of truth for the collection name lives in the registry.
const XA_SOURCE = getSummarySource("x-article")!;
const XA_COLLECTION = XA_SOURCE.collection;

interface XaDocumentMeta { id: string; url?: string }

async function findExistingByUrl(
  baseUrl: string,
  url: string,
): Promise<XaDocumentMeta | null> {
  try {
    const data = await fetchKnowledgeApi(
      baseUrl,
      `/api/collection/${XA_COLLECTION}/documents`,
      { timeoutMs: 10000 },
    );
    const docs = (data?.documents ?? []) as XaDocumentMeta[];
    return docs.find((d) => d.url === url) ?? null;
  } catch (err) {
    log.warn("X article duplicate check failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function registerXArticleRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  // Shared plumbing: bare-path redirect, CORS preflight, SSE stream, jobs,
  // document/similar proxies (the /x-articles page merged into /summaries).
  registerSummaryVertical(app, config, {
    apiBase: XA_SOURCE.apiBase,
    collection: XA_COLLECTION,
    store: { getJob, getRecentJobs, subscribe },
    redirect: { path: "/x-articles", source: "x-article" },
    corsPreflight: true,
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

    const existing = await findExistingByUrl(KNOWLEDGE_API_URL, url);
    if (existing) {
      log.info("X article duplicate detected for {url}: {docId}", {
        url,
        docId: existing.id,
      });
      return c.json({
        duplicate: true,
        document_id: existing.id,
        existing_url: existing.url,
        dashboard_url: `/summaries?source=x-article&doc=${encodeURIComponent(existing.id)}&duplicate=1`,
      });
    }

    const jobId = createJob(article_id, title || url, url, author || "unknown");

    const summarizerBot = resolveSummarizerBot(discoverAllBots());
    if (!summarizerBot) {
      return c.json({ error: "No bots configured" }, 500);
    }

    // Fire and forget — background summarization
    summarizeArticle(jobId, article_id, title || url, url, author || "unknown", article_text, config, summarizerBot).catch((err) => {
      log.error("X article summarization failed: {error}", { error: err instanceof Error ? err.message : String(err) });
    });

    return c.json({ job_id: jobId, dashboard_url: `/summaries?source=x-article&job=${jobId}` });
  });
}
