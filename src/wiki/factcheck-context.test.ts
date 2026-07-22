import { test, expect, describe } from "bun:test";
import {
  buildFactcheckPrompts,
  stripFactcheckBlock,
  countFactcheckClaims,
  FACTCHECK_SENTINEL_START,
  FACTCHECK_SENTINEL_END,
  FACTCHECK_MAX_CLAIMS,
  FACTCHECK_ARTICLE_BODY_MAX,
} from "./factcheck-context.ts";

const meta = { title: "Test Page", tags: ["ai", "history"], type: "note" };

describe("stripFactcheckBlock", () => {
  test("removes a sentinel-wrapped block, keeping surrounding body", () => {
    const body = `Real content here.\n\n${FACTCHECK_SENTINEL_START}\n## Fact check\n✅ **Claim** supported.\n${FACTCHECK_SENTINEL_END}\n\nMore content.`;
    const out = stripFactcheckBlock(body);
    expect(out).toContain("Real content here.");
    expect(out).toContain("More content.");
    expect(out).not.toContain("Fact check");
    expect(out).not.toContain(FACTCHECK_SENTINEL_START);
    expect(out).not.toContain(FACTCHECK_SENTINEL_END);
  });

  test("removes multiple blocks", () => {
    const body = `A\n${FACTCHECK_SENTINEL_START}one${FACTCHECK_SENTINEL_END}\nB\n${FACTCHECK_SENTINEL_START}two${FACTCHECK_SENTINEL_END}\nC`;
    const out = stripFactcheckBlock(body);
    expect(out).not.toContain("one");
    expect(out).not.toContain("two");
    expect(out).toContain("A");
    expect(out).toContain("B");
    expect(out).toContain("C");
  });

  test("is a no-op on a body with no block", () => {
    const body = "Just a normal page with no fact-check block.";
    expect(stripFactcheckBlock(body)).toBe(body);
  });
});

describe("countFactcheckClaims", () => {
  test("counts one per verdict marker", () => {
    const answer = "Overall good.\n✅ **A** supported.\n⚠️ **B** partly.\n❌ **C** wrong.\n❓ **D** unknown.";
    expect(countFactcheckClaims(answer)).toBe(4);
  });

  test("returns 0 when no markers present", () => {
    expect(countFactcheckClaims("No verdicts here at all.")).toBe(0);
  });
});

describe("buildFactcheckPrompts — sel mode", () => {
  test("frames the selected passage with located excerpt", () => {
    const body = "Intro paragraph.\n\nThe Eiffel Tower was completed in 1889 in Paris.\n\nOutro.";
    const out = buildFactcheckPrompts({
      mode: "sel",
      meta,
      body,
      sel: "The Eiffel Tower was completed in 1889",
      wikiName: "jarvis",
    });
    expect(out.question).toBe('Fact-check: "The Eiffel Tower was completed in 1889"');
    expect(out.userPrompt).toContain("PASSAGE TO VERIFY");
    expect(out.userPrompt).toContain("The Eiffel Tower was completed in 1889");
    expect(out.userPrompt).toContain('from "Test Page"');
    expect(out.userPrompt).toContain("SURROUNDING CONTEXT");
    // Claim cap surfaced in the prompt.
    expect(out.userPrompt).toContain(String(FACTCHECK_MAX_CLAIMS));
    // Web-verification contract present in the system prompt.
    expect(out.systemPrompt).toContain("WebFetch");
    expect(out.systemPrompt).toContain("Cite ONLY URLs you actually opened");
  });
});

describe("buildFactcheckPrompts — article mode", () => {
  test("asks to extract capped claims from the body", () => {
    const body = "Claude 3.5 Sonnet was released in June 2024. GPT-4 launched in March 2023.";
    const out = buildFactcheckPrompts({ mode: "article", meta, body, wikiName: "jarvis" });
    expect(out.question).toBe("Fact-check article: Test Page");
    expect(out.userPrompt).toContain("BODY:");
    expect(out.userPrompt).toContain("Claude 3.5 Sonnet");
    expect(out.userPrompt).toContain(`up to ${FACTCHECK_MAX_CLAIMS} checkable factual claims`);
    expect(out.userPrompt).toContain("Type: note");
    expect(out.userPrompt).toContain("Tags: ai, history");
  });

  test("respects an explicit maxClaims override", () => {
    const out = buildFactcheckPrompts({ mode: "article", meta, body: "x", wikiName: "w", maxClaims: 3 });
    expect(out.userPrompt).toContain("up to 3 checkable");
  });

  test("caps a long article body", () => {
    const body = "A".repeat(FACTCHECK_ARTICLE_BODY_MAX + 5000);
    const out = buildFactcheckPrompts({ mode: "article", meta, body, wikiName: "w" });
    // The body between the fences is capped; the whole prompt is not much longer.
    expect(out.userPrompt.length).toBeLessThan(FACTCHECK_ARTICLE_BODY_MAX + 1000);
  });

  test("strips a prior fact-check block before building context", () => {
    const body = `Original claim: X happened in 2020.\n${FACTCHECK_SENTINEL_START}\n❌ **X** contradicted.\n${FACTCHECK_SENTINEL_END}`;
    const out = buildFactcheckPrompts({ mode: "article", meta, body, wikiName: "w" });
    expect(out.userPrompt).toContain("X happened in 2020");
    expect(out.userPrompt).not.toContain("contradicted");
    expect(out.userPrompt).not.toContain(FACTCHECK_SENTINEL_START);
  });

  test("omits the Tags line when there are no tags", () => {
    const out = buildFactcheckPrompts({
      mode: "article",
      meta: { title: "T", tags: [], type: "note" },
      body: "b",
      wikiName: "w",
    });
    expect(out.userPrompt).not.toContain("Tags:");
    expect(out.userPrompt).toContain("Type: note");
  });
});
