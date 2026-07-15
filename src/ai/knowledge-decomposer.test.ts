import { test, expect, describe, beforeEach, mock } from "bun:test";

// Capture the opts handed to the Haiku router so we can assert the tracer (and
// thus its trace_id) is threaded through decomposeQuestion.
const haikuCalls: Array<{ prompt: string; opts: Record<string, unknown> }> = [];
mock.module("./haiku-direct.ts", () => ({
  callHaikuWithFallback: async (prompt: string, opts: Record<string, unknown>) => {
    haikuCalls.push({ prompt, opts });
    return { result: JSON.stringify({ subQuestions: ["q"], rationale: "r" }), inputTokens: 1, outputTokens: 1, model: "m" };
  },
}));

const { normalize, decomposeQuestion } = await import("./knowledge-decomposer.ts");

describe("decomposeQuestion tracer threading (obs-tail #1)", () => {
  beforeEach(() => { haikuCalls.length = 0; });

  test("passes the caller tracer to callHaikuWithFallback", async () => {
    const tracer = { traceId: "trace-xyz" } as unknown as import("../tracing/index.ts").Tracer;
    await decomposeQuestion({ question: "What is X?", botName: "jarvis", tracer });
    expect(haikuCalls).toHaveLength(1);
    expect(haikuCalls[0]!.opts.source).toBe("knowledge-decompose");
    expect((haikuCalls[0]!.opts.tracer as { traceId: string }).traceId).toBe("trace-xyz");
  });

  test("threads undefined tracer when none supplied", async () => {
    await decomposeQuestion({ question: "What is X?", botName: "jarvis" });
    expect(haikuCalls).toHaveLength(1);
    expect(haikuCalls[0]!.opts.tracer).toBeUndefined();
  });
});

describe("knowledge-decomposer normalize", () => {
  const original = "How does A001 differ from A002?";

  test("clamps a 1-element response to a passthrough", () => {
    const result = normalize({ subQuestions: ["What is BUC 02?"], rationale: "Single lookup." }, original, 42);
    expect(result.subQuestions).toEqual(["What is BUC 02?"]);
    expect(result.passthrough).toBe(true);
    expect(result.rationale).toBe("Single lookup.");
    expect(result.haikuMs).toBe(42);
  });

  test("preserves 2-element fan-out", () => {
    const result = normalize(
      { subQuestions: ["What is A001?", "What is A002?"], rationale: "Comparison" },
      original,
      10,
    );
    expect(result.subQuestions).toHaveLength(2);
    expect(result.passthrough).toBe(false);
    expect(result.rationale).toBe("Comparison");
  });

  test("preserves 4-element fan-out", () => {
    const result = normalize(
      { subQuestions: ["a", "b", "c", "d"], rationale: "" },
      original,
      0,
    );
    expect(result.subQuestions).toEqual(["a", "b", "c", "d"]);
    expect(result.passthrough).toBe(false);
  });

  test("clamps 5+ sub-questions to 4", () => {
    const result = normalize(
      { subQuestions: ["a", "b", "c", "d", "e", "f"], rationale: "too many" },
      original,
      0,
    );
    expect(result.subQuestions).toHaveLength(4);
    expect(result.subQuestions).toEqual(["a", "b", "c", "d"]);
    expect(result.passthrough).toBe(false);
  });

  test("0 sub-questions falls back to passthrough with original", () => {
    const result = normalize({ subQuestions: [], rationale: "nothing" }, original, 0);
    expect(result.subQuestions).toEqual([original]);
    expect(result.passthrough).toBe(true);
  });

  test("non-array subQuestions falls back to passthrough", () => {
    const result = normalize({ subQuestions: "not an array" as unknown as string[], rationale: "bad shape" }, original, 0);
    expect(result.subQuestions).toEqual([original]);
    expect(result.passthrough).toBe(true);
    expect(result.rationale).toBe("bad shape");
  });

  test("filters non-string entries", () => {
    const result = normalize(
      { subQuestions: ["good", 42, null, "also good"] as unknown as string[], rationale: "" },
      original,
      0,
    );
    expect(result.subQuestions).toEqual(["good", "also good"]);
    expect(result.passthrough).toBe(false);
  });

  test("trims whitespace and drops empty strings", () => {
    const result = normalize(
      { subQuestions: ["  trimmed  ", "", "   ", "also"], rationale: "" },
      original,
      0,
    );
    expect(result.subQuestions).toEqual(["trimmed", "also"]);
  });

  test("missing rationale gets a derived one", () => {
    const single = normalize({ subQuestions: ["x"] }, original, 0);
    expect(single.rationale).toBe("single sub-question");
    const multi = normalize({ subQuestions: ["x", "y", "z"] }, original, 0);
    expect(multi.rationale).toBe("3 sub-questions");
  });
});
