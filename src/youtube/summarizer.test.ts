import { test, expect } from "bun:test";
import { parseSummaryResponse } from "./summarizer.ts";

test("parses CATEGORY and SUMMARY correctly", () => {
  const text = `CATEGORY: ai/claude-code

SUMMARY:
### Key Insights
- Point one
- Point two`;

  const result = parseSummaryResponse(text);
  expect(result.category).toBe("ai/claude-code");
  expect(result.summary).toContain("### Key Insights");
  expect(result.summary).toContain("Point one");
});

test("defaults to ai/general for missing category", () => {
  const text = `Just a plain summary without markers`;
  const result = parseSummaryResponse(text);
  expect(result.category).toBe("ai/general");
  expect(result.summary).toBe("Just a plain summary without markers");
});

test("defaults to ai/general for invalid category", () => {
  const text = `CATEGORY: invalid/category

SUMMARY:
Some summary`;

  const result = parseSummaryResponse(text);
  expect(result.category).toBe("ai/general");
  expect(result.summary).toBe("Some summary");
});

test("handles category with extra whitespace", () => {
  const text = `CATEGORY:   health

SUMMARY:
Health content here`;

  const result = parseSummaryResponse(text);
  expect(result.category).toBe("health");
  expect(result.summary).toBe("Health content here");
});

test("handles case-insensitive CATEGORY and SUMMARY markers", () => {
  const text = `category: tech

summary:
Tech summary`;

  const result = parseSummaryResponse(text);
  expect(result.category).toBe("tech");
  expect(result.summary).toBe("Tech summary");
});

test("scans first 5 lines for category (skips preamble)", () => {
  const text = `Here's the analysis:

CATEGORY: coding

SUMMARY:
Code content`;

  const result = parseSummaryResponse(text);
  expect(result.category).toBe("coding");
  expect(result.summary).toBe("Code content");
});

test("handles empty input", () => {
  const result = parseSummaryResponse("");
  expect(result.category).toBe("ai/general");
  expect(result.summary).toBe("");
});

test("preserves markdown formatting in summary", () => {
  const text = `CATEGORY: ai/general

SUMMARY:
### Section 1
- **Bold point**
- Regular point

### Section 2
> A blockquote`;

  const result = parseSummaryResponse(text);
  expect(result.summary).toContain("### Section 1");
  expect(result.summary).toContain("**Bold point**");
  expect(result.summary).toContain("> A blockquote");
});
