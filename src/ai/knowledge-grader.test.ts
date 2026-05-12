import { test, expect, describe } from "bun:test";
import { gradeKnowledgeResults, normalizeGrade } from "./knowledge-grader.ts";
import { getLog } from "../logging.ts";
import type { HaikuResult } from "../scheduler/executor.ts";

const log = getLog("test", "knowledge-grader");

function fakeSpawn(result: string): () => Promise<HaikuResult> {
  return async () => ({ result, inputTokens: 0, outputTokens: 0, model: "haiku" });
}

describe("normalizeGrade", () => {
  test("passes through a valid 'correct' verdict and drops any query", () => {
    const g = normalizeGrade({ verdict: "correct", rewrittenQuery: "ignored", reason: "covered" });
    expect(g.verdict).toBe("correct");
    expect(g.rewrittenQuery).toBeUndefined();
    expect(g.suggestedCollection).toBeUndefined();
    expect(g.reason).toBe("covered");
  });

  test("keeps rewrittenQuery / suggestedCollection for non-correct verdicts", () => {
    const g = normalizeGrade({
      verdict: "ambiguous",
      rewrittenQuery: "  LA_BUC_02 SED list  ",
      suggestedCollection: " confluence ",
      reason: "too broad",
    });
    expect(g.verdict).toBe("ambiguous");
    expect(g.rewrittenQuery).toBe("LA_BUC_02 SED list");
    expect(g.suggestedCollection).toBe("confluence");
  });

  test("unknown / missing verdict falls back to 'correct' (fail-soft)", () => {
    expect(normalizeGrade({}).verdict).toBe("correct");
    expect(normalizeGrade({ verdict: "garbage" }).verdict).toBe("correct");
    expect(normalizeGrade({ verdict: 42 }).verdict).toBe("correct");
  });

  test("blank / non-string rewrittenQuery is dropped", () => {
    const g = normalizeGrade({ verdict: "insufficient", rewrittenQuery: "   ", reason: "" });
    expect(g.rewrittenQuery).toBeUndefined();
    expect(g.reason).toBeTruthy(); // synthesized default
  });
});

describe("gradeKnowledgeResults", () => {
  const base = { question: "what SEDs belong to LA_BUC_02?", toolResultText: "## Some doc (12% relevant · low)", botName: "test", log };

  test("parses a clean JSON verdict from Haiku", async () => {
    const g = await gradeKnowledgeResults({
      ...base,
      spawnFn: fakeSpawn('{"verdict":"insufficient","rewrittenQuery":"LA_BUC_02 structured electronic documents","reason":"off-topic snippets"}'),
    });
    expect(g.verdict).toBe("insufficient");
    expect(g.rewrittenQuery).toBe("LA_BUC_02 structured electronic documents");
  });

  test("tolerates surrounding prose / markdown fence around the JSON", async () => {
    const g = await gradeKnowledgeResults({
      ...base,
      spawnFn: fakeSpawn('Here is my assessment:\n```json\n{"verdict":"ambiguous","reason":"query too vague"}\n```\n'),
    });
    expect(g.verdict).toBe("ambiguous");
  });

  test("Haiku throwing → verdict 'correct' (no disruption)", async () => {
    const g = await gradeKnowledgeResults({
      ...base,
      spawnFn: async () => { throw new Error("haiku down"); },
    });
    expect(g.verdict).toBe("correct");
  });

  test("unparseable Haiku output → verdict 'correct'", async () => {
    const g = await gradeKnowledgeResults({ ...base, spawnFn: fakeSpawn("not json at all, sorry") });
    expect(g.verdict).toBe("correct");
  });
});
