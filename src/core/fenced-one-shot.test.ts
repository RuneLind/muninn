/**
 * The `onProgress` passthrough on {@link runFencedOneShot}.
 *
 * `FencedOneShotOptions` had no `onProgress` while the underlying `tracedOneShot`
 * has always had one — so a fenced call could not stream, which is the one thing
 * the share route needs from it. The passthrough is additive, and the two existing
 * callers (the source-page drafter, the fact-check integrate proposer) pass
 * nothing: the assertion that matters as much as "a delta arrives" is that an
 * omitted callback leaves the connector's option object WITHOUT an `onProgress`
 * key, i.e. the call shape those two callers make is unchanged.
 *
 * Driven through the real `runFencedOneShot` with its two documented test seams
 * (`tracer`, `oneShot`), so nothing here touches the DB or a model.
 */

import { test, expect, describe, spyOn } from "bun:test";
import type { Tracer } from "../tracing/index.ts";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { runFencedOneShot, FENCED_EXCLUDED_TOOLS } from "./fenced-one-shot.ts";

/** The slice of `Tracer` the seam + `tracedOneShot` actually touch. */
function fakeTracer(): Tracer {
  let n = 0;
  const tracer: Pick<
    Tracer,
    "start" | "end" | "addChildSpan" | "addSubSpan" | "spanStartedAt" | "finish" | "traceId"
  > = {
    traceId: "trace-1",
    start: () => `span-${++n}`,
    end: () => 1,
    addChildSpan: () => `child-${++n}`,
    addSubSpan: () => `sub-${++n}`,
    spanStartedAt: () => new Date(),
    finish: () => undefined,
  };
  return tracer as Tracer;
}

const config = { tracingEnabled: false, tracingCaptureToolOutputs: false } as Config;
const botConfig = { name: "testbot", dir: "/tmp/testbot", connector: "claude-sdk" } as BotConfig;

/** Records the options the connector was handed, and replays scripted deltas. */
function recordingOneShot(deltas: string[] = []) {
  const seen: Record<string, unknown>[] = [];
  const oneShot = async (
    _prompt: string,
    _config: unknown,
    _bot: unknown,
    opts?: Record<string, unknown>,
  ) => {
    seen.push(opts ?? {});
    const onProgress = opts?.onProgress as ((e: unknown) => void) | undefined;
    for (const text of deltas) onProgress?.({ type: "text_delta", text });
    return { result: "done", inputTokens: 1, outputTokens: 2, numTurns: 1, durationMs: 1 };
  };
  return { oneShot, seen };
}

const base = {
  traceName: "share",
  platform: "share",
  kind: "capture" as const,
  phase: "calling_claude" as const,
  runName: "Share test",
  sourcePage: "/wiki",
  source: "share",
  prompt: "Summarize this.",
  config,
  botConfig,
};

