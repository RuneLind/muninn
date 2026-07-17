import { test, expect, describe } from "bun:test";
import {
  locateExcerpt,
  buildExplainQuestion,
  buildExplainContextBlock,
  buildExplainAskOptions,
  EXPLAIN_WINDOW,
  EXPLAIN_FULL_BODY_MAX,
} from "./explain-context.ts";

/** Build a long filler block (well over EXPLAIN_FULL_BODY_MAX) of ordinary
 *  non-heading prose lines, so locating is actually exercised. */
function pad(label: string, lines = 45): string {
  return Array.from(
    { length: lines },
    (_, i) => `${label} line ${i} lorem ipsum dolor sit amet consectetur`,
  ).join("\n");
}

describe("locateExcerpt", () => {
  const before = pad("A");
  const after = pad("B");

  test("exact hit returns a window around the selection", () => {
    const body = `${before}\n\nThe quick brown fox jumps over the lazy dog today.\n\n${after}`;
    expect(body.length).toBeGreaterThan(EXPLAIN_FULL_BODY_MAX);
    const excerpt = locateExcerpt(body, "The quick brown fox jumps over the lazy dog today.");
    expect(excerpt).toContain("The quick brown fox jumps over the lazy dog today.");
    // Bounded to roughly ±EXPLAIN_WINDOW either side.
    expect(excerpt.length).toBeLessThanOrEqual(2 * EXPLAIN_WINDOW + 200);
  });

  test("markdown-noise hit: rendered selection matches marked-up source", () => {
    const body = `${before}\n\nHere is **foo** [bar](http://example.com) inline.\n\n${after}`;
    // The reader selected the rendered text "foo bar"; the source carries markup.
    const excerpt = locateExcerpt(body, "foo bar");
    expect(excerpt).toContain("**foo**");
    expect(excerpt).toContain("[bar]");
  });

  test("prefix fallback: full selection misses, first 80 collapsed chars hit", () => {
    const sentence =
      "Prefix fallback marker sentence alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const body = `${before}\n\n${sentence}\n\n${after}`;
    // Full selection has a trailing tail absent from the body → step 1 misses;
    // its first 80 chars are a real body prefix → step 2 hits.
    const selection = sentence.slice(0, 88) + " TAIL_NOT_IN_BODY_QZX";
    const excerpt = locateExcerpt(body, selection);
    expect(excerpt).toContain("Prefix fallback marker sentence");
  });

  test("heading fallback when the selection is nowhere in the body", () => {
    const body =
      `${before}\n\n## Target Heading Here\n\n` +
      "Section body content unique wombat.\n\n### A Subsection\n\nsub content here.\n\n" +
      `## Next Top Section\n\nafter content\n\n${after}`;
    const excerpt = locateExcerpt(body, "totally absent selection qqq zzz", "Target Heading");
    expect(excerpt.startsWith("## Target Heading Here")).toBe(true);
    expect(excerpt).toContain("Section body content unique wombat");
    // Same-or-higher-level heading bounds the section — the deeper ### stays in.
    expect(excerpt).toContain("sub content here");
    expect(excerpt).not.toContain("Next Top Section");
  });

  test("huge single line: line-snapping does not balloon the excerpt", () => {
    // One 8k-char line (e.g. a giant table row) — snapping to line boundaries
    // would return the whole line; the bounded snap must keep the window cap.
    const hugeLine = `left filler ${"x".repeat(4000)} needle target phrase here ${"y".repeat(4000)} right filler`;
    const body = `${before}\n${hugeLine}\n${after}`;
    const excerpt = locateExcerpt(body, "needle target phrase here");
    expect(excerpt).toContain("needle target phrase here");
    expect(excerpt.length).toBeLessThanOrEqual(2 * EXPLAIN_WINDOW + EXPLAIN_WINDOW + 200);
  });

  test("head-of-body fallback, capped at 2×EXPLAIN_WINDOW", () => {
    const body = `${before}\n\n${after}`;
    const excerpt = locateExcerpt(body, "absent selection zzz qqq");
    expect(excerpt).toBe(body.slice(0, 2 * EXPLAIN_WINDOW).trim());
    expect(excerpt.length).toBeLessThanOrEqual(2 * EXPLAIN_WINDOW);
  });

  test("short body is passed through whole (no locating)", () => {
    const body = "Short body under the cap.\n\nSecond paragraph.";
    expect(body.length).toBeLessThanOrEqual(EXPLAIN_FULL_BODY_MAX);
    expect(locateExcerpt(body, "irrelevant selection")).toBe(body.trim());
  });

  test("heading-section fallback is capped at 2×EXPLAIN_WINDOW", () => {
    const hugeSection = pad("H", 200); // ~8000 chars, well over the cap
    const body = `${before}\n\n## Big Heading\n\n${hugeSection}\n\n${after}`;
    const excerpt = locateExcerpt(body, "no match at all here xyz", "Big Heading");
    expect(excerpt.length).toBeLessThanOrEqual(2 * EXPLAIN_WINDOW);
  });
});

describe("buildExplainQuestion", () => {
  test("quotes the trimmed selection and the page title", () => {
    expect(buildExplainQuestion("  hello world  ", "My Page")).toBe(
      'Explain this passage from "My Page": "hello world"',
    );
  });
});

describe("buildExplainContextBlock", () => {
  const meta = { title: "Corrective RAG", tags: ["rag", "retrieval"], type: "concept" };

  test("includes the excerpt, related pages, and the instruction", () => {
    const block = buildExplainContextBlock({
      meta,
      excerpt: "SOME EXCERPT TEXT",
      similarTitles: ["Page A", "Page B"],
    });
    expect(block).toContain("ARTICLE CONTEXT");
    expect(block).toContain("Title: Corrective RAG");
    expect(block).toContain("Tags: rag, retrieval");
    expect(block).toContain("SOME EXCERPT TEXT");
    expect(block).toContain("Related pages in this wiki: Page A, Page B");
    expect(block).toContain("not a citable source");
  });

  test("omits the related-pages line when there are no similar titles", () => {
    const block = buildExplainContextBlock({ meta, excerpt: "X", similarTitles: [] });
    expect(block).not.toContain("Related pages in this wiki");
    // The instruction still renders.
    expect(block).toContain("Explain the selected passage");
  });
});

describe("buildExplainAskOptions", () => {
  const meta = { title: "T", tags: ["x", "y"], type: "concept" };

  test("composes the question and per-wiki system prompt end to end", () => {
    const { question, systemPrompt } = buildExplainAskOptions({
      meta,
      body: "A short page body about widgets.",
      sel: "widgets",
      similarTitles: ["Related One"],
      wikiName: "mywiki",
    });
    expect(question).toBe('Explain this passage from "T": "widgets"');
    expect(systemPrompt).toContain('You explain passages from the "mywiki" knowledge wiki');
    // Short body ⇒ excerpt is the whole body, embedded in the context block.
    expect(systemPrompt).toContain("A short page body about widgets.");
    expect(systemPrompt).toContain("Related pages in this wiki: Related One");
    expect(systemPrompt).toContain("ARTICLE CONTEXT");
  });

  test("degrades cleanly with no similar titles (no Related-pages line)", () => {
    const { systemPrompt } = buildExplainAskOptions({
      meta,
      body: "body",
      sel: "sel",
      similarTitles: [],
      wikiName: "w",
    });
    expect(systemPrompt).not.toContain("Related pages in this wiki");
  });
});
