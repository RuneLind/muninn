import { getLog } from "../logging.ts";
import { decomposeQuestion, type DecomposeResult } from "./knowledge-decomposer.ts";
import { fetchKnowledgeApi, KnowledgeApiError } from "./knowledge-api-client.ts";
import { fetchHuginnTrace } from "./huginn-trace-pointer.ts";
import { Tracer, type TraceContext } from "../tracing/index.ts";
import type { ConnectorType } from "../bots/config.ts";
import type { HaikuBackend } from "./haiku-direct.ts";

const log = getLog("ai", "research-knowledge");

// Cold-cache huginn searches against the melosys collections regularly land in
// the 5–15s range, and N parallel queries can serialise inside huginn's
// embedder. 30s gives generous headroom without hanging the bot indefinitely.
const SEARCH_TIMEOUT_MS = 30_000;
const TRACE_FETCH_TIMEOUT_MS = 2000;

export interface ResearchKnowledgeOptions {
  question: string;
  /** Optional comma-separated huginn collections. Empty = huginn-default (all). */
  collections?: string[];
  /** Optional per-search limit forwarded to /api/search?limit=. */
  limit?: number;
  /** Bot context for tracing + Haiku backend resolution. */
  botName: string;
  /** Huginn base URL (e.g. http://localhost:8321). */
  knowledgeApiUrl: string;
  /** Optional parent trace context — root span attaches under it. */
  traceContext?: TraceContext;
  /** Optional user id for trace attribution. */
  userId?: string;
  /** Bot's main connector — drives the connector-derived Haiku default. */
  connector?: ConnectorType;
  /** Per-bot override from `BotConfig.haikuBackend`. */
  haikuBackend?: HaikuBackend;
}

export interface ResearchHit {
  collection: string;
  id: string;
  title?: string;
  url?: string;
  /** Best relevance score across all sub-questions that returned this doc. */
  relevance: number;
  matchedChunks?: unknown[];
  metadata?: Record<string, unknown>;
  confidenceBand?: string;
  graph_context?: unknown[];
  /** Which sub-question(s) surfaced this doc — provenance for the bot/UI. */
  viaSubQuestion: string[];
}

export interface ResearchDecomposition {
  subQuestions: string[];
  rationale: string;
  passthrough: boolean;
  haikuMs: number;
}

export interface SubQuestionTrace {
  subQuestion: string;
  durationMs: number;
  resultCount: number;
  bestScore?: number;
  lowConfidence?: boolean;
  traceId?: string;
  error?: string;
}

export interface ResearchKnowledgeResult {
  results: ResearchHit[];
  decomposition: ResearchDecomposition;
  /** Per-sub-question timing/diagnostics, in input order. */
  subSearches: SubQuestionTrace[];
  /** Trace id of the muninn-side research_knowledge root span (for cross-referencing). */
  traceId: string;
}

interface RawHit {
  collection?: string;
  id?: string;
  title?: string;
  url?: string;
  relevance?: number;
  matchedChunks?: unknown[];
  metadata?: Record<string, unknown>;
  confidenceBand?: string;
  graph_context?: unknown[];
}

interface SearchResponse {
  results?: RawHit[];
  bestScore?: number;
  lowConfidence?: boolean;
  traceId?: string;
}

/**
 * What the `knowledge_decompose` span records.
 *
 * A function, so the rule is testable without a tracing-enabled harness: the
 * decomposer's degradation is only visible in production THROUGH this span, so
 * "is it recorded?" has to be a test rather than a reading.
 *
 * `passthrough` and `rationale` alone cannot say whether the decomposer GAVE UP:
 * the valid single-lookup path sets `passthrough` too, and the two `malformed`
 * sites carry whatever rationale the MODEL wrote (see `DecomposeDegradation`).
 * Without `degraded`, a decomposition that lost its entire fan-out renders on
 * /traces exactly like a healthy cheap lookup — and the smoke probe, which does
 * read it, is not something anyone runs in a pod. Both new fields are OMITTED
 * rather than falsified when absent: no degradation, and no backend at all on a
 * chain that threw outright.
 */
export function decomposeSpanAttributes(
  question: string,
  decomposition: DecomposeResult,
): Record<string, unknown> {
  return {
    question,
    subQuestions: decomposition.subQuestions,
    rationale: decomposition.rationale,
    passthrough: decomposition.passthrough,
    ...(decomposition.degraded ? { degraded: decomposition.degraded } : {}),
    ...(decomposition.backend ? { backend: decomposition.backend } : {}),
  };
}

