import { test, expect, describe } from "bun:test";
import { applyCorrectiveRetrieval, extractUserQuestion, attachCorrectiveOutcomes } from "./copilot-sdk.ts";
import type { CorrectiveMetadata } from "../corrective-retrieval.ts";
import type { ToolCall } from "../../types.ts";
import type { KnowledgeGrade } from "../knowledge-grader.ts";

describe("extractUserQuestion", () => {
  test("returns the current turn after the conversation_history block", () => {
    const prompt = "<conversation_history>\nuser: hi\nassistant: hello\n</conversation_history>\n\nWhat SEDs belong to LA_BUC_02?";
    expect(extractUserQuestion(prompt)).toBe("What SEDs belong to LA_BUC_02?");
  });

  test("returns the whole prompt when there's no history block", () => {
    expect(extractUserQuestion("just a question")).toBe("just a question");
  });

  test("caps very long tails to the last 1500 chars", () => {
    const long = "x".repeat(5000);
    const out = extractUserQuestion(long);
    expect(out.length).toBe(1500);
  });
});

describe("attachCorrectiveOutcomes", () => {
  function tc(name: string): ToolCall {
    return { id: name, name, displayName: name, durationMs: 1, startOffsetMs: 0 };
  }
  function meta(finalVerdict: string): CorrectiveMetadata {
    return {
      retries: 1,
      verdicts: ["insufficient", finalVerdict] as KnowledgeGrade["verdict"][],
      reasons: ["x", "y"],
      queriesTried: ["q"],
      collectionsTried: [undefined],
      finalVerdict: finalVerdict as KnowledgeGrade["verdict"],
      graderMode: "signal",
      graderMs: 0,
      requeryMs: [50],
    };
  }

  test("maps the i-th outcome to the i-th knowledge-search tool call, skipping others", () => {
    const calls = [tc("knowledge-search_knowledge"), tc("yggdrasil-symbol_context"), tc("knowledge-search_knowledge")];
    attachCorrectiveOutcomes(calls, [meta("correct"), meta("ambiguous")]);
    expect(calls[0]!.corrective?.finalVerdict).toBe("correct");
    expect(calls[0]!.corrective?.graderMode).toBe("signal");
    expect(calls[1]!.corrective).toBeUndefined();
    expect(calls[2]!.corrective?.finalVerdict).toBe("ambiguous");
    expect(calls[2]!.corrective?.collectionsTried).toEqual([null]);
  });

  test("a null slot (a knowledge search with no outcome) doesn't shift later outcomes onto it", () => {
    // search #1 produced nothing (e.g. confident signal-mode pass → null slot),
    // search #2 produced an outcome — #2's metadata must land on call #2, not #1.
    const calls = [tc("knowledge-search_knowledge"), tc("yggdrasil-symbol_context"), tc("knowledge-search_knowledge")];
    attachCorrectiveOutcomes(calls, [null, meta("ambiguous")]);
    expect(calls[0]!.corrective).toBeUndefined();
    expect(calls[1]!.corrective).toBeUndefined();
    expect(calls[2]!.corrective?.finalVerdict).toBe("ambiguous");
  });

  test("no-op when there are no outcomes", () => {
    const calls = [tc("knowledge-search_knowledge")];
    attachCorrectiveOutcomes(calls, []);
    expect(calls[0]!.corrective).toBeUndefined();
  });
});

