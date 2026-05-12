import type { Logger } from "@logtape/logtape";
import { gradeKnowledgeResults, type GradeVerdict, type KnowledgeGrade } from "./knowledge-grader.ts";
import {
  searchKnowledge,
  renderSearchResults,
  renderRetryHintsFooter,
  extractDocKeysFromRenderedText,
  parseQueryHintsFromFooter,
  docKey,
  type KnowledgeSearchResponse,
} from "./knowledge-search-client.ts";

/**
 * CRAG-lite corrective loop around the knowledge search tool. After a bot's
 * `search_knowledge` call returns, this:
 *
 *   1. Grades the result with Haiku ({@link gradeKnowledgeResults}).
 *   2. If the verdict is "ambiguous" / "insufficient" and the retry budget
 *      isn't spent, re-queries Huginn's `/api/search` with the grader's
 *      rewritten query (falling back to the Phase-0 `retryHints.broaderQuery` /
 *      `narrowerQuery` parsed from the result footer), optionally redirected to
 *      a `suggestedCollection`, forcing `rerank=true` so the re-query's
 *      `confidenceBand`s are trustworthy.
 *   3. Merges the fresh hits into the original result text — deduped against
 *      it by `collection/doc_id` — with an inline note explaining the retry.
 *   4. Optionally re-grades and retries again, up to the (clamped 1–2) budget;
 *      never recursive.
 *
 * Returns the consolidated text to feed the model plus a `corrective` metadata
 * block for tracing (`{retries, verdicts, reasons, queriesTried, finalVerdict}`).
 *
 * Fail-soft throughout: a grader that can't be reached returns "correct" (no
 * change); a re-query HTTP error ends the loop with whatever's accumulated. The
 * caller is expected to gate on the per-bot toggle — this function assumes the
 * feature is enabled and `budget >= 1`.
 *
 * Plan: `../mimir/plans/huginn-muninn-corrective-rag.md` (Phase 1).
 */

export interface CorrectiveMetadata {
  /** Number of re-queries actually issued (0–budget). */
  retries: number;
  /** Grader verdict from each grading pass, in order (length = retries + 1). */
  verdicts: GradeVerdict[];
  /** Grader reason from each grading pass, parallel to `verdicts`. */
  reasons: string[];
  /** The re-query strings actually issued (excludes the original query). */
  queriesTried: string[];
  /** Collections each re-query was scoped to (parallel to `queriesTried`);
   *  `undefined` entry = searched all collections. */
  collectionsTried: (string[] | undefined)[];
  /** The verdict from the last grading pass — i.e. whether the corrective
   *  pass left the result set in good shape. */
  finalVerdict: GradeVerdict;
  /** Total wall time spent in the Haiku grader across all passes, ms. */
  graderMs: number;
  /** Wall time of each re-query HTTP call, parallel to `queriesTried`, ms. */
  requeryMs: number[];
}

export interface CorrectiveOutcome {
  /** Tool-result text to feed back to the model. Equal to `originalResultText`
   *  when nothing changed. */
  text: string;
  /** True when `text` differs from `originalResultText` (i.e. results were
   *  merged in). */
  changed: boolean;
  metadata: CorrectiveMetadata;
}

export interface CorrectiveRetrievalContext {
  /** The user's information need — used to grade relevance. Typically the
   *  current user turn (trimmed). */
  question: string;
  /** The search query the model issued (from the tool call's args). Used to
   *  avoid re-issuing an identical query. */
  originalQuery: string;
  /** Collection(s) the model restricted the original search to, if any. */
  originalCollections?: string[];
  /** The rendered, trace-marker-peeled tool result the model would otherwise
   *  see. */
  originalResultText: string;
  /** Max re-queries. Clamped to [1, 2]. The caller gates on the per-bot
   *  toggle; this function only sees enabled invocations. */
  budget: number;
  botName: string;
  /** Working directory for the grader's Haiku spawn. */
  cwd?: string;
  log: Logger;
  /** Haiku model override for the grader. */
  graderModel?: string;
  graderTimeoutMs?: number;
  /** Injectable for tests. */
  searchFn?: typeof searchKnowledge;
  gradeFn?: typeof gradeKnowledgeResults;
}

