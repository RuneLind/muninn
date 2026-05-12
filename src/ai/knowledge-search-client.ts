import { getLog } from "../logging.ts";

const log = getLog("ai", "knowledge-search");

/** Base URL for Huginn's HTTP API — same env Huginn-side uses. Read directly
 *  (not via `loadConfig()`) so this module has no `DATABASE_URL` dependency. */
function knowledgeApiBaseUrl(): string {
  return process.env.KNOWLEDGE_API_URL || "http://localhost:8321";
}

/**
 * Thin HTTP client for Huginn's `GET /api/search`, plus a renderer that mirrors
 * the shape Huginn's MCP adapter produces (so a corrective re-query's hits read
 * identically to the ones the model already saw) and parsers for the signal
 * Huginn bakes into result text — the `collection: \`x\` doc_id: \`y\`` lines
 * (for deduping a re-query) and the `*Weak match …*` / "No results" footer
 * (for grading). Used by the corrective-retrieval loop; consumes Huginn's
 * `bestScore` / `confidenceBand` / `retryHints` / `noConfidentResults` /
 * `min_relevance` contract.
 */

export type ConfidenceBand = "high" | "medium" | "low";

export interface KnowledgeMatchedChunk {
  content?: string;
  heading?: string;
  relevance?: number;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeSearchResult {
  collection: string;
  id: string;
  title: string;
  url?: string;
  snippet?: string;
  breadcrumb?: string;
  heading?: string;
  relevance?: number;
  confidenceBand?: ConfidenceBand;
  modifiedTime?: string;
  matchedChunks?: KnowledgeMatchedChunk[];
  metadata?: Record<string, unknown>;
  /** Graph-context annotation lines, when graph augmentation produced any. */
  graphContext?: string[];
}

export interface KnowledgeRetryHints {
  detectedEntities?: string[];
  relatedTerms?: string[];
  narrowerQuery?: string;
  broaderQuery?: string;
}

export interface KnowledgeSearchResponse {
  results: KnowledgeSearchResult[];
  bestScore?: number;
  noConfidentResults?: boolean;
  retryHints?: KnowledgeRetryHints;
  /** Present when Huginn returns a relational graph answer ahead of the hits. */
  graphAnswer?: string;
}

export interface SearchKnowledgeOptions {
  /** Restrict to specific collection(s). Omit to search all available. */
  collections?: string[];
  limit?: number;
  brief?: boolean;
  /** Force (or disable) cross-encoder reranking. Default: Huginn's default
   *  (`true` for full, `false` for brief). Corrective re-queries pass `true`
   *  so `confidenceBand` is trustworthy on the re-query. */
  rerank?: boolean;
  /** Drop results below this relevance (0.0–1.0). When it empties the set the
   *  response carries `noConfidentResults` + `retryHints`. */
  minRelevance?: number;
  maxChunksPerDoc?: number;
  timeoutMs?: number;
  /** Override the base URL (defaults to `config.knowledgeApiUrl`). */
  baseUrl?: string;
}

const GRAPH_CONTEXT_KEY = "graph_context";

/** Call Huginn's `/api/search`. Throws on network error / non-2xx — callers in
 *  the corrective path treat that as "no re-query" (fail-soft). */
export async function searchKnowledge(
  query: string,
  opts: SearchKnowledgeOptions = {},
): Promise<KnowledgeSearchResponse> {
  const baseUrl = (opts.baseUrl ?? knowledgeApiBaseUrl()).replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("q", query);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.brief) params.set("brief", "true");
  if (opts.rerank !== undefined) params.set("rerank", String(opts.rerank));
  if (opts.minRelevance !== undefined) params.set("min_relevance", String(opts.minRelevance));
  if (opts.maxChunksPerDoc !== undefined) params.set("max_chunks_per_doc", String(opts.maxChunksPerDoc));
  for (const c of opts.collections ?? []) params.append("collection", c);

