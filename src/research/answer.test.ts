import { test, expect } from "bun:test";
import type { ResearchHit } from "../ai/research-knowledge.ts";
import {
  buildCitations,
  buildSynthesisUserPrompt,
  citedIndices,
  renderSourcesBlock,
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
