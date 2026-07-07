/**
 * Durable ledger of Research sources — every citation PRESENTED for an answer,
 * flagged with whether the synthesized answer actually referenced it (`cited`).
 *
 * The Research flow computes `citedIndices(answer)` and streams it to the browser
 * on the SSE `done` event, then discards it. Persisting all presented citations —
 * cited AND retrieved-but-ignored — turns that transient signal into a queryable
 * record of what retrieval surfaced vs. what the answer actually used.
 */

import { getDb } from "./client.ts";
import { getLog } from "../logging.ts";

const log = getLog("db", "research-citations");

/** One presented source row to persist. `cited` marks answer-referenced sources. */
export interface ResearchCitationInsert {
  botName?: string | null;
  userId?: string | null;
  traceId?: string | null;
  question?: string | null;
  docId: string;
  collection: string;
  url?: string | null;
  title?: string | null;
  relevance?: number | null;
  cited: boolean;
}

/**
 * Bulk-insert the citations presented for a single answer. No-op on an empty
 * list. Callers fire-and-forget this so it never blocks the SSE response — any
 * failure is logged, not thrown.
 */
export async function insertResearchCitations(rows: ResearchCitationInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = getDb();
  const values = rows.map((r) => ({
    bot_name: r.botName ?? null,
    user_id: r.userId ?? null,
    trace_id: r.traceId ?? null,
    question: r.question ?? null,
    doc_id: r.docId,
    collection: r.collection,
    url: r.url ?? null,
    title: r.title ?? null,
    relevance: r.relevance ?? null,
    cited: r.cited,
  }));
  const result = await sql`
    INSERT INTO research_citations ${sql(
      values,
      "bot_name",
      "user_id",
      "trace_id",
      "question",
      "doc_id",
      "collection",
      "url",
      "title",
      "relevance",
      "cited",
    )}
  `;
  return result.count;
}

/**
 * Convenience wrapper for the Research `done` path: given the presented citations
 * and the set of 1-based indices the answer cited, persist all of them with the
 * `cited` flag resolved per-source. Fire-and-forget friendly — swallows + logs.
 */
export async function persistResearchCitations(params: {
  botName?: string | null;
  userId?: string | null;
  traceId?: string | null;
  question?: string | null;
  citations: Array<{
    n: number;
    collection: string;
    docId: string;
    url?: string;
    title?: string;
    relevance?: number;
  }>;
  citedIndices: number[];
}): Promise<void> {
  try {
    const cited = new Set(params.citedIndices);
    const rows: ResearchCitationInsert[] = params.citations.map((c) => ({
      botName: params.botName,
      userId: params.userId,
      traceId: params.traceId,
      question: params.question,
      docId: c.docId,
      collection: c.collection,
      url: c.url ?? null,
      title: c.title ?? null,
      relevance: typeof c.relevance === "number" ? c.relevance : null,
      cited: cited.has(c.n),
    }));
    const inserted = await insertResearchCitations(rows);
    log.debug("Persisted {count} research citations traceId={traceId}", {
      count: inserted,
      traceId: params.traceId ?? "none",
    });
  } catch (err) {
    log.warn("Failed to persist research citations: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface CitationRow {
  id: string;
  botName: string | null;
  userId: string | null;
  traceId: string | null;
  question: string | null;
  docId: string;
  collection: string;
  url: string | null;
  title: string | null;
  relevance: number | null;
  cited: boolean;
  createdAt: number;
}

/** Read back citations for a trace (tests + future dashboard drill-down). */
export async function getCitationsForTrace(traceId: string): Promise<CitationRow[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, bot_name, user_id, trace_id, question, doc_id, collection,
           url, title, relevance, cited, created_at
    FROM research_citations
    WHERE trace_id = ${traceId}
    ORDER BY created_at ASC, doc_id ASC
  `;
  return rows.map(mapCitationRow);
}

function mapCitationRow(r: Record<string, any>): CitationRow {
  return {
    id: r.id,
    botName: r.bot_name ?? null,
    userId: r.user_id ?? null,
    traceId: r.trace_id ?? null,
    question: r.question ?? null,
    docId: r.doc_id,
    collection: r.collection,
    url: r.url ?? null,
    title: r.title ?? null,
    relevance: r.relevance != null ? Number(r.relevance) : null,
    cited: Boolean(r.cited),
    createdAt: new Date(r.created_at).getTime(),
  };
}
