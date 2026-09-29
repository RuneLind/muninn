/**
 * The doc panel's right-rail context: `GET /api/summaries/same-story` (other
 * captures of the same story, across every summary source) and
 * `GET /api/summaries/doc-context` (the wiki proposals drafted from one
 * summary). Registered by `registerSummariesRoutes`, so both are part of the
 * `summaries` route group: admin zone by default-deny, and not registered on
 * the `nais` profile.
 */
import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { SUMMARY_SOURCES } from "../../summaries/sources.ts";
import { fetchKnowledgeApi, KnowledgeApiError } from "../../ai/knowledge-api-client.ts";
import { getSourceProposalsForDoc, type SourceProposalForDoc } from "../../db/wiki-proposals.ts";

const log = getLog("dashboard", "summaries-context");

/** Hits the same-story search asks for; the client keeps the recent ones. */
export const SAME_STORY_LIMIT = 20;
/** Chunk content is never shown, only the heading: keep the answer small. */
export const SAME_STORY_CHUNK_CHARS = 200;
/** A title is short. Longer than this is not a query this route serves. */
const SAME_STORY_MAX_Q = 2_000;

export interface SummariesContextDeps {
  lookupSourceProposals: (collection: string, docId: string) => Promise<SourceProposalForDoc[]>;
}

const DEFAULT_DEPS: SummariesContextDeps = { lookupSourceProposals: getSourceProposalsForDoc };

export function registerSummariesContextRoutes(
  app: Hono,
  config: Config,
  deps: SummariesContextDeps = DEFAULT_DEPS,
): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  /**
   * One search across every summary collection huginn serves. The served set is
   * read first because `/api/search` answers 404 for the WHOLE request when any
   * listed collection is missing. Each hit gains the `source` its collection
   * belongs to; the client filters by date, relevance and what Similar shows.
   */
  app.get("/api/summaries/same-story", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ error: "Missing query parameter" }, 400);
    if (q.length > SAME_STORY_MAX_Q) return c.json({ error: `q is longer than ${SAME_STORY_MAX_Q} characters` }, 400);
    try {
      const listed = await fetchKnowledgeApi(KNOWLEDGE_API_URL, "/api/collections", { timeoutMs: 10_000 });
      const served = new Set<string>(
        (Array.isArray(listed?.collections) ? listed.collections : [])
          .map((x: { name?: unknown }) => x?.name)
          .filter((n: unknown): n is string => typeof n === "string"),
      );
      const sources = SUMMARY_SOURCES.filter((s) => served.has(s.collection));
      const missing = SUMMARY_SOURCES.filter((s) => !served.has(s.collection)).map((s) => s.collection);
      if (sources.length === 0) return c.json({ results: [], missing });

      const params = new URLSearchParams({ q });
      for (const s of sources) params.append("collection", s.collection);
      params.set("limit", String(SAME_STORY_LIMIT));
      params.set("corrective", "off");
      params.set("max_chunk_chars", String(SAME_STORY_CHUNK_CHARS));
      const data = await fetchKnowledgeApi(KNOWLEDGE_API_URL, `/api/search?${params}`, { timeoutMs: 10_000 });
      const byCollection = new Map(sources.map((s) => [s.collection, s.id]));
      const results = (Array.isArray(data?.results) ? data.results : [])
        .filter((r: { collection?: unknown }) => typeof r?.collection === "string" && byCollection.has(r.collection))
        .map((r: { collection: string }) => ({ ...r, source: byCollection.get(r.collection)! }));
      return c.json({ results, missing });
    } catch (err) {
      const status = err instanceof KnowledgeApiError ? err.statusCode : 502;
      log.warn("Same-story search failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: err instanceof Error ? err.message : String(err) }, status === 503 ? 503 : 502);
    }
  });

  /**
   * The `source` proposals drafted from one summary, on every bot, read from
   * this instance's own database. The client turns `bot` into that bot's wiki
   * links.
   */
  app.get("/api/summaries/doc-context", async (c) => {
    const sourceId = c.req.query("source") ?? "";
    const docId = c.req.query("docId") ?? "";
    const source = SUMMARY_SOURCES.find((s) => s.id === sourceId);
    if (!source) return c.json({ error: "Unknown source" }, 400);
    if (!docId) return c.json({ error: "Missing docId" }, 400);
    try {
      const proposals = await deps.lookupSourceProposals(source.collection, docId);
      return c.json({ proposals });
    } catch (err) {
      log.warn("Doc-context lookup failed for {source}/{docId}: {error}", {
        source: sourceId,
        docId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Proposal lookup failed" }, 500);
    }
  });
}
