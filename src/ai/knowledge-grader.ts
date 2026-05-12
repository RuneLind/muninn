import { spawnHaiku } from "../scheduler/executor.ts";
import { extractJson } from "./json-extract.ts";
import { classifyResultSignal, extractTrailingRetryFooter } from "./knowledge-search-client.ts";
import type { Logger } from "@logtape/logtape";

/**
 * Retrieval-quality judges for the knowledge search tool, used by the
 * corrective-retrieval loop (see corrective-retrieval.ts):
 *
 *   - {@link gradeFromSignal} — the **default**: no model call. Just reads the
 *     cheap signal Huginn already emits (a `*Weak match …*` / `*No confident
 *     match …*` footer, or a "No results found" body) and returns `insufficient`
 *     when the search itself was unsure, `correct` otherwise. The re-query, when
 *     one happens, uses Huginn's own `retryHints` (parsed from that footer).
 *   - {@link gradeKnowledgeResults} — opt-in (`correctiveRetrieval.grader:
 *     "haiku"`): a slimmed **awaiting** Haiku call that also reads the result
 *     snippets and can propose a semantic rewrite / a better collection. Costs
 *     ~3–5s per search, so it's not the default.
 *
 * Both are fail-soft: a Haiku error or unparseable output → `verdict: "correct"`
 * (the corrective loop becomes a no-op and the model sees the original result
 * unchanged). The corrective feature must never make a search *worse*.
 */

export type GradeVerdict = "correct" | "ambiguous" | "insufficient";

export interface KnowledgeGrade {
  verdict: GradeVerdict;
  /** A single search string (not a question) to re-query with. Present only in
   *  Haiku mode when the grader had a better query to offer; signal mode never
   *  sets it (the re-query query comes from Huginn's `retryHints` instead). */
  rewrittenQuery?: string;
  /** A collection name to try instead — only when the results hint another
   *  collection is the right home. Never invented. Haiku mode only. */
  suggestedCollection?: string;
  /** One short sentence explaining the verdict. */
  reason: string;
}

// ── Signal grader (default — no model call) ────────────────────────────────

/**
 * Judge a search result purely from Huginn's emitted signal — no LLM. Returns
 * `insufficient` (no rewritten query — the corrective loop will fall back to
 * the `retryHints.broaderQuery` / `narrowerQuery` parsed from the footer) when
 * Huginn flagged the result weak/empty, `correct` otherwise.
 */
export function gradeFromSignal(resultText: string): KnowledgeGrade {
  switch (classifyResultSignal(resultText ?? "")) {
    case "empty":
      return { verdict: "insufficient", reason: "search returned no results" };
    case "weak":
      return { verdict: "insufficient", reason: "Huginn flagged the result as low confidence" };
    default:
      return { verdict: "correct", reason: "no low-confidence signal from the search" };
  }
}

// ── Haiku grader (opt-in) ──────────────────────────────────────────────────

export interface GradeKnowledgeOptions {
  question: string;
  /** The rendered search-result text the model would see (trace markers
   *  already peeled). Digested down to the top hits before being sent to Haiku. */
  toolResultText: string;
  botName: string;
  /** Working directory for the Haiku spawn — keeps the session out of the
   *  project root. */
  cwd?: string;
  log: Logger;
  /** Haiku model override (defaults to the project's standard Haiku model). */
  model?: string;
  timeoutMs?: number;
  /** Injectable for tests — defaults to {@link spawnHaiku}. */
  spawnFn?: typeof spawnHaiku;
}

/** Cap the (already-digested) result text fed into the grader prompt. Kept
 *  small so the Haiku call stays in the ~3–5s range rather than ~10s+. */
const MAX_GRADER_INPUT_CHARS = 4_000;

export async function gradeKnowledgeResults(opts: GradeKnowledgeOptions): Promise<KnowledgeGrade> {
  const { question, botName, cwd, log } = opts;
  const digest = digestResultsForGrading(opts.toolResultText);

  const prompt = buildGraderPrompt(question, digest);

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

/**
 * Reduce a full rendered result text to a compact digest for the Haiku grader:
 * the top result blocks (header line with title + confidence band, the
 * breadcrumb/url line, and a short prefix of the body) plus the trailing
 * weak-match footer if present. Keeps the prompt small without dropping the
 * signal the grader needs (titles + bands + a taste of each hit + whether the
 * search flagged itself unsure).
 */
export function digestResultsForGrading(text: string): string {
  const src = (text ?? "").trim();
  if (!src) return "";

  // Pull off the trailing weak-match footer so it's never lost to truncation.
  const { body, footer } = extractTrailingRetryFooter(src);

  // Split into result blocks at `## ` headers (the MCP adapter's full-mode
  // format). If there are no `## ` headers (brief mode uses `1. **Title**`),
  // just take the head of the body.
  const blocks = body.split(/\n(?=## )/);
  const digestedBlocks: string[] = [];
  let used = 0;
  for (const block of blocks) {
    if (used >= MAX_GRADER_INPUT_CHARS) break;
    const lines = block.split("\n");
    // Header + the next couple of lines (url / breadcrumb / collection), then a
    // short prefix of whatever follows.
    const headLines = lines.slice(0, 4).join("\n");
    const rest = lines.slice(4).join("\n").replace(/\n{2,}/g, "\n").trim();
    const restPrefix = rest.length > 240 ? rest.slice(0, 240) + "…" : rest;
    const piece = restPrefix ? `${headLines}\n${restPrefix}` : headLines;
    digestedBlocks.push(piece);
    used += piece.length;
  }

  let out = digestedBlocks.join("\n\n");
  if (out.length > MAX_GRADER_INPUT_CHARS) {
    out = out.slice(0, MAX_GRADER_INPUT_CHARS) + "\n…[truncated]…";
  }
  if (footer) out = `${out}\n\n${footer}`;
  return out;
}

function buildGraderPrompt(question: string, resultDigest: string): string {
  return `You grade the quality of knowledge-base search results before an assistant answers from them.

USER QUESTION:
${question}

SEARCH RESULTS (top hits — each annotated with a confidence band: high / medium / low; a trailing "No confident match" or "Weak match" line, if present, means the search itself was unsure):
${resultDigest || "(no results were returned)"}

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