export async function runCorrectiveRetrieval(ctx: CorrectiveRetrievalContext): Promise<CorrectiveOutcome> {
  const budget = Math.max(1, Math.min(2, Math.floor(ctx.budget)));
  const search = ctx.searchFn ?? searchKnowledge;
  const grade = ctx.gradeFn ?? gradeKnowledgeResults;
  const { question, originalQuery, originalResultText, botName, cwd, log } = ctx;

  let currentText = originalResultText;
  let currentCollections = ctx.originalCollections;
  let lastQuery = originalQuery;

  const verdicts: GradeVerdict[] = [];
  const reasons: string[] = [];
  const queriesTried: string[] = [];
  const collectionsTried: (string[] | undefined)[] = [];
  const requeryMs: number[] = [];
  let graderMs = 0;
  let retries = 0;

  for (;;) {
    let g: KnowledgeGrade;
    const gradeStart = performance.now();
    try {
      g = await grade({
        question,
        toolResultText: currentText,
        botName,
        cwd,
        log,
        model: ctx.graderModel,
        timeoutMs: ctx.graderTimeoutMs,
      });
    } catch (err) {
      log.warn("corrective: grader threw — stopping with current results: {error}", {
        botName,
        error: err instanceof Error ? err.message : String(err),
      });
      g = { verdict: "correct", reason: "grader error" };
    }
    graderMs += performance.now() - gradeStart;
    verdicts.push(g.verdict);
    reasons.push(g.reason);

    if (g.verdict === "correct" || retries >= budget) break;

    const nextQuery = pickRetryQuery(g, currentText, { lastQuery, originalQuery, queriesTried });
    if (!nextQuery) break;

    const collections = g.suggestedCollection ? [g.suggestedCollection] : currentCollections;

    let resp: KnowledgeSearchResponse;
    const requeryStart = performance.now();
    try {
      resp = await search(nextQuery, {
        collections,
        rerank: true,
        limit: 10,
        maxChunksPerDoc: 2,
      });
    } catch (err) {
      log.warn("corrective: re-query failed for {query} — stopping: {error}", {
        botName,
        query: nextQuery,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }

    retries++;
    queriesTried.push(nextQuery);
    collectionsTried.push(collections);
    requeryMs.push(Math.round(performance.now() - requeryStart));
    lastQuery = nextQuery;

    const existing = extractDocKeysFromRenderedText(currentText);
    const fresh = resp.results.filter((r) => r.id && r.collection && !existing.has(docKey(r)));
    if (fresh.length === 0) {
      // The re-query surfaced nothing new (or nothing at all). Don't append a
      // confirmation block — keep the model's context clean. The trace still
      // records the attempt via `queriesTried`.
      log.info("corrective: re-query {query} added no new documents", { botName, query: nextQuery });
      break;
    }

    const note = buildCorrectiveNote({
      retryNum: retries,
      verdict: g.verdict,
      reason: g.reason,
      query: nextQuery,
      collections,
      freshCount: fresh.length,
    });
    currentText = `${currentText}\n\n---\n${note}\n\n${renderSearchResults(fresh)}${renderRetryHintsFooter(resp)}`;
    currentCollections = collections;
  }

  return {
    text: currentText,
    changed: currentText !== originalResultText,
    metadata: {
      retries,
      verdicts,
      reasons,
      queriesTried,
      collectionsTried,
      finalVerdict: verdicts[verdicts.length - 1] ?? "correct",
      graderMs: Math.round(graderMs),
      requeryMs,
    },
  };
}

function pickRetryQuery(
  grade: KnowledgeGrade,
  resultText: string,
  used: { lastQuery: string; originalQuery: string; queriesTried: string[] },
): string | null {
  const footer = parseQueryHintsFromFooter(resultText);
  const candidates = [grade.rewrittenQuery, footer.broaderQuery, footer.narrowerQuery]
    .map((q) => (typeof q === "string" ? q.trim() : ""))
    .filter((q) => q.length > 0);
  for (const q of candidates) {
    if (q === used.lastQuery || q === used.originalQuery || used.queriesTried.includes(q)) continue;
    return q;
  }
  return null;
}

function buildCorrectiveNote(args: {
  retryNum: number;
  verdict: GradeVerdict;
  reason: string;
  query: string;
  collections?: string[];
  freshCount: number;
}): string {
  const scope = args.collections?.length ? ` in collection${args.collections.length > 1 ? "s" : ""} ${args.collections.join(", ")}` : "";
  const plural = args.freshCount === 1 ? "result" : "results";
  return (
    `[corrective retrieval — re-query #${args.retryNum}: prior results graded "${args.verdict}" ` +
    `(${args.reason}); re-searched "${args.query}"${scope}; ${args.freshCount} additional ${plural} below, ` +
    `deduped against the results above]`
  );
}