describe("applyCorrectiveRetrieval — haiku mode", () => {
  const botConfig = { name: "test", dir: "/tmp/test-bot" };
  const okGrade: KnowledgeGrade = { verdict: "correct", reason: "covered" };

  function grader(...grades: KnowledgeGrade[]) {
    let i = 0;
    return async () => grades[Math.min(i++, grades.length - 1)]!;
  }

  test("returns null for a tool error result", async () => {
    const out = await applyCorrectiveRetrieval({
      toolName: "knowledge-search_knowledge",
      toolArgs: { query: "x" },
      toolResult: { textResultForLlm: "Knowledge API server is not running", resultType: "failure" },
      botConfig,
      budget: 1,
      grader: "haiku",
      userQuestion: "q",
      gradeFn: grader(okGrade),
      searchFn: async () => ({ results: [] }),
    });
    expect(out).toBeNull();
  });

  test("returns null for an empty result", async () => {
    const out = await applyCorrectiveRetrieval({
      toolName: "knowledge-search_knowledge",
      toolArgs: { query: "x" },
      toolResult: { textResultForLlm: "", resultType: "success" },
      botConfig,
      budget: 1,
      grader: "haiku",
      userQuestion: "q",
      gradeFn: grader(okGrade),
      searchFn: async () => ({ results: [] }),
    });
    expect(out).toBeNull();
  });

  test("verdict 'correct' → metadata only, no modifiedResult (haiku still recorded)", async () => {
    const out = await applyCorrectiveRetrieval({
      toolName: "knowledge-search_knowledge",
      toolArgs: { query: "x", collection: "wiki" },
      toolResult: { textResultForLlm: "## Doc (80% relevant · high)\ncollection: `wiki` doc_id: `1`\n\nbody", resultType: "success" },
      botConfig,
      budget: 1,
      grader: "haiku",
      userQuestion: "q",
      gradeFn: grader(okGrade),
      searchFn: async () => ({ results: [] }),
    });
    expect(out).not.toBeNull();
    expect(out!.modifiedResult).toBeUndefined();
    expect(out!.metadata.retries).toBe(0);
    expect(out!.metadata.graderMode).toBe("haiku");
  });

  test("low-confidence result → exactly one re-query, merged, trace fence preserved at the end", async () => {
    const original =
      "## Old doc (15% relevant · low)\ncollection: `wiki` doc_id: `1`\n\nweak body\n\n```huginn-trace\n{\"schemaVersion\":1,\"totalMs\":42}\n```";
    let searchCalls = 0;
    const out = await applyCorrectiveRetrieval({
      toolName: "knowledge-search_knowledge",
      toolArgs: { query: "LA_BUC_02", collection: "wiki" },
      toolResult: { textResultForLlm: original, resultType: "success" },
      botConfig,
      budget: 1,
      grader: "haiku",
      userQuestion: "what SEDs belong to LA_BUC_02?",
      gradeFn: grader(
        { verdict: "insufficient", rewrittenQuery: "LA_BUC_02 structured electronic documents", reason: "off-topic" },
        { verdict: "correct", reason: "now covered" },
      ),
      searchFn: async (query: string) => {
        searchCalls++;
        expect(query).toBe("LA_BUC_02 structured electronic documents");
        return {
          results: [
            { collection: "wiki", id: "1", title: "Old doc", relevance: 0.7, confidenceBand: "high", matchedChunks: [{ content: "x" }] }, // dupe
            { collection: "wiki", id: "2", title: "Right doc", relevance: 0.8, confidenceBand: "high", matchedChunks: [{ content: "the answer" }] },
          ],
        };
      },
    });
    expect(searchCalls).toBe(1);
    expect(out).not.toBeNull();
    expect(out!.modifiedResult).toBeDefined();
    const text = out!.modifiedResult!.textResultForLlm;
    expect(text).toContain("Old doc");
    expect(text).toContain("Right doc");
    expect(text).toContain("[corrective retrieval — re-query #1");
    expect(text.match(/doc_id: `1`/g)?.length).toBe(1); // dupe dropped
    expect(text.trimEnd().endsWith("```")).toBe(true); // trace fence re-appended at the very end
    expect(text).toContain("\"schemaVersion\":1");
    expect(out!.metadata.queriesTried).toEqual(["LA_BUC_02 structured electronic documents"]);
  });
});