  const url = `${baseUrl}/api/search?${params.toString()}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
  if (!resp.ok) {
    throw new Error(`knowledge search returned ${resp.status} for ${query}`);
  }
  const data = (await resp.json()) as Record<string, unknown>;
  return normalizeResponse(data);
}

function normalizeResponse(data: Record<string, unknown>): KnowledgeSearchResponse {
  const rawResults = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
  const results: KnowledgeSearchResult[] = rawResults.map((r) => ({
    collection: String(r.collection ?? ""),
    id: String(r.id ?? ""),
    title: String(r.title ?? r.id ?? "(untitled)"),
    url: r.url ? String(r.url) : undefined,
    snippet: r.snippet ? String(r.snippet) : undefined,
    breadcrumb: r.breadcrumb ? String(r.breadcrumb) : undefined,
    heading: r.heading ? String(r.heading) : undefined,
    relevance: typeof r.relevance === "number" ? r.relevance : undefined,
    confidenceBand: isBand(r.confidenceBand) ? r.confidenceBand : undefined,
    modifiedTime: r.modifiedTime ? String(r.modifiedTime) : undefined,
    matchedChunks: Array.isArray(r.matchedChunks)
      ? (r.matchedChunks as Record<string, unknown>[]).map((c) => ({
          content: c.content ? String(c.content) : undefined,
          heading: c.heading ? String(c.heading) : undefined,
          relevance: typeof c.relevance === "number" ? c.relevance : undefined,
          metadata: isRecord(c.metadata) ? c.metadata : undefined,
        }))
      : undefined,
    metadata: isRecord(r.metadata) ? r.metadata : undefined,
    graphContext: Array.isArray(r[GRAPH_CONTEXT_KEY])
      ? (r[GRAPH_CONTEXT_KEY] as unknown[]).map(String)
      : undefined,
  }));

  return {
    results,
    bestScore: typeof data.bestScore === "number" ? data.bestScore : undefined,
    noConfidentResults: data.noConfidentResults === true,
    retryHints: parseRetryHints(data.retryHints),
    graphAnswer: data.graph_answer ? String(data.graph_answer) : undefined,
  };
}

function parseRetryHints(raw: unknown): KnowledgeRetryHints | undefined {
  if (!isRecord(raw)) return undefined;
  const hints: KnowledgeRetryHints = {};
  if (Array.isArray(raw.detectedEntities)) hints.detectedEntities = raw.detectedEntities.map(String);
  if (Array.isArray(raw.relatedTerms)) hints.relatedTerms = raw.relatedTerms.map(String);
  if (typeof raw.narrowerQuery === "string") hints.narrowerQuery = raw.narrowerQuery;
  if (typeof raw.broaderQuery === "string") hints.broaderQuery = raw.broaderQuery;
  return Object.keys(hints).length > 0 ? hints : undefined;
}

function isBand(v: unknown): v is ConfidenceBand {
  return v === "high" || v === "medium" || v === "low";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const INTERNAL_METADATA_KEYS = new Set(["page_id", "space", "breadcrumb", "title", "wip"]);

function isWip(r: Pick<KnowledgeSearchResult, "metadata">): boolean {
  return (r.metadata?.wip as unknown) === "true";
}

function formatRelevanceBand(r: KnowledgeSearchResult): string {
  if (r.relevance === undefined) return "";
  const pct = `${(r.relevance * 100).toFixed(1)}% relevant`;
  return ` (${pct}${r.confidenceBand ? ` · ${r.confidenceBand}` : ""})`;
}

function formatDate(iso?: string): string {
  return iso ? iso.slice(0, 10) : "";
}

function visibleMetaLine(metadata?: Record<string, unknown>): string {
  if (!metadata) return "";
  const entries = Object.entries(metadata).filter(([k, v]) => !INTERNAL_METADATA_KEYS.has(k) && v);
  if (entries.length === 0) return "";
  return `\n*${entries.map(([k, v]) => `${k}: ${v}`).join(" | ")}*`;
}

/**
 * Render search results in (approximately) the same shape Huginn's MCP adapter
 * uses for `brief=false` searches: `## title (NN% relevant · band)` header,
 * url, breadcrumb, the `collection: \`x\` doc_id: \`y\`` line, then the matched
 * chunks. Used to splice a corrective re-query's hits into the tool result the
 * model sees.
 */
export function renderSearchResults(results: KnowledgeSearchResult[]): string {
  return results
    .map((r) => {
      const date = r.modifiedTime ? ` | updated: ${formatDate(r.modifiedTime)}` : "";
      const wip = isWip(r) ? " **[UNDER ARBEID]**" : "";
      let header = `## ${r.title}${wip}${formatRelevanceBand(r)}${date}`;
      if (r.url) header += `\n${r.url}`;
      if (r.breadcrumb) header += `\n${r.breadcrumb}`;
      header += `\ncollection: \`${r.collection}\` doc_id: \`${r.id}\``;
      if (r.graphContext?.length) header += `\n*${r.graphContext.join(" | ")}*`;

      const bodyLines: string[] = [];
      const chunks = r.matchedChunks ?? [];
      if (chunks.length > 0) {
        for (const chunk of chunks) {
          if (chunk.heading) bodyLines.push(`**${chunk.heading}**`);
          if (chunk.content) bodyLines.push(chunk.content);
          const ml = visibleMetaLine(chunk.metadata);
          if (ml) bodyLines.push(ml.replace(/^\n/, ""));
        }
      } else if (r.snippet) {
        bodyLines.push(r.snippet);
      }
      return bodyLines.length > 0 ? `${header}\n\n${bodyLines.join("\n\n")}` : header;
    })
    .join("\n\n");
}

/** Render the Phase-0 `retryHints` / `noConfidentResults` footer, mirroring
 *  the MCP adapter — used when a re-query itself comes back empty/weak so the
 *  consolidated result still surfaces the next move. Returns "" when nothing
 *  useful applies. */
export function renderRetryHintsFooter(resp: Pick<KnowledgeSearchResponse, "retryHints" | "noConfidentResults">): string {
  const hints = resp.retryHints ?? {};
  const bits: string[] = [];
  if (hints.relatedTerms?.length) bits.push(`related terms: ${hints.relatedTerms.join(", ")}`);
  if (hints.narrowerQuery) bits.push(`narrower query: "${hints.narrowerQuery}"`);
  if (hints.broaderQuery) bits.push(`broader query: "${hints.broaderQuery}"`);
  if (bits.length === 0 && !resp.noConfidentResults) return "";
  const prefix = resp.noConfidentResults ? "No confident match" : "Weak match";
  return bits.length > 0 ? `\n\n*${prefix} — try: ${bits.join(" · ")}*` : `\n\n*${prefix}.*`;
}

/**
 * Patterns describing the signal Huginn's MCP adapter emits about result
 * quality (the renderer above produces the same shapes). Centralised here so
 * the grader, the orchestrator and the dashboard all read the same thing.
 *
 * - {@link NO_RESULTS_BODY_RE} — a "No results found for …" body (matches
 *   anywhere a line starts with it, so it still fires after merging).
 * - {@link WEAK_MATCH_FOOTER_RE} — a `*Weak match …*` / `*No confident match …*`
 *   line anywhere in the text (used for detection).
 * - {@link TRAILING_RETRY_FOOTER_RE} — the same footer anchored at end-of-string,
 *   with a capture group (used for stripping/extracting it).
 */
export const NO_RESULTS_BODY_RE = /(^|\n)\s*No results found for /;
export const WEAK_MATCH_FOOTER_RE = /(^|\n)\s*\*(?:No confident match|Weak match)\b/;
const TRAILING_RETRY_FOOTER_RE = /\n+\s*(\*(?:No confident match|Weak match)[^\n]*\*)\s*$/;

/** Huginn's weak-result relevance threshold — a `bestScore` below this means
 *  "found something, but nothing confidently relevant". Mirrors Huginn's
 *  `WEAK_RESULT_RELEVANCE`. */
export const WEAK_RESULT_RELEVANCE = 0.45;

/** Classify a rendered search-result text by the quality signal Huginn baked
 *  into it: `"empty"` (no results), `"weak"` (a weak/no-confident-match footer),
 *  or `null` (looks fine). */
export function classifyResultSignal(text: string): "empty" | "weak" | null {
  if (!text) return null;
  if (NO_RESULTS_BODY_RE.test(text)) return "empty";
  if (WEAK_MATCH_FOOTER_RE.test(text)) return "weak";
  return null;
}

/** Split a rendered result text into its body and trailing retry-hints footer
 *  (`""` when there's no footer). */
export function extractTrailingRetryFooter(text: string): { body: string; footer: string } {
  const m = text.match(TRAILING_RETRY_FOOTER_RE);
  if (!m) return { body: text, footer: "" };
  return { body: text.slice(0, m.index).trimEnd(), footer: m[1]! };
}

/** Strip a trailing retry-hints footer from a rendered result text. Used when
 *  splicing a corrective re-query in: the original "try X" footer is obsolete
 *  once X has been tried, and leaving it would also confuse the next signal-mode
 *  grade pass into re-detecting the *already-handled* weak signal. */
export function stripTrailingRetryFooter(text: string): string {
  return text.replace(TRAILING_RETRY_FOOTER_RE, "");
}

const DOC_ID_LINE_RE = /collection:\s*`([^`]+)`\s+doc_id:\s*`([^`]+)`/g;

/** Extract `collection/doc_id` keys from rendered search-result text — used to
 *  dedupe a corrective re-query against the original result the model already
 *  has (we don't re-fetch the original in structured form). The
 *  `collection: \`…\` doc_id: \`…\`` line is emitted by Huginn's MCP adapter
 *  for every hit and is stable. */
export function extractDocKeysFromRenderedText(text: string): Set<string> {
  const keys = new Set<string>();
  for (const m of text.matchAll(DOC_ID_LINE_RE)) {
    keys.add(`${m[1]}/${m[2]}`);
  }
  return keys;
}

export function docKey(r: Pick<KnowledgeSearchResult, "collection" | "id">): string {
  return `${r.collection}/${r.id}`;
}

/** Parse a `broader query: "..."` / `narrower query: "..."` hint out of a
 *  rendered "*No confident match — try: …*" footer. Belt-and-suspenders for the
 *  corrective re-query when the Haiku grader didn't supply a rewritten query. */
export function parseQueryHintsFromFooter(text: string): { broaderQuery?: string; narrowerQuery?: string } {
  const out: { broaderQuery?: string; narrowerQuery?: string } = {};
  const broader = text.match(/broader query:\s*"([^"]+)"/);
  if (broader) out.broaderQuery = broader[1];
  const narrower = text.match(/narrower query:\s*"([^"]+)"/);
  if (narrower) out.narrowerQuery = narrower[1];
  return out;
}

export { log as knowledgeSearchLog };
