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

import { test, expect, describe } from "bun:test";
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
  });
});
