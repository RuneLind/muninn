import { test, expect } from "bun:test";
import type { ResearchHit } from "../ai/research-knowledge.ts";
import {
  assessCoverage,
  buildCitations,
  buildRetrievalQuestion,
  buildSynthesisUserPrompt,
  citedIndices,
  coverageMessage,
  renderHistoryBlock,
  renderSourcesBlock,
  LOW_CONFIDENCE_MESSAGE,
  NO_HITS_MESSAGE,
  DEFAULT_MAX_SOURCES,
  MAX_HISTORY_TURNS,
  SYNTHESIS_SYSTEM_PROMPT,
  buildSynthesisSystemPrompt,
  type ResearchTurn,
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

// --- Multi-turn follow-ups: prior turns thread into retrieval + synthesis ---

test("buildRetrievalQuestion: empty history returns the question verbatim (single-shot unchanged)", () => {
  expect(buildRetrievalQuestion("What is prompt caching?")).toBe("What is prompt caching?");
  expect(buildRetrievalQuestion("What is prompt caching?", [])).toBe("What is prompt caching?");
});

test("buildRetrievalQuestion: a follow-up prepends the prior question(s) so retrieval can resolve references", () => {
  const history: ResearchTurn[] = [{ question: "What is Claude Code?", answer: "An agentic CLI." }];
  const q = buildRetrievalQuestion("Does it support MCP?", history);
  expect(q).toContain('"What is Claude Code?"');
  expect(q).toContain("Does it support MCP?");
  // The literal follow-up text is still present so retrieval keeps its own terms.
  expect(q.endsWith("Does it support MCP?")).toBe(true);
});

test("buildRetrievalQuestion: uses at most the two most recent prior questions", () => {
  const history: ResearchTurn[] = [
    { question: "Q-oldest", answer: "a" },
    { question: "Q-middle", answer: "b" },
    { question: "Q-recent", answer: "c" },
  ];
  const q = buildRetrievalQuestion("now this", history);
  expect(q).not.toContain("Q-oldest");
  expect(q).toContain("Q-middle");
  expect(q).toContain("Q-recent");
});

test("buildRetrievalQuestion: history with only blank questions falls back to the raw question", () => {
  expect(buildRetrievalQuestion("real question", [{ question: "   ", answer: "x" }])).toBe("real question");
});

test("renderHistoryBlock: numbers turns and truncates long prior answers", () => {
  const long = "x".repeat(2000);
  const block = renderHistoryBlock([
    { question: "first?", answer: "short answer" },
    { question: "second?", answer: long },
  ]);
  expect(block).toContain("Q1: first?");
  expect(block).toContain("A1: short answer");
  expect(block).toContain("Q2: second?");
  expect(block).toContain("…"); // long answer was truncated
  expect(block.length).toBeLessThan(long.length);
});

test("renderHistoryBlock: keeps only the most recent MAX_HISTORY_TURNS", () => {
  const history: ResearchTurn[] = Array.from({ length: MAX_HISTORY_TURNS + 3 }, (_, i) => ({
    question: `q${i}`,
    answer: `a${i}`,
  }));
  const block = renderHistoryBlock(history);
  expect(block).not.toContain("q0");
  expect(block).toContain(`q${history.length - 1}`);
  // MAX_HISTORY_TURNS turns → that many "Q" lines.
  expect(block.match(/^Q\d+:/gm)?.length).toBe(MAX_HISTORY_TURNS);
});

test("buildSynthesisUserPrompt: empty history is byte-identical to the single-shot prompt", () => {
  const cites = buildCitations([hit()]);
  const single = buildSynthesisUserPrompt("What is Claude Code?", cites);
  const withEmpty = buildSynthesisUserPrompt("What is Claude Code?", cites, []);
  expect(withEmpty).toBe(single);
  expect(single).toContain("Question: What is Claude Code?");
  expect(single).not.toContain("Conversation so far");
});

test("buildSynthesisUserPrompt: a follow-up embeds the conversation block, the follow-up, and the sources", () => {
  const cites = buildCitations([hit()]);
  const prompt = buildSynthesisUserPrompt("Does it support MCP?", cites, [
    { question: "What is Claude Code?", answer: "An agentic CLI tool." },
  ]);
  expect(prompt).toContain("Conversation so far");
  expect(prompt).toContain("Q1: What is Claude Code?");
  expect(prompt).toContain("A1: An agentic CLI tool.");
  expect(prompt).toContain("Follow-up question: Does it support MCP?");
  expect(prompt).toContain("[1] (Claude)");
  // Still instructs grounding in the numbered sources, not the prior turns.
  expect(prompt).toContain("only these numbered sources");
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

// --- buildSynthesisSystemPrompt / SYNTHESIS_SYSTEM_PROMPT ------------------

// Regression pin: the /research (Learning Center) prompt must stay byte-for-byte
// identical after the refactor extracted the shared rules body. If this fails,
// the extraction changed the /research behavior — not allowed.
const LC_SYNTHESIS_PROMPT_PIN = `You answer questions about Anthropic and the Claude ecosystem for a personal learning center, using ONLY the numbered sources provided in the user message.

Rules:
- Ground every claim in the sources. After each claim, cite the source(s) you used with bracketed numbers like [1] or [2][3]. Cite the specific source, not a range.
- Do NOT use any tools or outside knowledge — answer solely from the provided sources.
- If the sources do not actually answer the question, say so plainly in one sentence instead of guessing. Never invent details, URLs, or version numbers.
- This may be a follow-up in an ongoing conversation. When a "Conversation so far" block is present, use it ONLY to resolve what the new question refers to (pronouns, "that", "it") — still ground every claim in the numbered sources, never cite or treat the prior turns as fact.
- Be concise and direct. Use markdown: short paragraphs, bullet points for lists, **bold** for key terms. Lead with the answer, not a preamble.`;

test("SYNTHESIS_SYSTEM_PROMPT is byte-for-byte unchanged (regression pin)", () => {
  expect(SYNTHESIS_SYSTEM_PROMPT).toBe(LC_SYNTHESIS_PROMPT_PIN);
});

test("buildSynthesisSystemPrompt lands the framing line first, shares the rules body", () => {
  const framing = 'You answer questions about the "jarvis" knowledge wiki, using ONLY the numbered sources provided in the user message.';
  const prompt = buildSynthesisSystemPrompt(framing);
  // Framing is the opening sentence.
  expect(prompt.startsWith(framing + "\n\n")).toBe(true);
  // The rules body is identical to the LC prompt's (only the first line differs).
  const rulesOf = (p: string) => p.slice(p.indexOf("Rules:"));
  expect(rulesOf(prompt)).toBe(rulesOf(SYNTHESIS_SYSTEM_PROMPT));
  // Wiki framing carries no false "for its owner" claim.
  expect(prompt).not.toContain("for its owner");
});