export async function researchKnowledge(opts: ResearchKnowledgeOptions): Promise<ResearchKnowledgeResult> {
  const { question, collections, limit, botName, knowledgeApiUrl, traceContext, userId, connector, haikuBackend } = opts;

  const tracer = new Tracer("research_knowledge", {
    botName,
    userId,
    traceId: traceContext?.traceId,
    parentId: traceContext?.parentId,
  });

  const decomposition = await decomposeQuestion({ question, botName, connector, haikuBackend, tracer });
  tracer.addChildSpan(
    "knowledge_decompose",
    "knowledge_decompose",
    decomposition.haikuMs,
    decomposeSpanAttributes(question, decomposition),
  );

  // One /api/search per sub-question. Huginn's Path D handles rescue server-side
  // so we deliberately do not add another retry layer here.
  const subSearches: SubQuestionTrace[] = new Array(decomposition.subQuestions.length);
  const merged = new Map<string, ResearchHit>();

  const searches = decomposition.subQuestions.map(async (subQuestion, idx) => {
    const t0 = performance.now();
    const path = buildSearchPath(subQuestion, collections, limit);
    try {
      const response = await fetchKnowledgeApi(knowledgeApiUrl, path, { timeoutMs: SEARCH_TIMEOUT_MS }) as SearchResponse;
      const durationMs = performance.now() - t0;
      const rawHits = Array.isArray(response.results) ? response.results : [];

      // Best-effort: fetch huginn's trace so the per-sub-q `search` span carries
      // the same corrective block Phase 0c.1/0c.2 already render in the waterfall.
      const searchTrace = response.traceId
        ? await fetchHuginnTrace(`${knowledgeApiUrl}/api/trace/${response.traceId}`, TRACE_FETCH_TIMEOUT_MS).catch(() => null)
        : null;

      subSearches[idx] = {
        subQuestion,
        durationMs,
        resultCount: rawHits.length,
        bestScore: response.bestScore,
        lowConfidence: response.lowConfidence,
        traceId: response.traceId,
      };

      tracer.addChildSpan(
        "research_knowledge",
        "search",
        durationMs,
        {
          subQuestion,
          resultCount: rawHits.length,
          bestScore: response.bestScore,
          lowConfidence: response.lowConfidence,
          huginnTraceId: response.traceId,
          collections,
          // Span-label.ts reads attrs.searchTrace.response.corrective — same
          // shape the existing search_knowledge tool spans use.
          ...(searchTrace ? { searchTrace } : {}),
        },
      );

      for (const hit of rawHits) {
        mergeHit(merged, hit, subQuestion);
      }
    } catch (err) {
      const durationMs = performance.now() - t0;
      const message = err instanceof KnowledgeApiError ? err.message : err instanceof Error ? err.message : String(err);
      subSearches[idx] = {
        subQuestion,
        durationMs,
        resultCount: 0,
        error: message,
      };
      tracer.addChildSpan(
        "research_knowledge",
        "search",
        durationMs,
        { subQuestion, error: message, collections },
      );
      log.warn("sub_search_failed botName={botName} subQuestion={subQuestion} error={error}", { botName, subQuestion, error: message });
    }
  });

  await Promise.all(searches);

  const sortedResults = Array.from(merged.values()).sort((a, b) => b.relevance - a.relevance);

  tracer.finish("ok", {
    totalResults: sortedResults.length,
    subQuestionCount: decomposition.subQuestions.length,
    passthrough: decomposition.passthrough,
  });

  return {
    results: sortedResults,
    decomposition: {
      subQuestions: decomposition.subQuestions,
      rationale: decomposition.rationale,
      passthrough: decomposition.passthrough,
      haikuMs: decomposition.haikuMs,
    },
    subSearches,
    traceId: tracer.traceId,
  };
}

function buildSearchPath(query: string, collections?: string[], limit?: number): string {
  const params = new URLSearchParams({ q: query });
  if (typeof limit === "number" && limit > 0) {
    params.set("limit", String(limit));
  }
  if (collections && collections.length > 0) {
    for (const c of collections) params.append("collection", c);
  }
  return `/api/search?${params}`;
}

export function mergeHit(
  merged: Map<string, ResearchHit>,
  raw: RawHit,
  subQuestion: string,
): void {
  if (!raw || typeof raw.collection !== "string" || typeof raw.id !== "string") return;
  const key = `${raw.collection}\x00${raw.id}`;
  const relevance = typeof raw.relevance === "number" ? raw.relevance : 0;

  const existing = merged.get(key);
  if (!existing) {
    merged.set(key, {
      collection: raw.collection,
      id: raw.id,
      title: raw.title,
      url: raw.url,
      relevance,
      matchedChunks: raw.matchedChunks,
      metadata: raw.metadata,
      confidenceBand: raw.confidenceBand,
      graph_context: raw.graph_context,
      viaSubQuestion: [subQuestion],
    });
    return;
  }

  if (!existing.viaSubQuestion.includes(subQuestion)) {
    existing.viaSubQuestion.push(subQuestion);
  }
  if (relevance > existing.relevance) {
    existing.relevance = relevance;
    // Keep the chunk/title/metadata from whichever sub-question scored higher —
    // that's the one most likely to have the bot's best context.
    if (raw.title) existing.title = raw.title;
    if (raw.url) existing.url = raw.url;
    if (raw.matchedChunks) existing.matchedChunks = raw.matchedChunks;
    if (raw.metadata) existing.metadata = raw.metadata;
    if (raw.confidenceBand) existing.confidenceBand = raw.confidenceBand;
    if (raw.graph_context) existing.graph_context = raw.graph_context;
  }
}

