import { test, expect, describe } from "bun:test";
import { configure, type LogRecord } from "@logtape/logtape";
import {
  buildSummarySystemPrompt,
  captureTraceName,
  createCaptureTracer,
  ingestSummary,
  ingestTimeoutFor,
  runCaptureOneShot,
  windowedTranscriptRider,
  CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS,
  CAPTURE_THINKING_MAX_TOKENS,
  SUMMARY_STRUCTURE_BULLETS,
} from "./summarizer-shared.ts";
import { summarizeTimeoutFor } from "../video/media.ts";
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
   - Open the summary with ONE *italic* ingress line (max ~30 words): what/who this is and why it matters — e.g. *Interview with Tom Griffiths, Princeton professor of psychology & CS, about his book tracing the mathematical history of cognition.*
   - Then a \`## Key takeaways\` section FIRST (before any other section) — 3–6 tight bullet points, one line each, capturing the most important points.
   - Then \`##\`-level section headers for each major topic; use \`###\` only for sub-sections. Keep the heading hierarchy consistent.
   - When the source DICTATES something meant to be reused — a prompt, a command, a config, a query, a formula, a code snippet ("the prompt I use is…", "run this…", text shown on screen) — reproduce it VERBATIM inside a fenced code block, under a short line saying what it is. Never paraphrase or shorten it: for these, fidelity beats brevity and the "keep it concise" rule below does not apply. ALWAYS close the fence, and never label one \`mermaid\` — that is drawn, not shown. Quote it whole; only when it will not fit, quote the essential part, mark it \`(excerpted)\`, and still close the fence — never truncate silently. When what is dictated is itself markup the "plain markdown only" rule below forbids, describe it in prose rather than quoting it. If the source names such an artifact without ever giving its text, say so — never invent one.
   - Use a markdown table when the content is genuinely comparative (options side by side, before/after, feature or tradeoff matrices) — don't force a table onto non-comparative content.
   - **Bold** for key terms; bullet lists for enumerations, prefixed with a fitting emoji (as in \`- 🧪 Evals catch…\`).
   - Plain markdown only — no HTML and no custom block components (no callouts, cards, verdicts, or pills).
   - Keep it concise but comprehensive.
   - End with a closing blockquote takeaway: \`> 💬 **Takeaway:** …\` — the 1–3 most surprising or headline revelations, distilled into one or two punchy sentences.`;
  // Hardcoded literals on purpose: this test is the change-detector that forces
  // any edit to SUMMARY_STRUCTURE_BULLETS through an intentional review.
  expect(built).toBe(expected);
});

test("the default structure leads with a `## Key takeaways` section and forbids components", () => {
  const built = buildSummarySystemPrompt("intro", ["ai/general"]);
  // Key-takeaways-first is the campaign's headline structural guarantee.
  expect(built).toContain("## Key takeaways` section FIRST");
  // The ingress + closer framing devices (restored from the pre-#309 style).
  expect(built).toContain("*italic* ingress line");
  expect(built).toContain("> 💬 **Takeaway:**");
  // Plain-markdown-only: stored summaries must never carry block components.
  expect(built).toContain("no custom block components");
  // Tables only where content is genuinely comparative.
  expect(built).toContain("markdown table when the content is genuinely comparative");
});

