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

/**
 * Hits the same-story search asks for; the client keeps at most five. Measured
 * 2026-09-29 on live huginn with rerank off: 15 finds the same siblings as 20
 * (a smaller pool reorders the ranks, and at 12 one sibling fell below the
 * threshold) at 0.1–0.34 s a search.
 */
export const SAME_STORY_LIMIT = 15;
/** Chunk content is never shown, only the heading: keep the answer small. */
export const SAME_STORY_CHUNK_CHARS = 200;
/** A title is short: the encoded `q` may be at most this many bytes. */
export const SAME_STORY_MAX_Q_BYTES = 2048;
/** How much of a docId a warn line carries. */
const LOG_DOC_ID_CHARS = 200;

/** The malformed /api/collections shapes already warned about. The keys are
 *  a fixed vocabulary (a `typeof` or "no string names"), so the set is small. */
const warnedShapes = new Set<string>();

/** Test seam: the warn set is process-lifetime. */
export function _resetSameStoryWarningsForTests(): void {
  warnedShapes.clear();
}

/**
 * The collection names huginn's /api/collections answer lists, or the shape
 * that makes it unreadable: `collections` not an array, or a non-empty array
 * with no string `name` in it. An empty array is a valid answer.
 */
function servedCollections(listed: unknown): { names: Set<string> } | { shape: string } {
  const list = (listed as { collections?: unknown } | null)?.collections;
  if (!Array.isArray(list)) return { shape: "collections is " + (list === null ? "null" : typeof list) };
  const names = list
    .map((x: { name?: unknown } | null) => x?.name)
    .filter((n: unknown): n is string => typeof n === "string");
  if (list.length > 0 && names.length === 0) return { shape: "no string names" };
  return { names: new Set(names) };
}

function encodedBytes(q: string): number {
  try {
    return encodeURIComponent(q).length;
  } catch {
    return Infinity; // a lone surrogate: not a query this route serves
  }
}

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
    if (encodedBytes(q) > SAME_STORY_MAX_Q_BYTES) {
      return c.json({ error: `q is longer than ${SAME_STORY_MAX_Q_BYTES} encoded bytes` }, 400);
    }
    // A reader who moved on releases both huginn fetches. huginn's sync
    // /api/search does not see the disconnect and finishes the search anyway
    // (one unreranked search, ~0.25 s); muninn only stops waiting for it.
    const signal = c.req.raw.signal;
    try {
      const listed = await fetchKnowledgeApi(KNOWLEDGE_API_URL, "/api/collections", { timeoutMs: 10_000, signal });
      const served = servedCollections(listed);
      if ("shape" in served) {
        if (!warnedShapes.has(served.shape)) {
          warnedShapes.add(served.shape);
          log.warn("Same story: huginn's /api/collections answer is malformed ({shape})", { shape: served.shape });
        }
        return c.json({ error: "Malformed /api/collections answer" }, 502);
      }
      const sources = SUMMARY_SOURCES.filter((s) => served.names.has(s.collection));
      const missing = SUMMARY_SOURCES.filter((s) => !served.names.has(s.collection)).map((s) => s.collection);
      if (sources.length === 0) return c.json({ results: [], missing });

      // No cross-encoder pass: on a short title it took huginn 16–22 s
      // (measured 2026-09-29), and relevance is then rank-derived.
      const params = new URLSearchParams({ q });
      for (const s of sources) params.append("collection", s.collection);
      params.set("limit", String(SAME_STORY_LIMIT));
      params.set("rerank", "false");
      params.set("corrective", "off");
      params.set("max_chunks_per_doc", "1");
      params.set("max_chunk_chars", String(SAME_STORY_CHUNK_CHARS));
      const data = await fetchKnowledgeApi(KNOWLEDGE_API_URL, `/api/search?${params}`, { timeoutMs: 10_000, signal });
      const byCollection = new Map(sources.map((s) => [s.collection, s.id]));
      const results = (Array.isArray(data?.results) ? data.results : [])
        .filter((r: { collection?: unknown }) => typeof r?.collection === "string" && byCollection.has(r.collection))
        .map((r: { collection: string }) => ({ ...r, source: byCollection.get(r.collection)! }));
      return c.json({ results, missing });
    } catch (err) {
      // The reader left: nobody reads this answer, and huginn was not at fault.
      if (signal.aborted) return c.json({ error: "Request cancelled" }, 503);
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
    // Postgres refuses a NUL in a jsonb string, as a 500.
    if (docId.includes("\u0000")) return c.json({ error: "docId contains a NUL" }, 400);
    try {
      const proposals = await deps.lookupSourceProposals(source.collection, docId);
      return c.json({ proposals });
    } catch (err) {
      log.warn("Doc-context lookup failed for {source}/{docId}: {error}", {
        source: sourceId,
        docId: docId.length > LOG_DOC_ID_CHARS ? docId.slice(0, LOG_DOC_ID_CHARS) + "…" : docId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Proposal lookup failed" }, 500);
    }
  });
}
