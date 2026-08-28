import { test, expect, describe, beforeEach, mock } from "bun:test";

// Capture the opts handed to the Haiku router so we can assert the tracer (and
// thus its trace_id) is threaded through decomposeQuestion.
const haikuCalls: Array<{ prompt: string; opts: Record<string, unknown> }> = [];
let haikuBackendThatRan: string | undefined = "vertex";
/** Raw model text for the next call; null = the default one-sub-question JSON. */
let haikuResult: string | null = null;
let haikuThrow: Error | null = null;
mock.module("./haiku-direct.ts", () => ({
  callHaikuWithFallback: async (prompt: string, opts: Record<string, unknown>) => {
    haikuCalls.push({ prompt, opts });
    if (haikuThrow) throw haikuThrow;
    return {
      result: haikuResult ?? JSON.stringify({ subQuestions: ["q"], rationale: "r" }),
      inputTokens: 1, outputTokens: 1, model: "m",
      backend: haikuBackendThatRan,
    };
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

describe("decomposeQuestion surfaces the backend that ran", () => {
  beforeEach(() => { haikuCalls.length = 0; haikuBackendThatRan = "vertex"; haikuResult = null; haikuThrow = null; });

  // Without this the decomposer is the one router caller whose backend is
  // unobservable: the router falls back to the Claude CLI on any failure and
  // `decomposeQuestion` swallows a failure into a passthrough, so "it produced
  // sub-questions" says nothing about WHERE the question went. The compliance
  // question this whole path exists for ("did the lookup go to the same
  // endpoint as the answer?") is only answerable from this field.
  test("reports the backend the router actually used", async () => {
    const result = await decomposeQuestion({ question: "What is X?", botName: "jarvis" });
    expect(result.backend).toBe("vertex");
  });

  test("reports a CLI fallback as cli, not as the backend that was asked for", async () => {
    haikuBackendThatRan = "cli";
    const result = await decomposeQuestion({ question: "What is X?", botName: "jarvis", haikuBackend: "vertex" });
    expect(result.backend).toBe("cli");
  });
});

// The class check, made a test: `decomposeQuestion` has exactly SIX outcomes,
// and a consumer that has to tell "the decomposer worked" from "the decomposer
// gave up" needs all six classified. Two of them are VALID (a fan-out, and the
// one-sub-question passthrough the prompt explicitly prefers for a simple
// lookup) and four are degradation SITES carrying three KINDS. The two
// `malformed` sites carry whatever rationale the MODEL wrote whenever it
// supplied any, so no string match over `rationale` can separate them — which is
// how two rounds of regex in `scripts/smoke-vertex.ts` each closed one door and
// left the others open. The signal is structured here
// instead, once, and the `passthrough()` helper REQUIRES it so a new degradation
// site cannot forget.
describe("decomposeQuestion classifies its own degradations", () => {
  beforeEach(() => { haikuCalls.length = 0; haikuBackendThatRan = "vertex"; haikuResult = null; haikuThrow = null; });

  test("(1) the model call threw", async () => {
    haikuThrow = new Error("no credential");
    const r = await decomposeQuestion({ question: "What is X?", botName: "b" });
    expect(r).toMatchObject({ degraded: "call-failed", passthrough: true });
    // No backend: nothing ran to completion, so there is none to report.
    expect(r.backend).toBeUndefined();
  });

  test("(2) the answer was not JSON", async () => {
    haikuResult = "I'm afraid I can't do that.";
    const r = await decomposeQuestion({ question: "What is X?", botName: "b" });
    expect(r).toMatchObject({ degraded: "unparseable", passthrough: true, backend: "vertex" });
  });

  // The live case: valid JSON, wrong key, and the model's OWN rationale — which
  // is what a rationale regex sees and passes.
  test("(3) JSON with no subQuestions array, carrying the model's own rationale", async () => {
    haikuResult = JSON.stringify({ sub_questions: ["a", "b"], rationale: "Four focused queries are needed." });
    const r = await decomposeQuestion({ question: "What is X?", botName: "b" });
    expect(r.degraded).toBe("malformed");
    expect(r.rationale).toBe("Four focused queries are needed.");
  });

  test("(4) an array with nothing usable in it", async () => {
    haikuResult = JSON.stringify({ subQuestions: [42, "  "], rationale: "Two focused queries." });
    const r = await decomposeQuestion({ question: "What is X?", botName: "b" });
    expect(r.degraded).toBe("malformed");
  });

  // The two VALID outcomes. A one-sub-question answer is the cheap path the
  // prompt prefers, NOT a failure — classifying on `passthrough` alone would
  // report the decomposer broken every time it did the right thing.
  test("(5) a legitimate one-sub-question passthrough is not a degradation", async () => {
    haikuResult = JSON.stringify({ subQuestions: ["What is X?"], rationale: "Simple lookup." });
    const r = await decomposeQuestion({ question: "What is X?", botName: "b" });
    expect(r.passthrough).toBe(true);
    expect(r.degraded).toBeUndefined();
  });

  test("(6) a fan-out is not a degradation", async () => {
    haikuResult = JSON.stringify({ subQuestions: ["a", "b", "c"], rationale: "Comparison." });
    const r = await decomposeQuestion({ question: "What is X?", botName: "b" });
    expect(r.passthrough).toBe(false);
    expect(r.degraded).toBeUndefined();
    expect(r.subQuestions).toHaveLength(3);
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
