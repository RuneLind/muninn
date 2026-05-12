import { test, expect, describe } from "bun:test";
import { gradeKnowledgeResults, normalizeGrade, gradeFromSignal, digestResultsForGrading } from "./knowledge-grader.ts";
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

describe("gradeFromSignal", () => {
  test("'correct' when there's no weak/no-results signal", () => {
    const g = gradeFromSignal("## A doc (82% relevant · high)\ncollection: `wiki` doc_id: `1`\n\nbody text");
    expect(g.verdict).toBe("correct");
    expect(g.rewrittenQuery).toBeUndefined();
  });

  test("'insufficient' on a trailing Weak match footer", () => {
    const g = gradeFromSignal('## A doc (12% relevant · low)\ncollection: `wiki` doc_id: `1`\n\nbody\n\n*Weak match — try: broader query: "x"*');
    expect(g.verdict).toBe("insufficient");
    expect(g.rewrittenQuery).toBeUndefined(); // signal mode never rewrites; the loop uses the footer hint
  });

  test("'insufficient' on a No confident match footer", () => {
    expect(gradeFromSignal("nothing relevant\n\n*No confident match — try: related terms: a, b*").verdict).toBe("insufficient");
  });

  test("'insufficient' on a 'No results found' body", () => {
    expect(gradeFromSignal("No results found for 'xyz'.").verdict).toBe("insufficient");
  });

  test("a literal 'weak match' inside body prose does not trigger (must be a `*…*` footer line)", () => {
    expect(gradeFromSignal("## Doc\nThis explains why a weak match can happen.").verdict).toBe("correct");
  });

  test("empty input → 'correct'", () => {
    expect(gradeFromSignal("").verdict).toBe("correct");
  });
});

describe("digestResultsForGrading", () => {
  test("keeps the weak-match footer even when the body is large", () => {
    const big = Array.from({ length: 8 }, (_, i) => `## Doc ${i} (50% relevant · medium)\nhttps://x/${i}\ncollection: \`c\` doc_id: \`${i}\`\n\n${"lorem ipsum ".repeat(80)}`).join("\n");
    const text = `${big}\n\n*Weak match — try: broader query: "wider"*`;
    const digest = digestResultsForGrading(text);
    expect(digest).toContain('*Weak match — try: broader query: "wider"*');
    expect(digest.length).toBeLessThan(text.length);
    expect(digest).toContain("## Doc 0");
  });

  test("trims each block's body to a short prefix", () => {
    const text = `## Doc (70% relevant · high)\nhttps://x/1\ncollection: \`c\` doc_id: \`1\`\n\n${"A".repeat(2000)}`;
    const digest = digestResultsForGrading(text);
    expect(digest).toContain("## Doc (70% relevant · high)");
    expect(digest).toContain("…"); // truncation marker
    expect(digest.length).toBeLessThan(700);
  });

  test("empty input → empty string", () => {
    expect(digestResultsForGrading("")).toBe("");
    expect(digestResultsForGrading("   ")).toBe("");
  });
});
