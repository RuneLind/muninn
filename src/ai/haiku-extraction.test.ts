import { test, expect, beforeEach, describe, mock } from "bun:test";
import type { Logger } from "@logtape/logtape";
import { agentStatus } from "../observability/agent-status.ts";

// --- Module mock: the Haiku call is stubbed so the extractor runs without a
// live backend. `mockResult` drives the returned raw text (valid JSON vs garbage
// exercises the parse-failure early return). Registered before the dynamic
// import below, per the repo's mock.module convention. ---

let mockResult = "";

mock.module("./haiku-direct.ts", () => ({
  callHaikuWithFallback: async () => ({ result: mockResult }),
}));

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