describe("runFencedOneShot — onProgress passthrough", () => {
  test("forwards every connector delta to the caller's callback", async () => {
    const { oneShot } = recordingOneShot(["Hel", "lo"]);
    const got: string[] = [];
    await runFencedOneShot({
      ...base,
      tracer: fakeTracer(),
      oneShot: oneShot as never,
      onProgress: (e) => {
        if (e.type === "text_delta") got.push(e.text);
      },
    });
    expect(got).toEqual(["Hel", "lo"]);
  });

  test("a caller that omits it leaves the connector options without the key", async () => {
    // The two existing callers (drafter, integrate proposer) pass nothing. A
    // spread-in-only-when-present option is what keeps their call byte-identical
    // — `{ onProgress: undefined }` is a DIFFERENT object shape, and a connector
    // that tests `"onProgress" in opts` would change behaviour for them.
    const { oneShot, seen } = recordingOneShot(["ignored"]);
    await runFencedOneShot({ ...base, tracer: fakeTracer(), oneShot: oneShot as never });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!)).not.toContain("onProgress");
  });

  test("the fence still binds when a progress callback is supplied", async () => {
    // A streaming caller must not be a way around the exclude list.
    const { oneShot, seen } = recordingOneShot();
    let bot: BotConfig | undefined;
    await runFencedOneShot({
      ...base,
      tracer: fakeTracer(),
      oneShot: (async (_p: string, _c: unknown, b: BotConfig, o: Record<string, unknown>) => {
        bot = b;
        return (await (oneShot as never as typeof oneShot)(_p, _c, b, o)) as never;
      }) as never,
      onProgress: () => {},
    });
    expect(seen).toHaveLength(1);
    for (const tool of FENCED_EXCLUDED_TOOLS) expect(bot!.excludedTools).toContain(tool);
    // The tool-less surface is declared, and executeOneShot applies it.
    expect(seen[0]!.toolSurface).toBe("none");
  });

  test("the real claude-cli argv is tool-less: no built-ins, no MCP server", async () => {
    // No `oneShot` seam: the declared "none" goes through the real executeOneShot
    // and applyToolSurface to the spawned argv, so a dropped or wrong surface fails here.
    const spawned: string[][] = [];
    const resultLine = JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "ok",
      duration_ms: 5, duration_api_ms: 4, num_turns: 1, total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      spawned.push(args);
      return {
        pid: 1,
        stdout: new Response(resultLine + "\n").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }) as never);
    try {
      await runFencedOneShot({
        ...base,
        config: { ...config, claudeModel: "claude-sonnet-4-5", claudeTimeoutMs: 30_000 } as Config,
        botConfig: { ...botConfig, connector: "claude-cli" },
        tracer: fakeTracer(),
      });
    } finally {
      spawnSpy.mockRestore();
    }
    expect(spawned).toHaveLength(1);
    const args = spawned[0]!;
    expect(args.flatMap((a, i) => (a === "--tools" ? [args[i + 1]] : []))).toEqual([""]);
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
  });

  test("the deny-list covers 2.1.281's escapes", () => {
    // Measured from a fenced init event on Claude Code 2.1.281: each of these was
    // on the surface the old eight-name deny-list left open.
    for (const tool of [
      "Workflow", "Monitor", "SendMessage", "ListAgents", "EnterWorktree",
      "RemoteTrigger", "CronCreate", "ScheduleWakeup", "PushNotification", "DesignSync",
    ]) {
      expect(FENCED_EXCLUDED_TOOLS).toContain(tool);
    }
  });
});

describe("runFencedOneShot — effort", () => {
  /** A tracer that keeps the `claude` span's start attributes. */
  function attrTracer() {
    const starts: Record<string, unknown>[] = [];
    const t = fakeTracer();
    t.start = ((label: string, attrs?: Record<string, unknown>) => {
      if (label === "claude") starts.push(attrs ?? {});
      return "span-x";
    }) as Tracer["start"];
    return { tracer: t, starts };
  }

  test("the default cap sends effort low, and the span records it beside the budget", async () => {
    const { oneShot, seen } = recordingOneShot();
    const { tracer, starts } = attrTracer();
    await runFencedOneShot({ ...base, tracer, oneShot: oneShot as never });
    expect(seen[0]!.effort).toBe("low");
    expect(starts[0]).toMatchObject({ thinkingMaxTokens: 8000, effort: "low" });
  });

  test("an explicit budget is forwarded without pinning effort to low", async () => {
    const { oneShot, seen } = recordingOneShot();
    const { tracer, starts } = attrTracer();
    await runFencedOneShot({ ...base, thinkingMaxTokens: 32_000, tracer, oneShot: oneShot as never });
    expect(seen[0]!.thinkingMaxTokens).toBe(32_000);
    expect(seen[0]!).not.toHaveProperty("effort");
    expect(starts[0]).not.toHaveProperty("effort");
  });

  test("openai-compat gets neither — there the budget field is max_tokens", async () => {
    const { oneShot, seen } = recordingOneShot();
    const local = { ...botConfig, connector: "openai-compat", baseUrl: "http://localhost:11434/v1" } as BotConfig;
    await runFencedOneShot({ ...base, botConfig: local, tracer: fakeTracer(), oneShot: oneShot as never });
    expect(seen[0]!).not.toHaveProperty("effort");
    expect(seen[0]!).not.toHaveProperty("thinkingMaxTokens");
  });
});
