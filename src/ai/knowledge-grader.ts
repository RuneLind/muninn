import { spawnHaiku } from "../scheduler/executor.ts";
import { extractJson } from "./json-extract.ts";
import type { Logger } from "@logtape/logtape";

/**
 * CRAG-style retrieval evaluator for the knowledge search tool. Given the
 * user's question and the (rendered) search results — which carry per-result
 * `confidenceBand` annotations and a `*No confident match — try: …*` footer
 * from Huginn's MCP adapter — a dedicated Haiku call decides whether the
 * results are good enough to answer from, and if not, proposes a sharper
 * query and/or a better collection.
 *
 * This is an **awaiting** Haiku call (it gates whether a corrective re-query
 * happens), so it uses {@link spawnHaiku} directly rather than the
 * fire-and-forget {@link runHaikuExtraction} pattern.
 *
 * Fail-soft: any Haiku error or unparseable output yields `verdict: "correct"`
 * — the corrective loop becomes a no-op and the model sees the original result
 * unchanged. The corrective feature must never make a search *worse*.
 *
 * Plan: `../mimir/plans/huginn-muninn-corrective-rag.md` (Phase 1).
 */

export type GradeVerdict = "correct" | "ambiguous" | "insufficient";

export interface KnowledgeGrade {
  verdict: GradeVerdict;
  /** A single search string (not a question) to re-query with. Present only
   *  when verdict is "ambiguous" or "insufficient" and the grader had a better
   *  query to offer. */
  rewrittenQuery?: string;
  /** A collection name to try instead — only when the results hint another
   *  collection is the right home. Never invented. */
  suggestedCollection?: string;
  /** One short sentence explaining the verdict. */
  reason: string;
}

export interface GradeKnowledgeOptions {
  question: string;
  /** The rendered search-result text the model would see (trace markers
   *  already peeled). */
  toolResultText: string;
  botName: string;
  /** Working directory for the Haiku spawn — keeps the session out of the
   *  project root and gives it the bot's MCP/settings context. */
  cwd?: string;
  log: Logger;
  /** Haiku model override (defaults to the project's standard Haiku model). */
  model?: string;
  timeoutMs?: number;
  /** Injectable for tests — defaults to {@link spawnHaiku}. */
  spawnFn?: typeof spawnHaiku;
}

/** Cap the result text fed into the grader prompt — keeps the Haiku call cheap
 *  and well under its context window. The trailing footer (retry hints) lives
 *  at the end of the text, so prefer keeping the head + tail. */
const MAX_RESULT_CHARS = 12_000;

export async function gradeKnowledgeResults(opts: GradeKnowledgeOptions): Promise<KnowledgeGrade> {
  const { question, botName, cwd, log } = opts;
  const resultText = clampResultText(opts.toolResultText);

  const prompt = buildGraderPrompt(question, resultText);

  const spawn = opts.spawnFn ?? spawnHaiku;
  let raw: string;
  try {
    const res = await spawn(prompt, {
      source: "knowledge-grader",
      entrypoint: `${botName}-knowledge-grader`,
      cwd,
      botName,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
    });
    raw = res.result;
  } catch (err) {
    log.warn("knowledge grader Haiku call failed — treating as 'correct': {error}", {
      botName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { verdict: "correct", reason: "grader unavailable" };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = extractJson<Record<string, unknown>>(raw);
  } catch {
    log.warn("knowledge grader: unparseable result — treating as 'correct': {raw}", {
      botName,
      raw: raw.slice(0, 300),
    });
    return { verdict: "correct", reason: "grader output unparseable" };
  }

  return normalizeGrade(parsed);
}

export function normalizeGrade(parsed: Record<string, unknown>): KnowledgeGrade {
  const verdict = parsed.verdict;
  const safeVerdict: GradeVerdict =
    verdict === "ambiguous" || verdict === "insufficient" ? verdict : "correct";

  const reason = typeof parsed.reason === "string" && parsed.reason.trim()
    ? parsed.reason.trim()
    : safeVerdict === "correct"
      ? "results cover the question"
      : "results do not clearly cover the question";

  const grade: KnowledgeGrade = { verdict: safeVerdict, reason };

  if (safeVerdict !== "correct") {
    const rq = typeof parsed.rewrittenQuery === "string" ? parsed.rewrittenQuery.trim() : "";
    if (rq) grade.rewrittenQuery = rq;
    const sc = typeof parsed.suggestedCollection === "string" ? parsed.suggestedCollection.trim() : "";
    if (sc) grade.suggestedCollection = sc;
  }

  return grade;
}

function clampResultText(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const head = Math.floor(MAX_RESULT_CHARS * 0.7);
  const tail = MAX_RESULT_CHARS - head;
  return `${text.slice(0, head)}\n…[${text.length - MAX_RESULT_CHARS} chars omitted]…\n${text.slice(-tail)}`;
}

function buildGraderPrompt(question: string, resultText: string): string {
  return `You grade the quality of knowledge-base search results before an assistant answers from them.

USER QUESTION:
${question}

SEARCH RESULTS (each hit is annotated with a confidence band — high / medium / low; a trailing "No confident match" or "Weak match" line, if present, means the search itself was unsure):
${resultText || "(no results were returned)"}

Decide whether these results let the question be answered well, then respond with ONLY a JSON object — no prose, no markdown fence:
{"verdict":"correct"|"ambiguous"|"insufficient","rewrittenQuery":"...","suggestedCollection":"...","reason":"..."}

Guidance:
- "correct": at least one clearly on-topic, reasonably-confident result covers the question. No re-query needed. Omit rewrittenQuery and suggestedCollection.
- "ambiguous": results are partially relevant but the query was too broad, too narrow, or worded differently than the indexed content; a sharper query would likely find better hits.
- "insufficient": nothing on-topic, or only low-confidence / off-topic snippets, or no results at all.
- rewrittenQuery: a single concise SEARCH STRING (keywords / phrase), NOT a question. Only when verdict is "ambiguous" or "insufficient". If you cannot improve on the query, omit it.
- suggestedCollection: only set it if the results clearly hint a different collection is the right home for this topic. Never invent a collection name.
- reason: one short sentence.`;
}
