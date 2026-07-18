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

/**
 * One prior Q&A turn carried into a follow-up for context. The Research layer is
 * multi-turn but **stateless on the server** — the page holds the running turns
 * in memory and replays a compact, bounded history with each follow-up, so no DB
 * thread or persistence is involved (see ask.ts / research-routes.ts).
 */
export interface ResearchTurn {
  question: string;
  answer: string;
}

/** Cap on prior turns folded into a follow-up (keeps the prompt + the GET URL bounded). */
export const MAX_HISTORY_TURNS = 4;

/** Chars of each prior answer kept as follow-up context in the synthesis prompt. */
const HISTORY_ANSWER_CHARS = 700;

/** Shown verbatim when retrieval finds nothing — we never synthesize on no hits. */
export const NO_HITS_MESSAGE =
  "I couldn't find anything in the knowledge base that covers this. " +
  "The Research corpus spans the Anthropic firehose, the curated Claude/YouTube/X summaries, " +
  "and the wiki — try rephrasing, or this topic may simply not be indexed yet.";

/**
 * Shown when retrieval returned *some* documents but every sub-search came back
 * weak (Huginn's raw-score `lowConfidence` flag). Semantic search almost always
 * surfaces a nearest neighbour, so we'd rather decline than synthesize a
 * confident-looking answer from loosely-related material. The weak sources are
 * still shown so the reader can judge them.
 */
export const LOW_CONFIDENCE_MESSAGE =
  "The closest matches on the shelf don't confidently cover this, so I'd rather not " +
  "synthesize an answer that isn't well-grounded. The nearest documents are listed below — " +
  "open them to judge for yourself, or try rephrasing toward what's actually indexed.";

/**
 * Coverage verdict for a retrieval pass:
 * - `answer`         — at least one sub-search confidently retrieved → synthesize.
 * - `no_hits`        — nothing survived Huginn's noise filter → canned no-coverage.
 * - `low_confidence` — documents came back but every sub-search was flagged weak.
 *
 * The honest relevance floor lives here. The exposed `relevance` field is NOT a
 * usable threshold: Huginn skips the cross-encoder reranker for English queries
 * (cross-lingual score collapse), so `relevance` is rank-based (top hit ≈ 0.75
 * regardless of the query) and a numeric floor would never fire. The real
 * raw-score signal is Huginn's per-search `lowConfidence` (computed from
 * `LOW_CONFIDENCE_THRESHOLD` before rank-normalization), which is what we gate on.
 */
export type Coverage = "answer" | "no_hits" | "low_confidence";

export interface CoverageInput {
  /** Merged unique-document count, after Huginn's noise filter. */
  hitCount: number;
  /** Per-sub-question diagnostics — `lowConfidence` is the raw-score signal. */
  subSearches: Array<{ resultCount: number; lowConfidence?: boolean }>;
}

export function assessCoverage(input: CoverageInput): Coverage {
  if (input.hitCount === 0) return "no_hits";
  const withResults = input.subSearches.filter((s) => s.resultCount > 0);
  if (withResults.length === 0) return "no_hits";
  // Confident if any sub-search that returned documents was NOT flagged weak.
  const anyConfident = withResults.some((s) => !s.lowConfidence);
  return anyConfident ? "answer" : "low_confidence";
}

/** The canned reply for a non-answer verdict (used by the no-synthesis paths). */
export function coverageMessage(coverage: Exclude<Coverage, "answer">): string {
  return coverage === "low_confidence" ? LOW_CONFIDENCE_MESSAGE : NO_HITS_MESSAGE;
}

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
  /** When this citation's doc resolves to a page in a registered wiki, the wiki's
   *  canonical name — set by `enrichCitationsWithPages` (wiki/citation-links.ts).
   *  Lets the UI render an in-reader page link. */
  wikiName?: string;
  /** The matched wiki page name (see `wikiName`) — the `?page=` target in the
   *  `/wiki` reader. Present only alongside `wikiName`. */
  pageName?: string;
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

/**
 * The presentational block-component vocabulary + restraint + grammar block,
 * shared verbatim between research synthesis and (opt-in) chat prompts. Ends at
 * the corpus-agnostic grammar rules; the research-specific "Keep [n] citations…"
 * sentence is re-appended only by {@link SYNTHESIS_RULES_BODY} (chat answers have
 * no [n] citations, so chat bots must not be taught a citation rule).
 */
export const COMPONENT_VOCABULARY_RULES = `You may optionally use a few presentational block components to highlight structure. They are seasoning, not scaffolding — use at most 2-3 in an answer (only a genuine side-by-side comparison justifies more), and never wrap the whole answer in them. When in doubt, leave them out and write plain markdown.
- <Callout tone="info|good|warn|bad" title="...">…</Callout> — a caveat, a TL;DR, or a highlighted note.
- <Verdict value="yes|no">short label</Verdict> — a direct yes/no judgment.
- <ComparisonTable>…</ComparisonTable> — wraps a normal markdown pipe table (its own lines between the tags) when the answer compares options side by side.
- <Pill tone="rec|warn">label</Pill> — a small status/tag chip. <Figure caption="...">…</Figure> — a captioned block. <FileRef path="src/x.ts" /> — a file-path reference.
Grammar (strict — break it and the tag renders as visible text): put each opening and closing tag on its own line, flush to the left margin; never place a tag inside a sentence, a list item, or a paragraph (they are block-level only). Use double-quoted attribute values.`;

