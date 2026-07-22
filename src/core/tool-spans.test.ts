import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { Tracer } from "../tracing/index.ts";
import type { ToolCall } from "../types.ts";
import { attachToolSpans } from "./tool-spans.ts";

interface ChildSpan {
  spanId: string;
  parentLabel: string;
  name: string;
  durationMs: number;
  attributes?: Record<string, unknown>;
  startOffsetMs?: number;
}

interface SubSpan {
  spanId: string;
  parentSpanId: string;
  name: string;
  durationMs: number;
  attributes?: Record<string, unknown>;
  opts?: { startOffsetMs?: number; parentStartedAt?: Date };
}

/** Minimal recording tracer that exposes only what attachToolSpans uses. */
function recordingTracer(opts: { claudeStartedAt?: Date } = {}) {
  const childSpans: ChildSpan[] = [];
  const subSpans: SubSpan[] = [];
  let n = 0;
  const tracer: Pick<Tracer, "addChildSpan" | "addSubSpan" | "spanStartedAt"> = {
    addChildSpan(parentLabel, name, durationMs, attributes, startOffsetMs) {
      const spanId = `child-${++n}`;
      childSpans.push({ spanId, parentLabel, name, durationMs, attributes, startOffsetMs });
      return spanId;
    },
    addSubSpan(parentSpanId, name, durationMs, attributes, subOpts) {
      const spanId = `sub-${++n}`;
      subSpans.push({ spanId, parentSpanId, name, durationMs, attributes, opts: subOpts });
      return spanId;
    },
    spanStartedAt(label) {
      return label === "claude" ? opts.claudeStartedAt : undefined;
    },
  };
  return { tracer: tracer as Tracer, childSpans, subSpans };
}

function makeToolCall(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "toolu_01",
    name: "mcp__gmail__search_emails",
    displayName: "search_emails (gmail)",
    durationMs: 50,
    startOffsetMs: 10,
    input: '{}',
    ...over,
  };
}

const KNOWLEDGE_TOOL = "mcp__knowledge__search_knowledge";

