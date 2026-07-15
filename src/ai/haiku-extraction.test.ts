import { test, expect, beforeEach, describe, mock } from "bun:test";
import type { Logger } from "@logtape/logtape";
import { agentStatus } from "../observability/agent-status.ts";

// --- Module mock: the Haiku call is stubbed so the extractor runs without a
// live backend. `mockResult` drives the returned raw text (valid JSON vs garbage
// exercises the parse-failure early return). Registered before the dynamic
// import below, per the repo's mock.module convention. ---

let mockResult = "";
// Usage returned by the mocked Haiku call — used to assert (b) folds model +
// tokens into the extractor tracer's finish attributes.
let mockUsage = { inputTokens: 11, outputTokens: 7, model: "claude-haiku-4-5-20251001" };
// Records the opts passed to the router so (a) — the tracer join — is assertable.
const haikuOpts: Array<Record<string, unknown>> = [];

mock.module("./haiku-direct.ts", () => ({
  callHaikuWithFallback: async (_prompt: string, opts: Record<string, unknown>) => {
    haikuOpts.push(opts);
    return { result: mockResult, ...mockUsage };
  },
}));

// Fake Tracer capturing finish() attributes so we can assert the (b) usage
// stamping without a live DB. Only the surface doExtract touches is implemented.
const finishCalls: Array<{ status: string; attributes?: Record<string, unknown> }> = [];
class FakeTracer {
  readonly traceId: string;
  constructor(_name: string, opts: { traceId?: string } = {}) {
    this.traceId = opts.traceId ?? "fake-trace";
  }
  finish(status: "ok" | "error" = "ok", attributes?: Record<string, unknown>): void {
    finishCalls.push({ status, attributes });
  }
}
mock.module("../tracing/index.ts", () => ({ Tracer: FakeTracer }));

const { runHaikuExtraction } = await import("./haiku-extraction.ts");

// A silent logger stub — extraction logging is fire-and-forget and irrelevant here.
const log = {
  error: () => {},
  info: () => {},
  warn: () => {},
  debug: () => {},
} as unknown as Logger;

function baseOpts<T>(over: Partial<Parameters<typeof runHaikuExtraction<T>>[0]> = {}) {
  return {
    spanName: "memory_extraction",
    source: "memory",
    entrypoint: "jarvis-memory",
    botName: "jarvis",
    userId: "u1",
    prompt: "extract",
    log,
    onResult: async () => {},
    ...over,
  } as Parameters<typeof runHaikuExtraction<T>>[0];
}

/** Let the fire-and-forget extraction settle (runTrackedExtraction schedules it). */
const settle = () => new Promise((r) => setTimeout(r, 15));

describe("runHaikuExtraction — AgentRun registry mirror", () => {
  beforeEach(() => agentStatus.clearRequest()); // reset the singleton between cases

  test("registers an extractor run named from the source and completes on success", async () => {
    mockResult = JSON.stringify({ ok: true });
    let got: unknown;
    runHaikuExtraction<{ ok: boolean }>(baseOpts({ onResult: async (r) => { got = r; } }));
    await settle();

    expect(got).toEqual({ ok: true }); // onResult ran
    const run = agentStatus.getRecentCompleted().find((r) => r.kind === "extractor");
    expect(run).toBeDefined();
    expect(run!.name).toBe("Extractor: memory");
    expect(run!.botName).toBe("jarvis");
    // No live extractor run leaks past completion.
    expect(agentStatus.getAll().some((r) => r.kind === "extractor" && !r.completed)).toBe(false);
  });

  test("PARSE-FAILURE exit: the early return still completes the run (no leak)", async () => {
    // This is the third exit doExtract has — it returns after tracer.finish("error")
    // WITHOUT calling onResult or throwing. Only a finally completes the run here,
    // so this is the case that would leak the run forever if it were missed.
    mockResult = "this is not JSON at all {{{";
    let onResultCalled = false;
    runHaikuExtraction(baseOpts({ onResult: async () => { onResultCalled = true; } }));
    await settle();

    expect(onResultCalled).toBe(false); // parse failed before onResult
    expect(agentStatus.getRecentCompleted().some((r) => r.kind === "extractor")).toBe(true);
    expect(agentStatus.getAll().some((r) => r.kind === "extractor" && !r.completed)).toBe(false);
  });

  test("onResult throw: the run is still completed (never leaks)", async () => {
    mockResult = JSON.stringify({ ok: true });
    runHaikuExtraction(baseOpts({ onResult: async () => { throw new Error("db down"); } }));
    await settle();

    expect(agentStatus.getRecentCompleted().some((r) => r.kind === "extractor")).toBe(true);
    expect(agentStatus.getAll().some((r) => r.kind === "extractor" && !r.completed)).toBe(false);
  });

  test("the run name derives from opts.source (goals / schedule)", async () => {
    mockResult = JSON.stringify({ ok: true });
    runHaikuExtraction(baseOpts({ source: "goals", spanName: "goal_extraction" }));
    runHaikuExtraction(baseOpts({ source: "schedule", spanName: "schedule_extraction" }));
    await settle();
    const names = agentStatus.getRecentCompleted()
      .filter((r) => r.kind === "extractor")
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(["Extractor: goals", "Extractor: schedule"]);
  });
});

describe("runHaikuExtraction — trace_id join + usage stamping (obs-tail #1)", () => {
  beforeEach(() => {
    agentStatus.clearRequest();
    finishCalls.length = 0;
    haikuOpts.length = 0;
    mockResult = JSON.stringify({ ok: true });
    mockUsage = { inputTokens: 11, outputTokens: 7, model: "claude-haiku-4-5-20251001" };
  });

  test("(a) threads the tracer into the router when traceContext is set", async () => {
    runHaikuExtraction(
      baseOpts({ traceContext: { traceId: "req-trace", parentId: "req-parent" } }),
    );
    await settle();
    expect(haikuOpts).toHaveLength(1);
    expect((haikuOpts[0]!.tracer as { traceId: string }).traceId).toBe("req-trace");
  });

  test("(a) no tracer threaded when traceContext is absent", async () => {
    runHaikuExtraction(baseOpts());
    await settle();
    expect(haikuOpts).toHaveLength(1);
    expect(haikuOpts[0]!.tracer).toBeUndefined();
  });

  test("(b) folds model + tokens into the tracer finish, alongside onResult attrs", async () => {
    runHaikuExtraction(
      baseOpts({
        traceContext: { traceId: "req-trace", parentId: "req-parent" },
        onResult: async (_r, tracer) => {
          tracer?.finish("ok", { worthRemembering: true });
        },
      }),
    );
    await settle();
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0]!.status).toBe("ok");
    expect(finishCalls[0]!.attributes).toMatchObject({
      worthRemembering: true,
      model: "claude-haiku-4-5-20251001",
      inputTokens: 11,
      outputTokens: 7,
    });
  });

  test("(b) usage is stamped on the parse-failure finish too", async () => {
    mockResult = "not json {{{";
    runHaikuExtraction(
      baseOpts({ traceContext: { traceId: "req-trace", parentId: "req-parent" } }),
    );
    await settle();
    // The parse-failure path finishes with status "error" — usage still folds in.
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0]!.status).toBe("error");
    expect(finishCalls[0]!.attributes).toMatchObject({
      error: "parse_failed",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 11,
      outputTokens: 7,
    });
  });
});