/**
 * The shared rules body appended after the (corpus-specific) framing line. Kept
 * verbatim across every consumer so only the opening sentence changes per corpus.
 */
const SYNTHESIS_RULES_BODY = `Rules:
- Ground every claim in the sources. After each claim, cite the source(s) you used with bracketed numbers like [1] or [2][3]. Cite the specific source, not a range.
- Do NOT use any tools or outside knowledge — answer solely from the provided sources.
- If the sources do not actually answer the question, say so plainly in one sentence instead of guessing. Never invent details, URLs, or version numbers.
- This may be a follow-up in an ongoing conversation. When a "Conversation so far" block is present, use it ONLY to resolve what the new question refers to (pronouns, "that", "it") — still ground every claim in the numbered sources, never cite or treat the prior turns as fact.
- Be concise and direct. Use markdown: short paragraphs, bullet points for lists, **bold** for key terms. Lead with the answer, not a preamble.

${COMPONENT_VOCABULARY_RULES} Keep [n] citations in the surrounding prose, not inside the tags.`;

/**
 * Build a synthesis system prompt: a corpus-specific `framingLine` (the opening
 * sentence naming what the sources cover) followed by the shared rules body. The
 * wiki Ask route passes a per-wiki framing so the answer is scoped to that wiki;
 * `/research` uses {@link SYNTHESIS_SYSTEM_PROMPT} (the Learning-Center framing).
 */
export function buildSynthesisSystemPrompt(framingLine: string): string {
  return `${framingLine}\n\n${SYNTHESIS_RULES_BODY}`;
}

/** The `/research` (Claude Learning Center) synthesis prompt — the default. */
export const SYNTHESIS_SYSTEM_PROMPT = buildSynthesisSystemPrompt(
  "You answer questions about Anthropic and the Claude ecosystem for a personal learning center, using ONLY the numbered sources provided in the user message.",
);

/**
 * Retrieval query for a turn. With no history it's the question verbatim, so the
 * single-shot retrieval path is byte-for-byte unchanged. On a follow-up we prepend
 * the most recent prior question(s) so the decomposer can resolve references
 * ("does it support MCP?") into a query that actually retrieves — retrieval is the
 * part that suffers most from a context-free follow-up. Prior *answers* are left
 * out here to keep the retrieval query lean; they ride into the synthesis prompt.
 */
export function buildRetrievalQuestion(question: string, history: ResearchTurn[] = []): string {
  const priorQuestions = history
    .slice(-2)
    .map((t) => t.question.trim())
    .filter(Boolean);
  if (priorQuestions.length === 0) return question;
  const context = priorQuestions.map((q) => `"${q}"`).join(" then ");
  return `Earlier in this conversation the user asked ${context}. Now answer this follow-up, resolving any references to that earlier context: ${question}`;
}

/** Render prior turns as a compact "conversation so far" block for synthesis context. */
export function renderHistoryBlock(history: ResearchTurn[]): string {
  return history
    .slice(-MAX_HISTORY_TURNS)
    .map((t, i) => `Q${i + 1}: ${t.question.trim()}\nA${i + 1}: ${truncate(t.answer.trim(), HISTORY_ANSWER_CHARS)}`)
    .join("\n\n");
}

/** Render the numbered sources block fed to the model alongside the question. */
export function renderSourcesBlock(citations: Citation[]): string {
  return citations
    .map((c) => {
      const head = `[${c.n}] (${c.badge}) ${c.title}${c.url ? ` — ${c.url}` : ""}`;
      return c.snippet ? `${head}\n${c.snippet}` : head;
    })
    .join("\n\n");
}

/**
 * Build the user prompt: the question, then the numbered sources to cite. On a
 * follow-up (non-empty `history`) a compact "Conversation so far" block is
 * prepended so the model can resolve references — but the answer is still grounded
 * only in the numbered sources (see {@link SYNTHESIS_SYSTEM_PROMPT}). With empty
 * history the output is identical to the single-shot prompt.
 */
export function buildSynthesisUserPrompt(
  question: string,
  citations: Citation[],
  history: ResearchTurn[] = [],
): string {
  const sources = renderSourcesBlock(citations);
  if (history.length === 0) {
    return `Question: ${question}

Answer the question using only these numbered sources. Cite with [n].

${sources}`;
  }
  return `Conversation so far (for context only — do NOT cite these prior turns; answer solely from the numbered sources below):

${renderHistoryBlock(history)}

Follow-up question: ${question}

Answer the follow-up using only these numbered sources. Cite with [n]. Use the conversation above only to understand what the follow-up refers to.

${sources}`;
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