describe("attachToolSpans", () => {
  const originalEnv = {
    HUGINN_TRACE_POINTER: process.env.HUGINN_TRACE_POINTER,
    HUGINN_TRACE_DEFAULT: process.env.HUGINN_TRACE_DEFAULT,
  };
  beforeEach(() => {
    delete process.env.HUGINN_TRACE_POINTER;
    delete process.env.HUGINN_TRACE_DEFAULT;
  });
  afterEach(() => {
    if (originalEnv.HUGINN_TRACE_POINTER !== undefined) {
      process.env.HUGINN_TRACE_POINTER = originalEnv.HUGINN_TRACE_POINTER;
    }
    if (originalEnv.HUGINN_TRACE_DEFAULT !== undefined) {
      process.env.HUGINN_TRACE_DEFAULT = originalEnv.HUGINN_TRACE_DEFAULT;
    }
  });

  test("no-op when toolCalls is undefined or empty", async () => {
    const { tracer, childSpans } = recordingTracer();
    await attachToolSpans(tracer, undefined, true);
    await attachToolSpans(tracer, [], true);
    expect(childSpans).toHaveLength(0);
  });

  test("emits one child span per tool with core attrs", async () => {
    const { tracer, childSpans } = recordingTracer();
    await attachToolSpans(
      tracer,
      [makeToolCall({ id: "a", name: "Read", displayName: "Read", durationMs: 20, startOffsetMs: 5 })],
      false,
    );
    expect(childSpans).toHaveLength(1);
    const span = childSpans[0]!;
    expect(span.parentLabel).toBe("claude");
    expect(span.name).toBe("Read");
    expect(span.durationMs).toBe(20);
    expect(span.startOffsetMs).toBe(5);
    expect(span.attributes).toMatchObject({
      toolId: "a",
      toolName: "Read",
      input: "{}",
    });
  });

  test("defaults the parent label to 'claude'", async () => {
    const { tracer, childSpans } = recordingTracer();
    await attachToolSpans(tracer, [makeToolCall({ name: "Read", displayName: "Read" })], false);
    expect(childSpans[0]!.parentLabel).toBe("claude");
  });

  test("honors an explicit parentLabel (fact-check indexed claim span)", async () => {
    const { tracer, childSpans } = recordingTracer();
    await attachToolSpans(
      tracer,
      [makeToolCall({ name: "WebFetch", displayName: "WebFetch" })],
      false,
      "claude:claim-2",
    );
    expect(childSpans[0]!.parentLabel).toBe("claude:claim-2");
  });

  test("v1 stage sub-spans anchor to the given parentLabel's start", async () => {
    const claudeStart = new Date(2026, 4, 9, 12, 0, 0);
    // recordingTracer.spanStartedAt only returns a start for label "claude"; a
    // different parentLabel has no recorded start ⇒ no stage synthesis.
    const v1Trace = {
      schemaVersion: 1,
      collections: [{
        name: "c", indexer: "hybrid", fetchK: 10, candidates: [{ kept: true }],
        confidence: { lowConfidence: false, bestScore: -2 },
        timingsMs: { indexFetch: 80, chunkLoad: 20, rerank: 1400, titleBoost: 0, assembly: 1 },
      }],
    };
    const { tracer, subSpans } = recordingTracer({ claudeStartedAt: claudeStart });
    await attachToolSpans(
      tracer,
      [makeToolCall({ name: KNOWLEDGE_TOOL, searchTrace: v1Trace })],
      false,
      "claude:claim-0",
    );
    expect(subSpans).toHaveLength(0);
  });

  test("captureOutputs=false omits output attribute", async () => {
    const { tracer, childSpans } = recordingTracer();
    await attachToolSpans(tracer, [makeToolCall({ output: "the result" })], false);
    expect(childSpans[0]!.attributes!.output).toBeUndefined();
  });

  test("captureOutputs=true preserves output attribute", async () => {
    const { tracer, childSpans } = recordingTracer();
    await attachToolSpans(tracer, [makeToolCall({ output: "the result" })], true);
    expect(childSpans[0]!.attributes!.output).toBe("the result");
  });

  test("attaches mcpEnvIntended only for trace-emitting tools", async () => {
    process.env.HUGINN_TRACE_POINTER = "1";
    process.env.HUGINN_TRACE_DEFAULT = "1";
    const { tracer, childSpans } = recordingTracer();
    await attachToolSpans(
      tracer,
      [
        makeToolCall({ id: "g", name: "mcp__gmail__search", displayName: "search (gmail)" }),
        makeToolCall({ id: "k", name: KNOWLEDGE_TOOL, displayName: "search_knowledge (knowledge)" }),
      ],
      false,
    );
    const gmail = childSpans.find((s) => s.attributes!.toolId === "g")!;
    const knowledge = childSpans.find((s) => s.attributes!.toolId === "k")!;
    expect(gmail.attributes!.mcpEnvIntended).toBeUndefined();
    expect(knowledge.attributes!.mcpEnvIntended).toEqual({
      huginnTracePointer: "1",
      huginnTraceDefault: "1",
    });
  });

  describe("searchTrace handling", () => {
    test("passes through pre-populated searchTrace from connector", async () => {
      const trace = { schemaVersion: 1, collections: [] };
      const { tracer, childSpans } = recordingTracer();
      await attachToolSpans(
        tracer,
        [makeToolCall({ name: KNOWLEDGE_TOOL, searchTrace: trace, output: "body" })],
        true,
      );
      expect(childSpans[0]!.attributes!.searchTrace).toBe(trace);
      expect(childSpans[0]!.attributes!.output).toBe("body");
    });

    test("parses fenced trace from string output as fallback", async () => {
      const trace = { schemaVersion: 1, totalMs: 71 };
      const output = "Found 3 docs\n\n```huginn-trace\n" + JSON.stringify(trace) + "\n```";
      const { tracer, childSpans } = recordingTracer();
      await attachToolSpans(
        tracer,
        [makeToolCall({ name: KNOWLEDGE_TOOL, output })],
        true,
      );
      expect(childSpans[0]!.attributes!.searchTrace).toEqual(trace);
      expect(childSpans[0]!.attributes!.output).toBe("Found 3 docs");
    });

    test("leaves output untouched when there is no fence", async () => {
      const { tracer, childSpans } = recordingTracer();
      await attachToolSpans(
        tracer,
        [makeToolCall({ output: "no fence here" })],
        true,
      );
      expect(childSpans[0]!.attributes!.searchTrace).toBeUndefined();
      expect(childSpans[0]!.attributes!.output).toBe("no fence here");
    });

    test("skips parser fallback when output is undefined", async () => {
      const { tracer, childSpans } = recordingTracer();
      await attachToolSpans(
        tracer,
        [makeToolCall({ output: undefined })],
        true,
      );
      expect(childSpans[0]!.attributes!.searchTrace).toBeUndefined();
      expect(childSpans[0]!.attributes!.output).toBeUndefined();
    });
  });

  describe("Phase-2 pointer resolution", () => {
    test("awaits searchTraceFetch and merges resolved trace into span attrs", async () => {
      const trace = { schemaVersion: 1, totalMs: 42 };
      const { tracer, childSpans } = recordingTracer();
      const tc = makeToolCall({
        name: KNOWLEDGE_TOOL,
        searchTracePointer: "http://huginn/api/trace/abc",
        searchTraceFetch: Promise.resolve(trace),
      });
      await attachToolSpans(tracer, [tc], true);
      expect(childSpans[0]!.attributes!.searchTrace).toEqual(trace);
      // Side effect: the resolved trace is assigned back onto the tool call.
      expect(tc.searchTrace).toEqual(trace);
    });

    test("fail-soft when fetch resolves to null (404 / timeout)", async () => {
      const { tracer, childSpans } = recordingTracer();
      const tc = makeToolCall({
        name: KNOWLEDGE_TOOL,
        searchTraceFetch: Promise.resolve(null),
        output: "body",
      });
      await attachToolSpans(tracer, [tc], true);
      expect(childSpans[0]!.attributes!.searchTrace).toBeUndefined();
      expect(childSpans[0]!.attributes!.output).toBe("body");
      expect(tc.searchTrace).toBeUndefined();
    });

    test("fail-soft when fetch rejects", async () => {
      const { tracer, childSpans } = recordingTracer();
      const tc = makeToolCall({
        name: KNOWLEDGE_TOOL,
        searchTraceFetch: Promise.reject(new Error("network down")),
      });
      await attachToolSpans(tracer, [tc], true);
      expect(childSpans[0]!.attributes!.searchTrace).toBeUndefined();
      expect(tc.searchTrace).toBeUndefined();
    });

    test("does not await fetch when searchTrace is already populated by connector", async () => {
      // Use a never-resolving promise — if attachToolSpans awaited it, this test would hang.
      const neverResolves = new Promise<unknown>(() => {});
      const trace = { schemaVersion: 1, collections: [] };
      const { tracer, childSpans } = recordingTracer();
      await attachToolSpans(
        tracer,
        [makeToolCall({
          name: KNOWLEDGE_TOOL,
          searchTrace: trace,
          searchTraceFetch: neverResolves,
        })],
        true,
      );
      expect(childSpans[0]!.attributes!.searchTrace).toBe(trace);
    });

    test("resolves multiple pointer fetches in parallel", async () => {
      const traceA = { schemaVersion: 1, id: "a" };
      const traceB = { schemaVersion: 1, id: "b" };
      const { tracer, childSpans } = recordingTracer();
      await attachToolSpans(
        tracer,
        [
          makeToolCall({ id: "a", name: KNOWLEDGE_TOOL, searchTraceFetch: Promise.resolve(traceA) }),
          makeToolCall({ id: "b", name: KNOWLEDGE_TOOL, searchTraceFetch: Promise.resolve(traceB) }),
        ],
        false,
      );
      expect(childSpans.find((s) => s.attributes!.toolId === "a")!.attributes!.searchTrace).toEqual(traceA);
      expect(childSpans.find((s) => s.attributes!.toolId === "b")!.attributes!.searchTrace).toEqual(traceB);
    });
  });

  describe("v1 stage sub-span synthesis", () => {
    const v1Trace = {
      schemaVersion: 1,
      collections: [{
        name: "jira-issues",
        indexer: "hybrid",
        fetchK: 10,
        candidates: [{ kept: true }, { kept: false }],
        confidence: { lowConfidence: false, bestScore: -2 },
        timingsMs: { indexFetch: 80, chunkLoad: 20, rerank: 1400, titleBoost: 0, assembly: 1 },
      }],
    };

    test("emits per-stage sub-spans under the tool span when searchTrace is v1", async () => {
      const claudeStart = new Date(2026, 4, 9, 12, 0, 0);
      const { tracer, childSpans, subSpans } = recordingTracer({ claudeStartedAt: claudeStart });
      await attachToolSpans(
        tracer,
        [makeToolCall({
          name: KNOWLEDGE_TOOL,
          startOffsetMs: 50,
          durationMs: 1501,
          searchTrace: v1Trace,
        })],
        false,
      );
      const toolSpan = childSpans[0]!;
      const stages = subSpans.filter((s) => s.parentSpanId === toolSpan.spanId);
      expect(stages.map((s) => s.name)).toEqual([
        "index.fetch",
        "chunk.load",
        "rerank.ce",
        "assemble",
      ]);
      const expectedAnchor = new Date(claudeStart.getTime() + 50).getTime();
      expect(stages[0]!.opts!.parentStartedAt!.getTime()).toBe(expectedAnchor);
    });

    test("does not synthesize stage spans when claude span has no recorded start", async () => {
      const { tracer, subSpans } = recordingTracer({ claudeStartedAt: undefined });
      await attachToolSpans(
        tracer,
        [makeToolCall({ name: KNOWLEDGE_TOOL, searchTrace: v1Trace })],
        false,
      );
      expect(subSpans).toHaveLength(0);
    });

    test("does not synthesize stage spans when no searchTrace is attached", async () => {
      const { tracer, subSpans } = recordingTracer({ claudeStartedAt: new Date() });
      await attachToolSpans(
        tracer,
        [makeToolCall({ output: "no trace" })],
        true,
      );
      expect(subSpans).toHaveLength(0);
    });

    test("emits stage spans for parser-extracted trace too (not just connector-provided)", async () => {
      const output = "body\n\n```huginn-trace\n" + JSON.stringify(v1Trace) + "\n```";
      const { tracer, subSpans } = recordingTracer({ claudeStartedAt: new Date() });
      await attachToolSpans(
        tracer,
        [makeToolCall({ name: KNOWLEDGE_TOOL, output })],
        true,
      );
      expect(subSpans.map((s) => s.name)).toEqual([
        "index.fetch",
        "chunk.load",
        "rerank.ce",
        "assemble",
      ]);
    });
  });
});
