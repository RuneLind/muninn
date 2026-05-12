import { test, expect, describe } from "bun:test";
import { runCorrectiveRetrieval } from "./corrective-retrieval.ts";
import type { KnowledgeGrade } from "./knowledge-grader.ts";
import type { KnowledgeSearchResponse, KnowledgeSearchResult } from "./knowledge-search-client.ts";
import { renderSearchResults } from "./knowledge-search-client.ts";
import { getLog } from "../logging.ts";

const log = getLog("test", "corrective-retrieval");

function result(over: Partial<KnowledgeSearchResult> & { id: string; collection: string }): KnowledgeSearchResult {
  return {
    title: `Doc ${over.id}`,
    relevance: 0.7,
    confidenceBand: "high",
    matchedChunks: [{ content: `body of ${over.id}` }],
    ...over,
  };
}

function searchResponse(results: KnowledgeSearchResult[], over: Partial<KnowledgeSearchResponse> = {}): KnowledgeSearchResponse {
  return { results, bestScore: results[0]?.relevance, ...over };
}

/** A grader stub that returns the given verdicts in sequence (last one repeats). */
function gradeSequence(...grades: KnowledgeGrade[]) {
  let i = 0;
  return async () => grades[Math.min(i++, grades.length - 1)]!;
}

/** A search stub that returns the given responses in sequence (last one repeats),
 *  recording the queries it was called with. */
function searchSequence(...responses: KnowledgeSearchResponse[]) {
  const calls: { query: string; collections?: string[] }[] = [];
  let i = 0;
  const fn = async (query: string, opts?: { collections?: string[] }) => {
    calls.push({ query, collections: opts?.collections });
    return responses[Math.min(i++, responses.length - 1)]!;
  };
  return Object.assign(fn, { calls });
}

const baseCtx = {
  question: "what SEDs belong to LA_BUC_02?",
  originalQuery: "LA_BUC_02",
  botName: "test",
  log,
};

