/**
 * HTTP client for the Knowledge API Server.
 * Searches vector-indexed company knowledge (Notion pages, etc.)
 * and returns formatted results for injection into AI prompts.
 */

import { getLog } from "../logging.ts";

const log = getLog("ai", "knowledge");
let knowledgeApiUrl = "http://localhost:8321";
const KNOWLEDGE_TIMEOUT_MS = 3000;

/** Configure the Knowledge API URL from centralized config. Call once at startup. */
export function configureKnowledgeSearch(apiUrl: string): void {
  knowledgeApiUrl = apiUrl;
}

interface KnowledgeChunk {
  content: string;
  score: number;
}

interface KnowledgeResult {
  collection: string;
  id: string;
  title: string;
  url: string;
  matchedChunks: KnowledgeChunk[];
}

interface KnowledgeSearchResponse {
  results: KnowledgeResult[];
}

export interface KnowledgeSearchResult {
  results: KnowledgeResult[];
  searchMs: number;
}

/**
 * Search company knowledge base via the Knowledge API.
 * Returns empty results silently if the API is unreachable (knowledge is supplementary).
 */
export async function searchKnowledge(
  query: string,
  collections?: string[],
  limit: number = 5,
): Promise<KnowledgeSearchResult> {
  const t0 = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KNOWLEDGE_TIMEOUT_MS);

  try {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (collections?.length) {
      for (const c of collections) params.append("collection", c);
    }

    const response = await fetch(`${knowledgeApiUrl}/api/search?${params}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      log.warn("API returned {status}", { status: response.status });
      return { results: [], searchMs: performance.now() - t0 };
    }

    const data = (await response.json()) as KnowledgeSearchResponse;
    return { results: data.results ?? [], searchMs: performance.now() - t0 };
  } catch (e) {
    clearTimeout(timeout);
    // Fail silently — knowledge is supplementary, not critical
    const isAbort = e instanceof DOMException && e.name === "AbortError";
    if (!isAbort) {
      log.warn("API unreachable: {error}", { error: e instanceof Error ? e.message : String(e) });
    } else {
      log.warn("API timeout after {ms}ms", { ms: KNOWLEDGE_TIMEOUT_MS });
    }
    return { results: [], searchMs: performance.now() - t0 };
  }
}

/**
 * Format knowledge results for inclusion in an AI system prompt.
 */
export function formatKnowledgeResults(results: KnowledgeResult[]): string {
  if (results.length === 0) return "";

  const items = results.map((r) => {
    const bestChunk = r.matchedChunks[0];
    const snippet = bestChunk
      ? truncate(bestChunk.content.replace(/\n+/g, " ").trim(), 200)
      : "";
    const link = r.url ? `${r.title} (${r.url})` : r.title;
    return `- ${link} — ${snippet}`;
  });

  return `Relevant company knowledge (from Notion):\n${items.join("\n")}`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + "...";
}