// The byte-for-byte snapshot above already detects any wording change to the
// array, so a second `toContain` on the same string would add no detection.
// What it CANNOT see is ORDER coupling: the verbatim bullet disapplies two
// later rules by referring to them as "below", and a reorder that keeps every
// string intact leaves a dangling reference the snapshot happily accepts.
//
// The other blind spot — the two video verticals, which interpolate the array
// instead of calling buildSummarySystemPrompt — is NOT pinnable from here at
// all. It is pinned end-to-end in src/tiktok/summarizer.test.ts and
// src/x-article/video.test.ts, against the system prompt those modules
// actually hand to the executor.
describe("the verbatim-artifact rule", () => {
  const idxOf = (needle: string) => SUMMARY_STRUCTURE_BULLETS.findIndex((b) => b.includes(needle));

  test("is stated BEFORE both rules it exempts itself from", () => {
    const verbatim = idxOf("VERBATIM");
    // Case-sensitive on purpose: the verbatim bullet quotes both rule names in
    // lowercase, so an uppercase needle cannot match the bullet itself.
    const concise = idxOf("Keep it concise");
    const plainMarkdown = idxOf("Plain markdown only");
    expect(verbatim).toBeGreaterThanOrEqual(0);
    expect(concise).toBeGreaterThanOrEqual(0);
    expect(plainMarkdown).toBeGreaterThanOrEqual(0);
    expect(verbatim).toBeLessThan(concise);
    expect(verbatim).toBeLessThan(plainMarkdown);
  });
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

  // ── a caller-owned root: `parentTracer` ────────────────────────────────────
  //
  // `Tracer.finish` has no idempotence guard, so a root finished by both the
  // seam and its caller is written twice and the second write wins whether or
  // not it is true. With `parentTracer` the seam does everything else and
  // touches the root not at all.

  test("`parentTracer` suppresses the seam's own finish on the SUCCESS path", async () => {
    const { tracer, calls } = recordingTracer();
    const h = harness({ parentTracer: tracer, tracer: undefined });
    await runCaptureOneShot(h.opts);

    expect(calls.some((c) => c.op === "start" && c.label === "claude")).toBe(true);
    expect(calls.some((c) => c.op === "end" && c.label === "claude")).toBe(true);
    expect(calls.filter((c) => c.op.startsWith("finish"))).toEqual([]);
    // Its own `tracer` seam is untouched, i.e. `parentTracer` really is the root.
    expect(h.calls).toEqual([]);
  });

  test("`parentTracer` suppresses it on the FAILURE path too, and still rethrows", async () => {
    const { tracer, calls } = recordingTracer();
    const h = harness({
      parentTracer: tracer,
      tracer: undefined,
      oneShot: async () => { throw new Error("connector exploded"); },
    });

    await expect(runCaptureOneShot(h.opts)).rejects.toThrow("connector exploded");
    expect(calls.some((c) => c.op === "end" && c.label === "claude")).toBe(true);
    expect(calls.filter((c) => c.op.startsWith("finish"))).toEqual([]);
  });

  test("`pass` names the model span, so two calls under one root do not clobber", async () => {
    const { tracer, calls } = recordingTracer();
    const h = harness({ parentTracer: tracer, tracer: undefined, pass: "claude:select" });
    await runCaptureOneShot(h.opts);

    expect(calls.filter((c) => c.op === "start").map((c) => c.label)).toEqual(["claude:select"]);
    expect(calls.filter((c) => c.op === "end").map((c) => c.label)).toEqual(["claude:select"]);
  });

  test("without `pass` the span is still `claude` — what the read-side fast paths join on", async () => {
    const h = harness();
    await runCaptureOneShot(h.opts);
    expect(h.calls.filter((c) => c.op === "start").map((c) => c.label)).toEqual(["claude"]);
  });

  test("the capture trace root has ONE name, and the two-pass caller builds it with the same one", () => {
    expect(captureTraceName("youtube")).toBe("capture:youtube");
    // The NAME the tracer was constructed with, not merely that one was built.
    // `createCaptureTracer` is the only other caller of the helper, so this is
    // what stops a two-pass vertical opening a root under a name `/traces` does
    // not group by — and asserting the traceId instead asserted `crypto`.
    const tracer = createCaptureTracer("youtube", botConfig);
    expect(tracer.name).toBe("capture:youtube");
    expect(tracer.name).toBe(captureTraceName("youtube"));
    expect(tracer.traceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// --- the constants and riders the capture verticals share ---

describe("the shared capture summarize floor", () => {
  test("is 600 s, and a frame-less capture gets exactly it", () => {
    // One constant for every vertical: Vimeo and YouTube both declared their
    // own 600_000 with the same paragraph of rationale over it, which is the
    // two-literals shape `src/video/media.ts` documents for the frame budget —
    // where a raised ceiling stayed inert behind the second copy.
    expect(CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS).toBe(600_000);
    expect(summarizeTimeoutFor(0, CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS)).toBe(600_000);
    expect(summarizeTimeoutFor(40, CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS)).toBe(600_000 + 10 * 24_000);
  });
});

describe("windowedTranscriptRider", () => {
  test("the sentence, once, with the vertical's own noun", () => {
    expect(windowedTranscriptRider("talk")).toBe(
      "The transcript is grouped into windows, each opened by a `### [HH:MM:SS]` heading " +
        "carrying its absolute position in the talk; those headings are positions, not content — " +
        "never quote one as if it were speech.",
    );
    // The only difference between the two verticals' copies was this word.
    expect(windowedTranscriptRider("video")).toBe(
      windowedTranscriptRider("talk").replace("in the talk;", "in the video;"),
    );
  });
});

describe("ingestTimeoutFor", () => {
  test("15 s for an ordinary summary, +1 s per 64 KiB, capped at 120 s", () => {
    expect(ingestTimeoutFor(0)).toBe(15_000);
    expect(ingestTimeoutFor(6_000)).toBe(15_000);
    expect(ingestTimeoutFor(64 * 1024)).toBe(16_000);
    expect(ingestTimeoutFor(2 * 1024 * 1024)).toBe(15_000 + 32_000);
    expect(ingestTimeoutFor(64 * 1024 * 1024)).toBe(120_000);
  });

  test("a nonsense size still yields the floor, never 0 or NaN", () => {
    // It bounds an abort; a 0 here would be "abort immediately".
    expect(ingestTimeoutFor(-1)).toBe(15_000);
    expect(ingestTimeoutFor(Number.NaN)).toBe(15_000);
  });
});

test("ingestSummary sizes its own timeout from the body it is posting", async () => {
  // A 2 MiB `## Transcript` body posted under the 15 s default can have its
  // RESPONSE dropped after huginn already wrote the document — and that
  // response is the only place the stored doc id ever appears, which is what
  // the verticals' reindex-window dedup maps are keyed on.
  //
  // The resolved budget is read off the log line, because an AbortSignal does
  // not report the deadline it was built with — and that line is the only
  // place an operator can see it either.
  const big = "x".repeat(3 * 1024 * 1024);
  const body = { title: "T", url: "u", summary: big, category: "ai/general" };
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (r: LogRecord) => records.push(r) },
    loggers: [
      { category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "error" },
    ],
    reset: true,
  });
  let sawSignal: AbortSignal | undefined;
  const restore = stubFetch((_input, init) => {
    sawSignal = init?.signal ?? undefined;
    return new Response(JSON.stringify({ file_path: "ai/general/T.md" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    await ingestSummary({
      knowledgeApiUrl: "http://kb.test",
      ingestPath: "/api/youtube/ingest",
      body,
      onSimilar: () => {},
    });
  } finally {
    restore();
    await configure({ sinks: {}, loggers: [{ category: ["logtape", "meta"], sinks: [], lowestLevel: "error" }], reset: true });
  }

  const line = records.find((r) => String(r.message.join("")).includes("Ingesting"));
  expect(line).toBeDefined();
  expect(line!.properties.bytes).toBe(JSON.stringify(body).length);
  expect(line!.properties.timeoutMs).toBe(ingestTimeoutFor(JSON.stringify(body).length));
  // Which for this body is 63 s — not the 15 s a caller-less default would give.
  expect(line!.properties.timeoutMs).toBe(15_000 + 48_000);
  // The abort is still wired, and nothing aborted it.
  expect(sawSignal).toBeInstanceOf(AbortSignal);
  expect(sawSignal!.aborted).toBe(false);
});

test("ingestSummary sizes and logs a multi-byte body in BYTES, not in code units", async () => {
  // `JSON.stringify(body).length` counts UTF-16 code units; the budget bounds
  // what goes on the WIRE, and a windowed `## Transcript` of a Japanese or
  // Norwegian talk is mostly multi-byte. Sized in characters, a 3 MB POST is
  // given the budget of a 1 MB one — and the `bytes` an operator reads off the
  // log line is not a count of bytes at all.
  const body = { title: "T", url: "u", summary: "あ".repeat(1_000_000), category: "ai/general" };
  const payload = JSON.stringify(body);
  const wireBytes = Buffer.byteLength(payload);
  expect(wireBytes).toBeGreaterThan(payload.length * 2);

  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (r: LogRecord) => records.push(r) },
    loggers: [
      { category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "error" },
    ],
    reset: true,
  });
  const restore = stubFetch(
    () =>
      new Response(JSON.stringify({ file_path: "ai/general/T.md" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    await ingestSummary({
      knowledgeApiUrl: "http://kb.test",
      ingestPath: "/api/youtube/ingest",
      body,
      onSimilar: () => {},
    });
  } finally {
    restore();
    await configure({ sinks: {}, loggers: [{ category: ["logtape", "meta"], sinks: [], lowestLevel: "error" }], reset: true });
  }

  const line = records.find((r) => String(r.message.join("")).includes("Ingesting"));
  expect(line).toBeDefined();
  expect(line!.properties.bytes).toBe(wireBytes);
  expect(line!.properties.timeoutMs).toBe(ingestTimeoutFor(wireBytes));
  // 60 s for these 3 000 060 bytes. The code-unit count would have bought 30 s
  // — half the budget for the same POST.
  expect(line!.properties.timeoutMs).toBe(60_000);
  expect(ingestTimeoutFor(payload.length)).toBe(30_000);
});