export function formatResearchResultText(result: ResearchKnowledgeResult): string {
  const { results, decomposition, subSearches } = result;
  const lines: string[] = [];

  lines.push(`# Research summary`);
  lines.push("");
  lines.push(`**Decomposition** (${decomposition.passthrough ? "passthrough" : `${decomposition.subQuestions.length} sub-questions`}): ${decomposition.rationale}`);
  for (let i = 0; i < decomposition.subQuestions.length; i++) {
    const sq = decomposition.subQuestions[i]!;
    const trace = subSearches[i];
    const meta = trace ? formatSubMeta(trace) : "";
    lines.push(`${i + 1}. ${sq}${meta}`);
  }
  lines.push("");

  // A5 (nais slate): a transport failure and a genuinely empty corpus used to end
  // in the same sentence, so a bot whose `KNOWLEDGE_API_URL` pointed nowhere read
  // its own outage as "the corpus has nothing" and answered unsourced with
  // confidence. The per-sub-question line already carries `error: …` via
  // formatSubMeta; what was missing is the VERDICT the model acts on. Same
  // separation `JiraCoverage` makes between `no_hits` and `unreachable`.
  const total = decomposition.subQuestions.length;
  const failedCount = subSearches.filter((s) => s?.error).length;

  if (results.length === 0) {
    if (failedCount > 0 && failedCount === total) {
      lines.push(`**Knowledge search is UNAVAILABLE — this is NOT an empty corpus.**`);
      lines.push("");
      lines.push(
        `All ${total} sub-search${total === 1 ? "" : "es"} failed — see the per-question errors above. ` +
        `Tell the user the knowledge base could not be reached, and answer only from what is ` +
        `already in this conversation. Do not present anything as checked against the sources.`,
      );
      return lines.join("\n");
    }
    // Some reached the knowledge base and found nothing; the rest never ran. The
    // first pass let this fall through to the bare sentence below, which is the
    // very claim this surface exists to stop — one flapping sub-search is enough.
    if (failedCount > 0) {
      lines.push(`**No results, and the lookup was INCOMPLETE: ${failedCount} of ${total} sub-searches did not complete.**`);
      lines.push("");
      lines.push(
        `Do not report this as "nothing exists" — say the lookup was partial, and that what did run found nothing.`,
      );
      return lines.join("\n");
    }
    lines.push(`No results across ${total} sub-question${total === 1 ? "" : "s"}.`);
    return lines.join("\n");
  }

  // Some reached the knowledge base and some did not: the hits below are real,
  // but they are not the whole answer, and only the tool text can say so.
  if (failedCount > 0) {
    lines.push(`**Partial: ${failedCount} of ${total} sub-searches failed to reach the knowledge base — the results below are incomplete.**`);
    lines.push("");
  }

  lines.push(`## Results (${results.length} unique documents)`);
  lines.push("");
  for (const hit of results) {
    const title = hit.title || hit.id;
    const url = hit.url ? ` — ${hit.url}` : "";
    lines.push(`### [${hit.collection}] ${title}${url}`);
    lines.push(`relevance: ${hit.relevance.toFixed(3)} · via: ${hit.viaSubQuestion.map((q) => `"${q}"`).join(", ")}`);
    if (hit.confidenceBand) lines.push(`confidence: ${hit.confidenceBand}`);
    const firstChunk = Array.isArray(hit.matchedChunks) && hit.matchedChunks[0]
      ? extractChunkText(hit.matchedChunks[0])
      : null;
    if (firstChunk) {
      lines.push("");
      lines.push(firstChunk);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatSubMeta(trace: SubQuestionTrace): string {
  const parts: string[] = [];
  parts.push(`${trace.resultCount} hit${trace.resultCount === 1 ? "" : "s"}`);
  if (typeof trace.bestScore === "number") parts.push(`bestScore=${trace.bestScore.toFixed(3)}`);
  if (trace.lowConfidence) parts.push("lowConfidence");
  if (trace.error) parts.push(`error: ${trace.error}`);
  parts.push(`${Math.round(trace.durationMs)}ms`);
  return ` _(${parts.join(" · ")})_`;
}

function extractChunkText(chunk: unknown): string | null {
  if (chunk && typeof chunk === "object" && "content" in chunk && typeof (chunk as { content: unknown }).content === "string") {
    const content = (chunk as { content: string }).content.trim();
    return content.length > 0 ? content : null;
  }
  return null;
}