describe("runCorrectiveRetrieval", () => {
  test("verdict 'correct' → no re-query, text unchanged", async () => {
    const search = searchSequence(searchResponse([result({ id: "1", collection: "wiki" })]));
    const out = await runCorrectiveRetrieval({
      ...baseCtx,
      originalResultText: "## Original (80% relevant · high)\ncollection: `wiki` doc_id: `1`\n\nbody",
      budget: 1,
      gradeFn: gradeSequence({ verdict: "correct", reason: "covered" }),
      searchFn: search,
    });
    expect(out.changed).toBe(false);
    expect(out.text).toContain("## Original");
    expect(out.metadata.retries).toBe(0);
    expect(out.metadata.verdicts).toEqual(["correct"]);
    expect(out.metadata.queriesTried).toEqual([]);
    expect(search.calls.length).toBe(0);
  });

  test("insufficient → one re-query → merged & deduped, then correct", async () => {
    const original = renderSearchResults([result({ id: "1", collection: "wiki", title: "Old doc" })]);
    const search = searchSequence(
      searchResponse([
        result({ id: "1", collection: "wiki", title: "Old doc" }), // dupe — must be dropped
        result({ id: "2", collection: "wiki", title: "Fresh doc" }),
      ]),
    );
    const out = await runCorrectiveRetrieval({
      ...baseCtx,
      originalResultText: original,
      budget: 1,
      gradeFn: gradeSequence(
        { verdict: "insufficient", rewrittenQuery: "LA_BUC_02 structured electronic documents", reason: "off-topic" },
        { verdict: "correct", reason: "now covered" },
      ),
      searchFn: search,
    });
    expect(out.changed).toBe(true);
    expect(out.text).toContain("Old doc"); // original kept
    expect(out.text).toContain("Fresh doc"); // fresh appended
    expect(out.text).toContain("[corrective retrieval — re-query #1");
    // doc_id `1` appears once (original) — the dupe from the re-query was dropped.
    expect(out.text.match(/doc_id: `1`/g)?.length).toBe(1);
    expect(out.metadata.retries).toBe(1);
    expect(out.metadata.verdicts).toEqual(["insufficient", "correct"]);
    expect(out.metadata.finalVerdict).toBe("correct");
    expect(out.metadata.queriesTried).toEqual(["LA_BUC_02 structured electronic documents"]);
    expect(search.calls[0]?.query).toBe("LA_BUC_02 structured electronic documents");
  });

  test("budget 1 stops after one re-query even if still insufficient", async () => {
    const search = searchSequence(searchResponse([result({ id: "9", collection: "wiki", title: "Marginal" })]));
    const out = await runCorrectiveRetrieval({
      ...baseCtx,
      originalResultText: renderSearchResults([result({ id: "1", collection: "wiki" })]),
      budget: 1,
      gradeFn: gradeSequence({ verdict: "insufficient", rewrittenQuery: "broader terms", reason: "weak" }),
      searchFn: search,
    });
    expect(out.metadata.retries).toBe(1);
    expect(out.metadata.verdicts).toEqual(["insufficient", "insufficient"]);
    expect(out.metadata.finalVerdict).toBe("insufficient");
    expect(search.calls.length).toBe(1);
  });

  test("budget is clamped to 2 even when configured higher", async () => {
    const search = searchSequence(
      searchResponse([result({ id: "a", collection: "wiki" })]),
      searchResponse([result({ id: "b", collection: "wiki" })]),
      searchResponse([result({ id: "c", collection: "wiki" })]),
    );
    const out = await runCorrectiveRetrieval({
      ...baseCtx,
      originalResultText: renderSearchResults([result({ id: "1", collection: "wiki" })]),
      budget: 5,
      gradeFn: gradeSequence(
        { verdict: "insufficient", rewrittenQuery: "q1", reason: "x" },
        { verdict: "insufficient", rewrittenQuery: "q2", reason: "x" },
        { verdict: "insufficient", rewrittenQuery: "q3", reason: "x" },
      ),
      searchFn: search,
    });
    expect(out.metadata.retries).toBe(2);
    expect(search.calls.map((c) => c.query)).toEqual(["q1", "q2"]);
  });

  test("re-query throws → loop stops, original unchanged", async () => {
    const out = await runCorrectiveRetrieval({
      ...baseCtx,
      originalResultText: "## Original\ncollection: `wiki` doc_id: `1`",
      budget: 1,
      gradeFn: gradeSequence({ verdict: "insufficient", rewrittenQuery: "q", reason: "weak" }),
      searchFn: async () => { throw new Error("knowledge api down"); },
    });
    expect(out.changed).toBe(false);
    expect(out.metadata.retries).toBe(0);
    expect(out.metadata.verdicts).toEqual(["insufficient"]);
  });

  test("re-query returns only duplicates → no append, but retry recorded", async () => {
    const original = renderSearchResults([result({ id: "1", collection: "wiki" })]);
    const search = searchSequence(searchResponse([result({ id: "1", collection: "wiki" })]));
    const out = await runCorrectiveRetrieval({
      ...baseCtx,
      originalResultText: original,
      budget: 1,
      gradeFn: gradeSequence({ verdict: "ambiguous", rewrittenQuery: "rephrased", reason: "broad" }),
      searchFn: search,
    });
    expect(out.changed).toBe(false);
    expect(out.metadata.retries).toBe(1);
    expect(out.metadata.queriesTried).toEqual(["rephrased"]);
  });

  test("no rewritten query and no footer hints → no re-query", async () => {
    const search = searchSequence(searchResponse([result({ id: "x", collection: "wiki" })]));
    const out = await runCorrectiveRetrieval({
      ...baseCtx,
      originalResultText: "## Original\ncollection: `wiki` doc_id: `1`",
      budget: 1,
      gradeFn: gradeSequence({ verdict: "insufficient", reason: "nothing on topic" }),
      searchFn: search,
    });
    expect(out.changed).toBe(false);
    expect(out.metadata.retries).toBe(0);
    expect(search.calls.length).toBe(0);
  });

  test("falls back to broaderQuery parsed from the result footer", async () => {
    const original =
      "## Original (12% relevant · low)\ncollection: `wiki` doc_id: `1`\n\n*No confident match — try: broader query: \"LA_BUC concepts\"*";
    const search = searchSequence(searchResponse([result({ id: "2", collection: "wiki", title: "Wider hit" })]));
    const out = await runCorrectiveRetrieval({
      ...baseCtx,
      originalResultText: original,
      budget: 1,
      gradeFn: gradeSequence(
        { verdict: "insufficient", reason: "weak" }, // no rewrittenQuery — must use the footer hint
        { verdict: "correct", reason: "ok" },
      ),
      searchFn: search,
    });
    expect(search.calls[0]?.query).toBe("LA_BUC concepts");
    expect(out.text).toContain("Wider hit");
  });

  test("suggestedCollection redirects the re-query scope", async () => {
    const search = searchSequence(searchResponse([result({ id: "2", collection: "confluence", title: "Conf doc" })]));
    const out = await runCorrectiveRetrieval({
      ...baseCtx,
      originalQuery: "LA_BUC_02",
      originalCollections: ["wiki"],
      originalResultText: renderSearchResults([result({ id: "1", collection: "wiki" })]),
      budget: 1,
      gradeFn: gradeSequence(
        { verdict: "ambiguous", rewrittenQuery: "LA_BUC_02 details", suggestedCollection: "confluence", reason: "wrong collection" },
        { verdict: "correct", reason: "ok" },
      ),
      searchFn: search,
    });
    expect(search.calls[0]?.collections).toEqual(["confluence"]);
    expect(out.changed).toBe(true);
  });

  test("grader unavailable (returns 'correct') → no change", async () => {
    const search = searchSequence(searchResponse([result({ id: "x", collection: "wiki" })]));
    const out = await runCorrectiveRetrieval({
      ...baseCtx,
      originalResultText: "## Original",
      budget: 1,
      gradeFn: async () => ({ verdict: "correct", reason: "grader unavailable" }),
      searchFn: search,
    });
    expect(out.changed).toBe(false);
    expect(out.metadata.retries).toBe(0);
    expect(search.calls.length).toBe(0);
  });
});
