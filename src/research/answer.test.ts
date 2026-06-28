import { test, expect } from "bun:test";
import type { ResearchHit } from "../ai/research-knowledge.ts";
import {
  assessCoverage,
  buildCitations,
  buildSynthesisUserPrompt,
  citedIndices,
  coverageMessage,
  renderSourcesBlock,
  LOW_CONFIDENCE_MESSAGE,
  NO_HITS_MESSAGE,
  DEFAULT_MAX_SOURCES,
} from "./answer.ts";

function hit(over: Partial<ResearchHit> = {}): ResearchHit {
  return {
    collection: "anthropic-summaries",
    id: "ai/claude-code/Claude Code overview.md",
    title: "Claude Code overview.md",
    url: "https://docs.anthropic.com/en/docs/claude-code/overview",
    relevance: 0.91,
    matchedChunks: [{ content: "Claude Code is Anthropic's agentic command-line coding tool." }],
    viaSubQuestion: ["what is claude code"],
    ...over,
  };
}

test("buildCitations numbers hits in rank order and maps corpus badges", () => {
  const cites = buildCitations([
    hit(),
    hit({ collection: "wiki", id: "concepts/rag.md", title: "RAG", url: undefined, relevance: 0.7 }),
  ]);
  expect(cites).toHaveLength(2);
  expect(cites[0]!.n).toBe(1);
  expect(cites[0]!.badge).toBe("Claude");
  expect(cites[0]!.sourceId).toBe("anthropic");
  expect(cites[0]!.snippet).toContain("agentic command-line");
  expect(cites[1]!.n).toBe(2);
  expect(cites[1]!.badge).toBe("Wiki");
  expect(cites[1]!.sourceId).toBeUndefined();
});

test("buildCitations strips .md from a fallback title and tolerates missing title", () => {
  const [c] = buildCitations([hit({ title: undefined, id: "ai/claude/Foo bar.md" })]);
  expect(c!.title).toBe("Foo bar");
});

test("buildCitations caps at maxSources", () => {
  const many = Array.from({ length: DEFAULT_MAX_SOURCES + 4 }, (_, i) =>
    hit({ id: `doc-${i}.md`, relevance: 1 - i * 0.01 }),
  );
  expect(buildCitations(many)).toHaveLength(DEFAULT_MAX_SOURCES);
  expect(buildCitations(many, 3)).toHaveLength(3);
});

test("buildCitations falls back to badge=collection for an off-corpus collection", () => {
  const [c] = buildCitations([hit({ collection: "jira-issues", id: "X-1.md", title: "X-1" })]);
  expect(c!.badge).toBe("jira-issues");
});

test("renderSourcesBlock emits numbered, badged, snippet-bearing entries", () => {
  const block = renderSourcesBlock(buildCitations([hit()]));
  expect(block).toContain("[1] (Claude) Claude Code overview");
  expect(block).toContain("https://docs.anthropic.com");
  expect(block).toContain("agentic command-line");
});

test("buildSynthesisUserPrompt embeds the question and the numbered sources", () => {
  const prompt = buildSynthesisUserPrompt("What is Claude Code?", buildCitations([hit()]));
  expect(prompt).toContain("Question: What is Claude Code?");
  expect(prompt).toContain("Cite with [n]");
  expect(prompt).toContain("[1] (Claude)");
});

test("citedIndices extracts distinct, sorted, in-text references", () => {
  expect(citedIndices("First [2] then [1] then again [2].")).toEqual([1, 2]);
  expect(citedIndices("no citations here")).toEqual([]);
  expect(citedIndices("ranges like [3][5] both count")).toEqual([3, 5]);
});

test("NO_HITS_MESSAGE is a non-empty honest fallback", () => {
  expect(NO_HITS_MESSAGE.length).toBeGreaterThan(20);
  expect(NO_HITS_MESSAGE.toLowerCase()).toContain("couldn't find");
});

// --- assessCoverage: the honest relevance floor (gates on Huginn's raw-score
// `lowConfidence` signal, not the rank-based `relevance` value) ---

test("assessCoverage: zero merged hits → no_hits", () => {
  expect(assessCoverage({ hitCount: 0, subSearches: [] })).toBe("no_hits");
  expect(assessCoverage({ hitCount: 0, subSearches: [{ resultCount: 0 }] })).toBe("no_hits");
});

test("assessCoverage: a confident sub-search with results → answer", () => {
  expect(
    assessCoverage({ hitCount: 3, subSearches: [{ resultCount: 3, lowConfidence: false }] }),
  ).toBe("answer");
  // lowConfidence absent is treated as confident.
  expect(assessCoverage({ hitCount: 2, subSearches: [{ resultCount: 2 }] })).toBe("answer");
});

test("assessCoverage: results exist but every result-bearing sub-search is weak → low_confidence", () => {
  expect(
    assessCoverage({
      hitCount: 2,
      subSearches: [
        { resultCount: 2, lowConfidence: true },
        { resultCount: 0, lowConfidence: false }, // empty sub-search doesn't count as confident
      ],
    }),
  ).toBe("low_confidence");
});

test("assessCoverage: one confident angle among weak ones is enough to answer", () => {
  expect(
    assessCoverage({
      hitCount: 4,
      subSearches: [
        { resultCount: 1, lowConfidence: true },
        { resultCount: 3, lowConfidence: false },
      ],
    }),
  ).toBe("answer");
});

test("assessCoverage: hits present but all sub-searches returned nothing → no_hits", () => {
  // Defensive: merged count and per-search counts disagree (shouldn't happen, but
  // we never want to claim coverage with no result-bearing sub-search to judge).
  expect(
    assessCoverage({ hitCount: 2, subSearches: [{ resultCount: 0, lowConfidence: true }] }),
  ).toBe("no_hits");
});

test("coverageMessage maps the non-answer verdicts to distinct canned replies", () => {
  expect(coverageMessage("no_hits")).toBe(NO_HITS_MESSAGE);
  expect(coverageMessage("low_confidence")).toBe(LOW_CONFIDENCE_MESSAGE);
  expect(LOW_CONFIDENCE_MESSAGE.length).toBeGreaterThan(20);
  expect(LOW_CONFIDENCE_MESSAGE.toLowerCase()).toContain("don't confidently cover");
});
