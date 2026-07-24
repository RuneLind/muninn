import { test, expect, describe } from "bun:test";
import type { Tracer } from "../tracing/index.ts";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import type { ToolCall } from "../types.ts";
import { tracedOneShot } from "./traced-one-shot.ts";

/**
 * Records start/end calls and (optionally) throws from addChildSpan so we can
 * drive the seam's attachToolSpans failure path. Exposes only what the seam +
 * attachToolSpans actually touch.
 */
function recordingTracer(opts: { throwOnChildSpan?: boolean } = {}) {
  const starts: { label: string; attributes?: Record<string, unknown> }[] = [];
  const ends: { label: string; attributes?: Record<string, unknown> }[] = [];
  let n = 0;
  const tracer: Pick<Tracer, "start" | "end" | "addChildSpan" | "addSubSpan" | "spanStartedAt"> = {
    start(label, attributes) {
      starts.push({ label, attributes });
      return `span-${++n}`;
    },
    end(label, attributes) {
      ends.push({ label, attributes });
      return 1;
    },
    addChildSpan(_parentLabel, _name, _durationMs, _attributes, _startOffsetMs) {
      if (opts.throwOnChildSpan) throw new Error("addChildSpan boom");
      return `child-${++n}`;
    },
    addSubSpan() {
      return `sub-${++n}`;
    },
    spanStartedAt() {
      return new Date();
    },
  };
  return { tracer: tracer as Tracer, starts, ends };
}

function makeResult(over: Partial<ClaudeExecResult> = {}): ClaudeExecResult {
  return {
    result: "the answer",
    costUsd: 0.0123,
    durationMs: 4200,
    durationApiMs: 4000,
    numTurns: 2,
    model: "claude-sonnet-4-6",
    inputTokens: 1500,
    outputTokens: 220,
    wallClockMs: 4300,
    toolCalls: [],
    ...over,
  };
}

function makeToolCall(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "toolu_01",
    name: "Read",
    displayName: "Read",
    durationMs: 20,
    startOffsetMs: 5,
    input: "{}",
    ...over,
  };
}

const config = { tracingCaptureToolOutputs: false } as Config;
const botConfig = { connector: "claude-sdk", model: "sonnet" } as BotConfig;

describe("tracedOneShot", () => {
  test("stamps connector + requestedModel + merged startAttrs on the START span", async () => {
    const { tracer, starts } = recordingTracer();
    await tracedOneShot(tracer, "claude", "prompt", config, botConfig, {
      oneShot: async () => makeResult(),
      startAttrs: { source: "capture", title: "hi" },
    });
    expect(starts).toHaveLength(1);
    expect(starts[0]!.label).toBe("claude");
    expect(starts[0]!.attributes).toEqual({
      connector: "claude-sdk",
      requestedModel: "sonnet",
      source: "capture",
      title: "hi",
    });
  });

  test("defaults connector to claude-cli when botConfig omits it", async () => {
    const { tracer, starts } = recordingTracer();
    await tracedOneShot(tracer, "claude", "prompt", config, { model: "sonnet" } as BotConfig, {
      oneShot: async () => makeResult(),
    });
    expect(starts[0]!.attributes).toMatchObject({ connector: "claude-cli", requestedModel: "sonnet" });
  });

  test("stamps the connector-reported metrics on the success END span", async () => {
    const { tracer, ends } = recordingTracer();
    const result = await tracedOneShot(tracer, "claude", "prompt", config, botConfig, {
      oneShot: async () => makeResult({ toolCalls: [makeToolCall(), makeToolCall({ id: "toolu_02" })] }),
    });
    expect(result.result).toBe("the answer");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.label).toBe("claude");
    expect(ends[0]!.attributes).toEqual({
      model: "claude-sonnet-4-6",
      inputTokens: 1500,
      outputTokens: 220,
      numTurns: 2,
      costUsd: 0.0123,
      toolCount: 2,
      durationMs: 4200,
    });
  });

  test("uses the label as the span key (indexed fan-out labels are honored)", async () => {
    const { tracer, starts, ends } = recordingTracer();
    await tracedOneShot(tracer, "claude:claim-3", "prompt", config, botConfig, {
      oneShot: async () => makeResult(),
    });
    expect(starts[0]!.label).toBe("claude:claim-3");
    expect(ends[0]!.label).toBe("claude:claim-3");
  });

  test("on a oneShot throw: error-ends the span ONCE with { error } and rethrows", async () => {
    const { tracer, ends } = recordingTracer();
    await expect(
      tracedOneShot(tracer, "claude", "prompt", config, botConfig, {
        oneShot: async () => {
          throw new Error("connector exploded");
        },
      }),
    ).rejects.toThrow("connector exploded");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.attributes).toEqual({ error: "connector exploded" });
  });

  test("attachToolSpans failure does NOT re-end the span and the caller still gets the result", async () => {
    // addChildSpan throws → attachToolSpans throws → the seam's inner try/catch
    // swallows it. The span was already end()ed on success, so it must NOT be
    // re-ended (a second end would throw `No active mark` and mask the result).
    const { tracer, ends } = recordingTracer({ throwOnChildSpan: true });
    const result = await tracedOneShot(tracer, "claude", "prompt", config, botConfig, {
      oneShot: async () => makeResult({ toolCalls: [makeToolCall()] }),
    });
    // Caller still gets the real result.
    expect(result.result).toBe("the answer");
    // Exactly one end — the success end. No error re-end.
    expect(ends).toHaveLength(1);
    expect(ends[0]!.attributes).toMatchObject({ model: "claude-sonnet-4-6" });
  });
});
