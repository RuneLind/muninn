import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { renderSummariesPage } from "../views/summaries-page.ts";
import { SUMMARY_SOURCES } from "../../summaries/sources.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";

const log = getLog("dashboard");

interface SummaryDocumentMeta {
  id: string;
  url?: string;
  date?: string;
  [key: string]: unknown;
}

/**
 * Merged documents listing across every summary source. Fetches each source's
 * collection in parallel (with dates, so the page can group by recency) and
 * tags every doc with its `source` id. A source that errors or is unreachable
 * contributes nothing — the rest still render (no all-or-nothing failure).
 */
export function registerSummariesRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  app.get("/summaries", async (c) => {
    return c.html(await renderSummariesPage());
  });

  app.get("/api/summaries/documents", async (c) => {
    const results = await Promise.all(
      SUMMARY_SOURCES.map(async (source) => {
        try {
          const data = await fetchKnowledgeApi(
            KNOWLEDGE_API_URL,
            `/api/collection/${source.collection}/documents?include_dates=1`,
            { timeoutMs: 10000 },
          );
          const docs = (data?.documents ?? []) as SummaryDocumentMeta[];
          return docs.map((d) => ({ ...d, source: source.id }));
        } catch (err) {
          log.warn("Summaries documents fetch failed for {source}: {error}", {
            source: source.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return [] as SummaryDocumentMeta[];
        }
      }),
    );

    return c.json({ documents: results.flat() });
  });
}
