import { test, expect, beforeEach, mock } from "bun:test";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ResearchHit, ResearchKnowledgeResult } from "../ai/research-knowledge.ts";
import type { AnswerEvent } from "./ask.ts";

// --- Module mocks (registered before the dynamic import below) ---
// Retrieval and the Claude synthesis call are mocked so the orchestration runs
// without a live Huginn or a `claude` spawn. Behaviour is driven by the mutable
// vars below, reset to a happy-path default in beforeEach.

let mockResults: ResearchHit[] = [];
let mockLowConfidence = false;
let researchThrows: string | null = null;
let lastResearchOpts: Record<string, unknown> | null = null;

let claudeAnswer = "";
let lastUserPrompt = "";
let lastSystemPrompt = "";

function makeHit(over: Partial<ResearchHit> = {}): ResearchHit {
  return {
    collection: "anthropic-summaries",
    id: "ai/claude-code/Claude Code overview.md",
    title: "Claude Code overview.md",
    url: "https://docs.anthropic.com/en/docs/claude-code/overview",
    relevance: 0.92,
    matchedChunks: [{ content: "Claude Code is an agentic CLI coding tool." }],
    viaSubQuestion: ["q"],
    ...over,
  };
}

mock.module("../ai/research-knowledge.ts", () => ({
  researchKnowledge: async (opts: Record<string, unknown>): Promise<ResearchKnowledgeResult> => {
    lastResearchOpts = opts;
    if (researchThrows) throw new Error(researchThrows);
    return {
      results: mockResults,
      decomposition: { subQuestions: ["q"], rationale: "passthrough", passthrough: true, haikuMs: 5 },
      subSearches: [{ subQuestion: "q", durationMs: 10, resultCount: mockResults.length, lowConfidence: mockLowConfidence }],
      traceId: "trace-123",
    };
  },
}));

mock.module("../ai/executor.ts", () => ({
  executeClaudePrompt: async (
    prompt: string,
    _c: unknown,
    _b: unknown,
    sys?: string,
    onProgress?: (e: { type: string; text: string }) => void,
  ) => {
    lastUserPrompt = prompt;
    lastSystemPrompt = sys ?? "";
    onProgress?.({ type: "text_delta", text: claudeAnswer });
    return { result: claudeAnswer, outputTokens: 30, inputTokens: 12, wallClockMs: 4 };
  },
}));

const { streamResearchAnswer } = await import("./ask.ts");

const config = { knowledgeApiUrl: "http://kb.test" } as unknown as Config;
const bot = { name: "jarvis", dir: "/tmp/jarvis", connector: "claude-cli" } as unknown as BotConfig;

async function collect(
  question: string,
  history?: Array<{ question: string; answer: string }>,
): Promise<AnswerEvent[]> {
  const events: AnswerEvent[] = [];
  await streamResearchAnswer({ question, config, botConfig: bot, history }, (e) => {
    events.push(e);
  });
  return events;
}

beforeEach(() => {
  mockResults = [makeHit(), makeHit({ collection: "wiki", id: "concepts/mcp.md", title: "MCP", url: undefined, relevance: 0.6 })];
  mockLowConfidence = false;
  researchThrows = null;
  lastResearchOpts = null;
  claudeAnswer = "Claude Code is an agentic CLI [1]. It supports MCP servers [2].";
  lastUserPrompt = "";
  lastSystemPrompt = "";
});

test("happy path: emits phase → sources → deltas → done with cited indices", async () => {
  const events = await collect("What is Claude Code and does it support MCP?");
  const types = events.map((e) => e.type);

  expect(types[0]).toBe("phase");
  expect(types).toContain("sources");
  expect(types).toContain("delta");
  expect(types[types.length - 1]).toBe("done");

  const sources = events.find((e) => e.type === "sources") as Extract<AnswerEvent, { type: "sources" }>;
  expect(sources.citations).toHaveLength(2);
  expect(sources.citations[0]!.badge).toBe("Claude");
  expect(sources.traceId).toBe("trace-123");

  const done = events.find((e) => e.type === "done") as Extract<AnswerEvent, { type: "done" }>;
  expect(done.noHits).toBe(false);
  expect(done.lowConfidence).toBe(false);
  expect(done.answer).toContain("agentic CLI");
  expect(done.cited).toEqual([1, 2]);
});

