import type { Hono } from "hono";
import { Marked, type Token } from "marked";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { createJob, getJob, getRecentJobs, subscribe } from "../../article/state.ts";
import { summarizeArticle } from "../../article/summarizer.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { getSummarySource } from "../../summaries/sources.ts";
import { registerSummaryVertical } from "./summary-vertical.ts";

const log = getLog("dashboard");

// Single source of truth for the collection name lives in the registry.
const ARTICLE_SOURCE = getSummarySource("article")!;
const ARTICLE_COLLECTION = ARTICLE_SOURCE.collection;

interface ArticleDocumentMeta { id: string; url?: string }

async function findExistingByUrl(
  baseUrl: string,
  url: string,
): Promise<ArticleDocumentMeta | null> {
  try {
    const data = await fetchKnowledgeApi(
      baseUrl,
      `/api/collection/${ARTICLE_COLLECTION}/documents`,
      { timeoutMs: 10000 },
    );
    const docs = (data?.documents ?? []) as ArticleDocumentMeta[];
    return docs.find((d) => d.url === url) ?? null;
  } catch (err) {
    log.warn("Article duplicate check failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

const titleLexer = new Marked();

/** Inline tokens as plain text: links and emphasis to their text, code spans to their content, images and inline HTML to nothing. */
function inlineText(tokens: readonly Token[]): string {
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "image":
      case "html":
        break;
      case "br":
        out += "\n";
        break;
      case "codespan":
      case "escape":
        out += t.text;
        break;
      default:
        out += "tokens" in t && t.tokens ? inlineText(t.tokens) : "text" in t ? String(t.text) : "";
    }
  }
  return out;
}

/** The first line with prose among `tokens`' headings and paragraphs, descending into quotes and lists. */
function firstProseLine(tokens: readonly Token[]): string | null {
  for (const t of tokens) {
    let line: string | null = null;
    if (t.type === "heading" || t.type === "paragraph" || t.type === "text") {
      // A paragraph's soft and hard breaks end the title: the first line is the one a reader sees as the lede.
      line = inlineText(t.tokens ?? []).split("\n").map((l) => l.replace(/\s+/g, " ").trim())
        .find((l) => /[^\s*_`~#>=+\-|:]/.test(l)) ?? null;
    } else if (t.type === "blockquote" || t.type === "list_item") {
      line = firstProseLine(t.tokens ?? []);
    } else if (t.type === "list") {
      line = firstProseLine(t.items);
    }
    if (line !== null) return line;
  }
  return null;
}

/**
 * Derive a non-empty title from the pasted text (the paste form sends the
 * walk's markdown), truncated to ~80 chars — so huginn's
 * `/api/articles/ingest` never receives an empty title (the drafter
 * downstream keys pages off it). marked parses the text, so CommonMark
 * decides what is a fence, a heading or a list: the title is the first line
 * with prose of the first heading or paragraph, reached through quotes and
 * lists; code, HTML blocks, tables and rules are skipped.
 */
export function deriveTitle(text: string): string {
  const firstLine = firstProseLine(titleLexer.lexer(text)) ?? "Untitled article";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

/**
 * Article vertical — pasted-text capture (first use case: LinkedIn). Unlike
 * x-article, the text is pasted straight into the /summaries form (same-origin),
 * so the summarize entry is NOT extension-facing: it registers without a CORS
 * preflight and sets no Access-Control-Allow-Origin header (mirroring
 * anthropic-routes for the CORS aspect, not x-article).
 */
export function registerArticleRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  // Shared plumbing: SSE stream, jobs, document/similar proxies against
  // `article-summaries`. No bare-path redirect (no legacy /articles page) and no
  // CORS preflight (the paste form is same-origin).
  registerSummaryVertical(app, config, {
    apiBase: ARTICLE_SOURCE.apiBase,
    collection: ARTICLE_COLLECTION,
    store: { getJob, getRecentJobs, subscribe },
    completeCarriesSummary: true,
  });

  app.post("/api/articles/summarize", async (c) => {
    const body = await c.req.json<{
      text?: string;
      title?: string;
      url?: string;
      author?: string;
    }>();
    const { text, title, url, author } = body;

    if (!text || !text.trim()) {
      return c.json({ error: "Missing required field: text" }, 400);
    }

    // Duplicate check by URL only when a URL is given (a URL-less paste forks).
    if (url) {
      const existing = await findExistingByUrl(KNOWLEDGE_API_URL, url);
      if (existing) {
        log.info("Article duplicate detected for {url}: {docId}", {
          url,
          docId: existing.id,
        });
        return c.json({
          duplicate: true,
          document_id: existing.id,
          existing_url: existing.url,
          dashboard_url: `/summaries?source=article&doc=${encodeURIComponent(existing.id)}&duplicate=1`,
        });
      }
    }

    // Title guarantee: never let huginn receive an empty title.
    const resolvedTitle = title?.trim() || deriveTitle(text);

    const jobId = createJob(resolvedTitle, url, author);

    const summarizerBot = resolveSummarizerBot(discoverAllBots());
    if (!summarizerBot) {
      return c.json({ error: "No bots configured" }, 500);
    }

    // Fire and forget — background summarization
    summarizeArticle(jobId, resolvedTitle, url ?? "", author ?? "", text, config, summarizerBot).catch((err) => {
      log.error("Article summarization failed: {error}", { error: err instanceof Error ? err.message : String(err) });
    });

    return c.json({ job_id: jobId, dashboard_url: `/summaries?source=article&job=${jobId}` });
  });
}
