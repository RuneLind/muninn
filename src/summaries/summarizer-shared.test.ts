import { test, expect, describe } from "bun:test";
import {
  buildSummarySystemPrompt,
  ingestSummary,
  runCaptureOneShot,
  CAPTURE_THINKING_MAX_TOKENS,
} from "./summarizer-shared.ts";
import type { RunMeta, SimilarArticle } from "./job-store.ts";
import type { Tracer } from "../tracing/index.ts";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import type { OneShotOptions } from "../ai/one-shot.ts";

// --- buildSummarySystemPrompt ---

test("buildSummarySystemPrompt reproduces the youtube/x-article scaffold byte-for-byte", () => {
  const cats = ["ai/general", "tech", "science"];
  const built = buildSummarySystemPrompt(
    "You are a video content analyst. Summarize the following YouTube video transcript.",
    cats,
  );
  const expected = `You are a video content analyst. Summarize the following YouTube video transcript.

Instructions:
1. Start your response with EXACTLY this line: CATEGORY: <category>
   Choose from: ${cats.join(", ")}
2. Then add a blank line, then SUMMARY: on its own line
3. Then write a structured summary with:
   - ### Section headers for key topics
   - Bullet points with emoji prefixes
   - **Bold** for key terms and takeaways
   - Keep it concise but comprehensive`;
  expect(built).toBe(expected);
});

test("buildSummarySystemPrompt honors a custom structure-bullet list (anthropic variant)", () => {
  const cats = ["ai/general", "ai/claude"];
  const built = buildSummarySystemPrompt(
    "You are an analyst summarizing a new Anthropic / Claude ecosystem release (a docs page, blog post, changelog, or commit) for a personal learning shelf.",
    cats,
    [
      "- ### Section headers for key topics",
      "- Bullet points with emoji prefixes",
      "- **Bold** for key terms and takeaways",
      "- Lead with what changed and why it matters; keep it concise but comprehensive",
    ],
  );
  const expected = `You are an analyst summarizing a new Anthropic / Claude ecosystem release (a docs page, blog post, changelog, or commit) for a personal learning shelf.

Instructions:
1. Start your response with EXACTLY this line: CATEGORY: <category>
   Choose from: ${cats.join(", ")}
2. Then add a blank line, then SUMMARY: on its own line
3. Then write a structured summary with:
   - ### Section headers for key topics
   - Bullet points with emoji prefixes
   - **Bold** for key terms and takeaways
   - Lead with what changed and why it matters; keep it concise but comprehensive`;
  expect(built).toBe(expected);
});

// --- ingestSummary ---

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(input, init))) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