test("passes the full corpus + bot context to researchKnowledge", async () => {
  await collect("anything");
  expect(lastResearchOpts).toBeTruthy();
  const collections = lastResearchOpts!.collections as string[];
  expect(collections).toEqual([
    "anthropic-summaries",
    "anthropic-knowledge",
    "youtube-summaries",
    "x-articles",
    "wiki",
  ]);
  expect(lastResearchOpts!.botName).toBe("jarvis");
  expect(lastResearchOpts!.botDir).toBe("/tmp/jarvis");
});

test("synthesis prompt carries the question and numbered sources, with the grounding system prompt", async () => {
  await collect("What is Claude Code?");
  expect(lastUserPrompt).toContain("Question: What is Claude Code?");
  expect(lastUserPrompt).toContain("[1] (Claude)");
  expect(lastUserPrompt).toContain("[2] (Wiki)");
  expect(lastSystemPrompt).toContain("ONLY the numbered sources");
});

test("empty history: retrieval uses the raw question and the prompt has no conversation block", async () => {
  await collect("What is Claude Code?");
  expect(lastResearchOpts!.question).toBe("What is Claude Code?");
  expect(lastUserPrompt).toContain("Question: What is Claude Code?");
  expect(lastUserPrompt).not.toContain("Conversation so far");
});

test("follow-up: prior turns fold into the retrieval query AND the synthesis prompt", async () => {
  await collect("Does it support MCP?", [
    { question: "What is Claude Code?", answer: "An agentic CLI tool." },
  ]);
  // Retrieval query is contextualized so the decomposer can resolve "it".
  const retrievalQ = lastResearchOpts!.question as string;
  expect(retrievalQ).toContain("What is Claude Code?");
  expect(retrievalQ).toContain("Does it support MCP?");
  // Synthesis prompt carries the conversation block + the follow-up.
  expect(lastUserPrompt).toContain("Conversation so far");
  expect(lastUserPrompt).toContain("A1: An agentic CLI tool.");
  expect(lastUserPrompt).toContain("Follow-up question: Does it support MCP?");
});

test("no hits: skips the Claude call and answers with the honest fallback", async () => {
  mockResults = [];
  const events = await collect("something not indexed");
  expect(lastUserPrompt).toBe(""); // executeClaudePrompt never called
  const done = events.find((e) => e.type === "done") as Extract<AnswerEvent, { type: "done" }>;
  expect(done.noHits).toBe(true);
  expect(done.lowConfidence).toBe(false);
  expect(done.answer.toLowerCase()).toContain("couldn't find");
  expect(done.cited).toEqual([]);
});

test("low confidence: weak-but-nonzero retrieval declines synthesis but still shows the sources", async () => {
  // Documents came back, but Huginn flagged every sub-search lowConfidence —
  // the honest relevance floor declines rather than grounding on weak neighbours.
  mockLowConfidence = true;
  const events = await collect("a loosely-related off-topic question");

  // Sources still ride out so the reader can open and judge the weak matches.
  const sources = events.find((e) => e.type === "sources") as Extract<AnswerEvent, { type: "sources" }>;
  expect(sources.citations).toHaveLength(2);

  expect(lastUserPrompt).toBe(""); // no Claude synthesis call spent
  const done = events.find((e) => e.type === "done") as Extract<AnswerEvent, { type: "done" }>;
  expect(done.noHits).toBe(true);
  expect(done.lowConfidence).toBe(true);
  expect(done.answer.toLowerCase()).toContain("don't confidently cover");
  expect(done.cited).toEqual([]);
});

test("retrieval failure surfaces as a single error event, never throws", async () => {
  researchThrows = "huginn down";
  const events = await collect("q");
  const err = events.find((e) => e.type === "error") as Extract<AnswerEvent, { type: "error" }>;
  expect(err).toBeTruthy();
  expect(err.message).toContain("huginn down");
  expect(events.some((e) => e.type === "done")).toBe(false);
});