describe("applyCorrectiveRetrieval — signal mode (default)", () => {
  const botConfig = { name: "test", dir: "/tmp/test-bot" };

  test("confident search (no weak footer) → returns null (uneventful free check, no span)", async () => {
    let searchCalls = 0;
    const out = await applyCorrectiveRetrieval({
      toolName: "knowledge-search_knowledge",
      toolArgs: { query: "x", collection: "wiki" },
      toolResult: { textResultForLlm: "## Doc (80% relevant · high)\ncollection: `wiki` doc_id: `1`\n\nbody", resultType: "success" },
      botConfig,
      budget: 1,
      userQuestion: "q",
      searchFn: async () => { searchCalls++; return { results: [] }; },
    });
    expect(out).toBeNull();
    expect(searchCalls).toBe(0); // no grader call, no re-query
  });

  test("Huginn-flagged weak result → re-queries with the footer hint, merges", async () => {
    const original =
      "## Marginal hit (12% relevant · low)\ncollection: `wiki` doc_id: `1`\n\nmeh\n\n*Weak match — try: broader query: \"LA_BUC concepts\"*";
    let seenQuery = "";
    const out = await applyCorrectiveRetrieval({
      toolName: "knowledge-search_knowledge",
      toolArgs: { query: "LA_BUC_02 obscure phrasing", collection: "wiki" },
      toolResult: { textResultForLlm: original, resultType: "success" },
      botConfig,
      budget: 1,
      userQuestion: "what about LA_BUC_02?",
      searchFn: async (query: string) => {
        seenQuery = query;
        return {
          results: [{ collection: "wiki", id: "2", title: "Wider hit", relevance: 0.6, confidenceBand: "medium", matchedChunks: [{ content: "useful" }] }],
        };
      },
    });
    expect(seenQuery).toBe("LA_BUC concepts");
    expect(out).not.toBeNull();
    expect(out!.modifiedResult).toBeDefined();
    const text = out!.modifiedResult!.textResultForLlm;
    expect(text).toContain("Wider hit");
    expect(text).toContain("[corrective retrieval — re-query #1");
    expect(text).not.toContain("Weak match — try"); // obsolete footer stripped
    expect(out!.metadata.graderMode).toBe("signal");
    expect(out!.metadata.verdicts).toEqual(["insufficient", "correct"]);
    expect(out!.metadata.queriesTried).toEqual(["LA_BUC concepts"]);
  });

  test("weak result but no usable hint → metadata recorded, no re-query, not null", async () => {
    const original =
      "## Marginal hit (12% relevant · low)\ncollection: `wiki` doc_id: `1`\n\nmeh\n\n*Weak match — try: related terms: foo, bar*";
    let searchCalls = 0;
    const out = await applyCorrectiveRetrieval({
      toolName: "knowledge-search_knowledge",
      toolArgs: { query: "x", collection: "wiki" },
      toolResult: { textResultForLlm: original, resultType: "success" },
      botConfig,
      budget: 1,
      userQuestion: "q",
      searchFn: async () => { searchCalls++; return { results: [] }; },
    });
    expect(searchCalls).toBe(0);
    expect(out).not.toBeNull();
    expect(out!.modifiedResult).toBeUndefined();
    expect(out!.metadata.retries).toBe(0);
    expect(out!.metadata.verdicts).toEqual(["insufficient"]);
  });

  test("'No results found' body → re-queries with the footer hint if present", async () => {
    const original = "No results found for 'xyz'.\n\n*No confident match — try: narrower query: \"xyz precise term\"*";
    let seenQuery = "";
    const out = await applyCorrectiveRetrieval({
      toolName: "knowledge-search_knowledge",
      toolArgs: { query: "xyz", collection: "wiki" },
      toolResult: { textResultForLlm: original, resultType: "success" },
      botConfig,
      budget: 1,
      userQuestion: "q",
      searchFn: async (query: string) => {
        seenQuery = query;
        return { results: [{ collection: "wiki", id: "9", title: "Found it", relevance: 0.7, confidenceBand: "high", matchedChunks: [{ content: "yes" }] }] };
      },
    });
    expect(seenQuery).toBe("xyz precise term");
    expect(out!.modifiedResult).toBeDefined();
    expect(out!.modifiedResult!.textResultForLlm).toContain("Found it");
  });
});