test("ingestSummary POSTs the body and passes returned similar articles to onSimilar", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  const restore = stubFetch((input, init) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ similar: [{ title: "S", url: "https://s" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const seen: SimilarArticle[] = [];
  try {
    await ingestSummary({
      knowledgeApiUrl: "http://kb.test",
      ingestPath: "/api/youtube/ingest",
      body: { title: "T", url: "u", summary: "sum", category: "ai/general" },
      onSimilar: (s) => seen.push(...s),
    });
  } finally {
    restore();
  }
  expect(capturedUrl).toBe("http://kb.test/api/youtube/ingest");
  expect(JSON.parse(capturedBody)).toEqual({ title: "T", url: "u", summary: "sum", category: "ai/general" });
  expect(seen).toEqual([{ title: "S", url: "https://s" }]);
});

test("ingestSummary surfaces the stored doc file_path via onIngested", async () => {
  const restore = stubFetch(
    () =>
      new Response(JSON.stringify({ file_path: "ai/general/My Title.md", similar: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  let ingested: { filePath?: string } | undefined;
  try {
    await ingestSummary({
      knowledgeApiUrl: "http://kb.test",
      ingestPath: "/api/youtube/ingest",
      body: {},
      onSimilar: () => {},
      onIngested: (info) => {
        ingested = info;
      },
    });
  } finally {
    restore();
  }
  expect(ingested).toEqual({ filePath: "ai/general/My Title.md" });
});

test("ingestSummary calls onIngested with undefined filePath when the response omits it", async () => {
  const restore = stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));
  let called = false;
  let ingested: { filePath?: string } | undefined;
  try {
    await ingestSummary({
      knowledgeApiUrl: "http://kb.test",
      ingestPath: "/api/youtube/ingest",
      body: {},
      onSimilar: () => {},
      onIngested: (info) => {
        called = true;
        ingested = info;
      },
    });
  } finally {
    restore();
  }
  expect(called).toBe(true);
  expect(ingested).toEqual({ filePath: undefined });
});

test("ingestSummary does not call onIngested on a non-ok response", async () => {
  const restore = stubFetch(() => new Response("nope", { status: 500 }));
  let called = false;
  try {
    await ingestSummary({
      knowledgeApiUrl: "http://kb.test",
      ingestPath: "/api/youtube/ingest",
      body: {},
      onSimilar: () => {},
      onIngested: () => {
        called = true;
      },
    });
  } finally {
    restore();
  }
  expect(called).toBe(false);
});

test("ingestSummary does not call onSimilar when there are no similar articles", async () => {
  const restore = stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));
  let called = false;
  try {
    await ingestSummary({
      knowledgeApiUrl: "http://kb.test",
      ingestPath: "/api/youtube/ingest",
      body: {},
      onSimilar: () => {
        called = true;
      },
    });
  } finally {
    restore();
  }
  expect(called).toBe(false);
});

test("ingestSummary is best-effort: a non-ok response neither throws nor enriches", async () => {
  const restore = stubFetch(() => new Response("nope", { status: 500 }));
  let called = false;
  try {
    await expect(
      ingestSummary({
        knowledgeApiUrl: "http://kb.test",
        ingestPath: "/api/youtube/ingest",
        body: {},
        onSimilar: () => {
          called = true;
        },
      }),
    ).resolves.toBeUndefined();
  } finally {
    restore();
  }
  expect(called).toBe(false);
});

test("ingestSummary is best-effort: a fetch rejection is swallowed", async () => {
  const restore = stubFetch(() => {
    throw new Error("network down");
  });
  try {
    await expect(
      ingestSummary({
        knowledgeApiUrl: "http://kb.test",
        ingestPath: "/api/youtube/ingest",
        body: {},
        onSimilar: () => {},
      }),
    ).resolves.toBeUndefined();
  } finally {
    restore();
  }
});

// --- runCaptureOneShot: the capture verticals' observability seam -------------
//
// Before this seam the four summarizers called `executeOneShot` bare: a user-run
// summarize left nothing on /traces, and its /agents row had no bot, model,
// tokens or trace link. These tests pin the three things that fixes:
//   1. a `capture:<source>` trace whose id reaches the /agents run,
//   2. the model call's real usage mirrored onto the run,
//   3. the thinking cap that buys back the first-token dead-air.

describe("runCaptureOneShot", () => {
  const config = { tracingCaptureToolOutputs: false, tracingEnabled: true } as unknown as Config;
  const botConfig = {
    name: "jarvis",
    connector: "claude-sdk",
    model: "claude-sonnet-5",
    thinkingMaxTokens: 40_000, // the bot's CHAT budget — must not leak into a capture
  } as unknown as BotConfig;

  /** Records the span calls runCaptureOneShot makes, without touching the DB. */
  function recordingTracer() {
    const calls: Array<{ op: string; label?: string; attrs?: Record<string, unknown> }> = [];
    const tracer = {
      traceId: "trace-1",
      start(label: string, attrs?: Record<string, unknown>) {
        calls.push({ op: "start", label, attrs });
        return "span-1";
      },
      end(label: string, attrs?: Record<string, unknown>) {
        calls.push({ op: "end", label, attrs });
        return 1;
      },
      finish(status: "ok" | "error", attrs?: Record<string, unknown>) {
        calls.push({ op: `finish:${status}`, attrs });
      },
      addChildSpan() { return "child"; },
      addSubSpan() { return "sub"; },
    } as unknown as Tracer;
    return { tracer, calls };
  }

  function fakeResult(over: Partial<ClaudeExecResult> = {}): ClaudeExecResult {
    return {
      result: "CATEGORY: ai/general\n\nSUMMARY:\nok",
      model: "claude-sonnet-5-20260101",
      inputTokens: 9_000,
      outputTokens: 700,
      numTurns: 1,
      costUsd: 0.02,
      durationMs: 1_200,
      durationApiMs: 1_100,
      wallClockMs: 1_300,
      ...over,
    } as ClaudeExecResult;
  }

  function harness(over: Partial<Parameters<typeof runCaptureOneShot>[0]> = {}) {
    const attached: RunMeta[] = [];
    const seen: OneShotOptions[] = [];
    const { tracer, calls } = recordingTracer();
    const base = {
      source: "youtube",
      jobId: "job-1",
      title: "A video",
      url: "https://y/1",
      prompt: "transcript",
      systemPrompt: "summarize",
      config,
      botConfig,
      tracer,
      attachRun: (_id: string, meta: RunMeta) => { attached.push(meta); },
      oneShot: async (_p: string, _c: Config, _b: BotConfig, o: OneShotOptions = {}) => {
        seen.push(o);
        return fakeResult();
      },
      ...over,
    } as Parameters<typeof runCaptureOneShot>[0];
    return { opts: base, attached, seen, calls };
  }

  test("caps thinking at the capture budget instead of inheriting the bot's chat budget", async () => {
    const h = harness();
    await runCaptureOneShot(h.opts);
    expect(h.seen[0]!.thinkingMaxTokens).toBe(CAPTURE_THINKING_MAX_TOKENS);
    expect(CAPTURE_THINKING_MAX_TOKENS).toBeLessThan(botConfig.thinkingMaxTokens!);
  });

  test("never overrides thinking on openai-compat — there the field is max_tokens", async () => {
    // Overriding it on a local-model bot would clamp the SUMMARY's length to 8k,
    // not its thinking; and there is no thinking dead-air there to buy back.
    const local = { ...botConfig, connector: "openai-compat", baseUrl: "http://localhost:11434/v1" } as unknown as BotConfig;
    const h = harness({ botConfig: local });
    await runCaptureOneShot(h.opts);
    expect(h.seen[0]!.thinkingMaxTokens).toBeUndefined();
  });

  test("stamps no trace link when tracing is disabled (no dead /agents Trace link)", async () => {
    const h = harness({ config: { tracingCaptureToolOutputs: false, tracingEnabled: false } as unknown as Config });
    await runCaptureOneShot(h.opts);
    expect(h.attached[0]!.traceId).toBeUndefined();
    expect(h.attached[0]!.botName).toBe("jarvis"); // the rest of the card still binds
  });

  test("thinkingMaxTokens: null inherits the bot's budget (TikTok's frame reading)", async () => {
    const h = harness({ thinkingMaxTokens: null });
    await runCaptureOneShot(h.opts);
    expect(h.seen[0]!.thinkingMaxTokens).toBeUndefined();
  });

  test("an explicit thinking budget overrides the capture default", async () => {
    const h = harness({ thinkingMaxTokens: 0 });
    await runCaptureOneShot(h.opts);
    expect(h.seen[0]!.thinkingMaxTokens).toBe(0);
  });

  test("binds bot + connector + traceId onto the run BEFORE the model call", async () => {
    const h = harness();
    await runCaptureOneShot(h.opts);
    expect(h.attached[0]).toMatchObject({
      botName: "jarvis",
      connectorLabel: "Claude SDK",
      traceId: "trace-1",
    });
  });

  test("mirrors the model call's real usage onto the run after it settles", async () => {
    const h = harness();
    await runCaptureOneShot(h.opts);
    const usage = h.attached.at(-1)!;
    expect(usage).toMatchObject({
      model: "claude-sonnet-5-20260101", // what the connector REPORTED, not the config
      inputTokens: 9_000,
      outputTokens: 700,
      toolCount: 0,
    });
  });

  test("traces the model call as a `claude` span carrying model + tokens + cost", async () => {
    const h = harness();
    await runCaptureOneShot(h.opts);
    const end = h.calls.find((c) => c.op === "end" && c.label === "claude")!;
    expect(end.attrs).toMatchObject({
      model: "claude-sonnet-5-20260101",
      inputTokens: 9_000,
      outputTokens: 700,
      costUsd: 0.02,
    });
    expect(h.calls.some((c) => c.op === "finish:ok")).toBe(true);
  });

  test("passes extraDirs and a timeout through to the connector (TikTok frames)", async () => {
    const h = harness({ extraDirs: ["/tmp/frames"], timeoutMs: 600_000 });
    await runCaptureOneShot(h.opts);
    expect(h.seen[0]!.extraDirs).toEqual(["/tmp/frames"]);
    expect(h.seen[0]!.timeoutMs).toBe(600_000);
  });

  test("a failing model call stamps the trace `error` and rethrows for the caller's failJob", async () => {
    const h = harness({
      oneShot: async () => { throw new Error("connector exploded"); },
    });

    await expect(runCaptureOneShot(h.opts)).rejects.toThrow("connector exploded");

    const finish = h.calls.find((c) => c.op === "finish:error")!;
    expect(finish.attrs).toMatchObject({ source: "youtube", error: "connector exploded" });
    // The run keeps the trace link even on the error path, so a failed capture is
    // still clickable from /agents into /traces.
    expect(h.attached[0]!.traceId).toBe("trace-1");
  });
});
