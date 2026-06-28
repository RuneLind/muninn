/**
 * Pure synthesis + citation helpers for the Research layer.
 *
 * `researchKnowledge` retrieves and ranks hits across the corpus; it does NOT
 * write a prose answer. These helpers turn the ranked hits into (a) a numbered
 * citation list the UI can open in the doc panel and (b) the synthesis prompt
 * fed to one Claude call. Kept side-effect-free so they unit-test without a live
 * Huginn or a `claude` spawn.
 */

import type { ResearchHit } from "../ai/research-knowledge.ts";
import { badgeForCollection, getResearchCollection } from "./corpus.ts";

/** Default number of top-ranked hits handed to the model as numbered sources. */
export const DEFAULT_MAX_SOURCES = 8;

/** Chars of a hit's best chunk to include as the source snippet in the prompt. */
const SNIPPET_CHARS = 1200;

/** Shown verbatim when retrieval finds nothing — we never synthesize on no hits. */
export const NO_HITS_MESSAGE =
  "I couldn't find anything in the knowledge base that covers this. " +
  "The Research corpus spans the Anthropic firehose, the curated Claude/YouTube/X summaries, " +
  "and the wiki — try rephrasing, or this topic may simply not be indexed yet.";

export interface Citation {
  /** 1-based index used in the prompt and the inline `[n]` markers. */
  n: number;
  collection: string;
  /** Huginn doc id — the doc panel opens `/api/search/document/<collection>/<docId>`. */
  docId: string;
  title: string;
  url?: string;
  /** Corpus badge (e.g. "Claude", "Wiki") for the citation row. */
  badge: string;
  /** Summary-source id when the collection is also a shelf (for cross-links). */
  sourceId?: string;
  /** Best relevance across the sub-questions that surfaced this doc. */
  relevance: number;
  /** First matched chunk text — the context the model summarizes from. */
  snippet?: string;
}

/** Pull the best chunk's text off a hit (mirrors research-knowledge's private extractor). */
function firstChunkText(hit: ResearchHit): string | undefined {
  const chunk = Array.isArray(hit.matchedChunks) ? hit.matchedChunks[0] : undefined;
  if (chunk && typeof chunk === "object" && "content" in chunk) {
    const content = (chunk as { content?: unknown }).content;
    if (typeof content === "string" && content.trim()) return content.trim();
  }
  return undefined;
}

/** A readable title — fall back to the doc id's basename (sans `.md`) when absent. */
function titleFor(hit: ResearchHit): string {
  if (hit.title && hit.title.trim()) return hit.title.replace(/\.md$/, "");
  const base = hit.id.split("/").pop() ?? hit.id;
  return base.replace(/\.md$/, "");
}

/**
 * Turn ranked hits into a numbered citation list (top `maxSources`, in rank
 * order). Snippets are truncated so a wide retrieval can't blow the synthesis
 * prompt.
 */
export function buildCitations(hits: ResearchHit[], maxSources = DEFAULT_MAX_SOURCES): Citation[] {
  return hits.slice(0, maxSources).map((hit, i) => {
    const meta = getResearchCollection(hit.collection);
    const snippet = firstChunkText(hit);
    return {
      n: i + 1,
      collection: hit.collection,
      docId: hit.id,
      title: titleFor(hit),
      url: hit.url,
      badge: badgeForCollection(hit.collection),
      sourceId: meta?.sourceId,
      relevance: typeof hit.relevance === "number" ? hit.relevance : 0,
      snippet: snippet ? truncate(snippet, SNIPPET_CHARS) : undefined,
    };
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export const SYNTHESIS_SYSTEM_PROMPT = `You answer questions about Anthropic and the Claude ecosystem for a personal learning center, using ONLY the numbered sources provided in the user message.

Rules:
- Ground every claim in the sources. After each claim, cite the source(s) you used with bracketed numbers like [1] or [2][3]. Cite the specific source, not a range.
- Do NOT use any tools or outside knowledge — answer solely from the provided sources.
- If the sources do not actually answer the question, say so plainly in one sentence instead of guessing. Never invent details, URLs, or version numbers.
- Be concise and direct. Use markdown: short paragraphs, bullet points for lists, **bold** for key terms. Lead with the answer, not a preamble.`;

/** Render the numbered sources block fed to the model alongside the question. */
export function renderSourcesBlock(citations: Citation[]): string {
  return citations
    .map((c) => {
      const head = `[${c.n}] (${c.badge}) ${c.title}${c.url ? ` — ${c.url}` : ""}`;
      return c.snippet ? `${head}\n${c.snippet}` : head;
    })
    .join("\n\n");
}

/** Build the user prompt: the question, then the numbered sources to cite. */
export function buildSynthesisUserPrompt(question: string, citations: Citation[]): string {
  return `Question: ${question}

Answer the question using only these numbered sources. Cite with [n].

${renderSourcesBlock(citations)}`;
}

/** Extract the distinct citation indices actually referenced in an answer. */
export function citedIndices(answer: string): number[] {
  const found = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}
