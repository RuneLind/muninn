import { test, expect, describe } from "bun:test";
import type { Tracer } from "../tracing/index.ts";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import type { executeOneShot } from "../ai/one-shot.ts";
import { runDrafterOneShot, DRAFTER_EXCLUDED_TOOLS } from "./drafter-oneshot.ts";

/** Minimal tracer double — the drafter seam only starts/ends spans and reads ids. */
function fakeTracer(): Tracer {
  let n = 0;
  const tracer: Pick<
    Tracer,
    "start" | "end" | "finish" | "addChildSpan" | "addSubSpan" | "spanStartedAt" | "traceId"
  > = {
    traceId: "trace-1",
    start: () => `span-${++n}`,
    end: () => 1,
    finish: () => undefined as unknown as ReturnType<Tracer["finish"]>,
    addChildSpan: () => `child-${++n}`,
    addSubSpan: () => `sub-${++n}`,
    spanStartedAt: () => new Date(),
  };
  return tracer as Tracer;
}

const config = { tracingEnabled: false } as unknown as Config;

function bot(over: Partial<BotConfig> = {}): BotConfig {
  return { name: "jarvis", connector: "claude-sdk", model: "sonnet", ...over } as BotConfig;
}

function result(): ClaudeExecResult {
  return { result: "---\ntype: source\n---\n" } as ClaudeExecResult;
}

/** Runs the drafter and hands back the botConfig the connector seam actually saw. */
async function capturedBotConfig(botConfig: BotConfig): Promise<BotConfig> {
  let seen: BotConfig | null = null;
  const oneShot = (async (_prompt, _config, bc) => {
    seen = bc;
    return result();
  }) as typeof executeOneShot;

  await runDrafterOneShot({
    title: "Retrieval-Augmented Generation",
    url: "https://example.com/x",
    prompt: "draft it",
    config,
    botConfig,
    tracer: fakeTracer(),
    oneShot,
  });
  if (!seen) throw new Error("one-shot seam was never called");
  return seen;
}

describe("runDrafterOneShot tool fence", () => {
  // The 2026-07-28 escape: with a full tool surface the drafter can Write the .mdx
  // to disk and return "File created successfully at: …", which carries no
  // frontmatter — the draft is lost with no proposal row and no gate entry.
  test("fences the file-writing tools on the model call", async () => {
    const seen = await capturedBotConfig(bot());
    for (const tool of DRAFTER_EXCLUDED_TOOLS) {
      expect(seen.excludedTools).toContain(tool);
    }
    expect(seen.excludedTools).toContain("Write");
  });

  test("keeps the bot's own exclusions and never duplicates an overlap", async () => {
    const seen = await capturedBotConfig(bot({ excludedTools: ["mcp__gmail", "Write"] }));
    expect(seen.excludedTools).toContain("mcp__gmail");
    expect(seen.excludedTools!.filter((t) => t === "Write").length).toBe(1);
  });

  test("does not mutate the caller's botConfig", async () => {
    const original = bot();
    await capturedBotConfig(original);
    expect(original.excludedTools).toBeUndefined();
  });

  test("leaves connector and model identity untouched", async () => {
    const seen = await capturedBotConfig(bot());
    expect(seen.name).toBe("jarvis");
    expect(seen.connector).toBe("claude-sdk");
    expect(seen.model).toBe("sonnet");
  });
});
