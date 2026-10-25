import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";

// --- Module mocks (registered before the dynamic import below) ---
// The Claude call is mocked so the pipeline runs without a real spawn, and the
// source-draft trigger is spied. Ingest behaviour is driven by the fetch mock.

const ARTICLE_ID = "1789456123";
const ARTICLE_URL = "https://x.com/karpathy/status/1789456123";

let claudeResult = "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n- point";
let ingestOk = true;
let ingestFilePath: string | undefined;
let ingestPayload: Record<string, unknown> | undefined;
/** What the run actually sent — the builder pin at the bottom compares against these. */
let lastPrompt = "";
let lastSystemPrompt = "";
let lastToolSurface: unknown;

mock.module("../ai/one-shot.ts", () => ({
  executeOneShot: async (
    prompt: string,
    _c: unknown,
    _b: unknown,
    opts?: { systemPrompt?: string; toolSurface?: unknown; onProgress?: (e: { type: string; text: string }) => void },
  ) => {
    lastPrompt = prompt;
    lastSystemPrompt = opts?.systemPrompt ?? "";
    lastToolSurface = opts?.toolSurface;
    opts?.onProgress?.({ type: "text_delta", text: claudeResult });
    return { result: claudeResult, outputTokens: 42, inputTokens: 10, wallClockMs: 5 };
  },
  connectorCapabilities: (b: { connector?: string }) => {
    const isClaude = (b.connector ?? "claude-cli") === "claude-cli" || b.connector === "claude-sdk";
    return { supportsExtraDirs: isClaude, supportsThinkingBudget: isClaude };
  },
}));

// Source-page drafter trigger — spied, never run.
let sourceDraftCalls: Array<{ input: Record<string, unknown> }> = [];
mock.module("../gardener/source-drafter-run.ts", () => ({
  triggerSourceDraftFromCapture: (_bot: unknown, input: Record<string, unknown>) => {
    sourceDraftCalls.push({ input });
  },
}));

const originalFetch = globalThis.fetch;
function installFetchMock() {
  // @ts-expect-error — minimal Response stand-in is enough for the summarizer.
  globalThis.fetch = async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/x-articles/ingest")) {
      ingestPayload = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: ingestOk,
        status: ingestOk ? 200 : 500,
        json: async () => ({ similar: [], ...(ingestFilePath ? { file_path: ingestFilePath } : {}) }),
        text: async () => "{}",
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
}

const { summarizeArticle } = await import("./summarizer.ts");
const { buildXArticleSystemPrompt } = await import("./prompt.ts");
const { buildArticleSystemPrompt } = await import("../article/prompt.ts");
const { buildAnthropicSystemPrompt } = await import("../anthropic/prompt.ts");
const { createJob, getJob } = await import("./state.ts");

/**
 * The attributes the `claude` span was STARTED with — where `extraTraceAttrs`
 * (`linkTraceAttrs`) lands. The real prototype is patched rather than a module
 * mocked, so the chain `runCaptureOneShot` → `tracedOneShot` → `tracer.start`
 * stays under test; this file runs in a process of its own (its `mock.module`
 * calls), so the patch reaches no other suite.
 */
let lastClaudeSpanAttrs: Record<string, unknown> | undefined;
const { Tracer } = await import("../tracing/tracer.ts");
const realTracerStart = Tracer.prototype.start;
Tracer.prototype.start = function patchedStart(
  this: InstanceType<typeof Tracer>,
  label: string,
  attributes?: Record<string, unknown>,
) {
  if (label === "claude") lastClaudeSpanAttrs = attributes;
  return realTracerStart.call(this, label, attributes);
};

const config = { knowledgeApiUrl: "http://kb.test", claudeTimeoutMs: 120_000 } as unknown as Config;
const bot = { name: "jarvis", dir: "/tmp/bot", model: "sonnet" } as unknown as BotConfig;

beforeEach(() => {
  claudeResult = "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n- point";
  ingestOk = true;
  ingestFilePath = undefined;
  ingestPayload = undefined;
  lastPrompt = "";
  lastSystemPrompt = "";
  lastToolSurface = undefined;
  lastClaudeSpanAttrs = undefined;
  sourceDraftCalls = [];
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("happy path completes the job and ingests the parsed summary", async () => {
  const jobId = createJob(ARTICLE_ID, "A Thread on RAG", ARTICLE_URL, "karpathy");
  await summarizeArticle(jobId, ARTICLE_ID, "A Thread on RAG", ARTICLE_URL, "karpathy", "long article body", config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(job.category).toBe("ai/rag");
  expect(ingestPayload!.url).toBe(ARTICLE_URL);
});

test("the summary call declares no tools: a pasted thread is untrusted input", async () => {
  const jobId = createJob(ARTICLE_ID, "A Thread on RAG", ARTICLE_URL, "karpathy");
  await summarizeArticle(jobId, ARTICLE_ID, "A Thread on RAG", ARTICLE_URL, "karpathy", "long article body", config, bot);
  expect(lastToolSurface).toBe("none");
});

test("fires the source-draft trigger with the huginn file_path docId, category, and url", async () => {
  ingestFilePath = "ai/rag/A Thread on RAG.md";
  const jobId = createJob(ARTICLE_ID, "A Thread on RAG", ARTICLE_URL, "karpathy");
  await summarizeArticle(jobId, ARTICLE_ID, "A Thread on RAG", ARTICLE_URL, "karpathy", "long article body", config, bot);

  expect(sourceDraftCalls).toHaveLength(1);
  expect(sourceDraftCalls[0]!.input).toMatchObject({
    collection: "x-articles",
    docId: "ai/rag/A Thread on RAG.md",
    url: ARTICLE_URL,
    category: "ai/rag",
    sourceTitle: "A Thread on RAG",
  });
});

test("source-draft trigger falls back to the articleId when ingest returns no file_path", async () => {
  const jobId = createJob(ARTICLE_ID, "A Thread on RAG", ARTICLE_URL, "karpathy");
  await summarizeArticle(jobId, ARTICLE_ID, "A Thread on RAG", ARTICLE_URL, "karpathy", "long article body", config, bot);

  expect(sourceDraftCalls).toHaveLength(1);
  expect(sourceDraftCalls[0]!.input.docId).toBe(ARTICLE_ID);
});

/**
 * The run uses ITS OWN builder, over the right arguments.
 *
 * Three text verticals compose their system prompt out of the same shared
 * scaffold, so a call site pointed at the neighbour's builder — or handed
 * `author` and `url` the wrong way round — still produces a plausible prompt and
 * still parses. Equality against the builder catches the first; DISTINCT values
 * for title, author and url catch the second.
 */
const PIN_TITLE = "A Thread on RAG";
const PIN_AUTHOR = "karpathy";
const PIN_BODY = "long article body";

test("the run sends x-article's OWN system prompt, with author and url the right way round", async () => {
  const jobId = createJob(ARTICLE_ID, PIN_TITLE, ARTICLE_URL, PIN_AUTHOR);
  await summarizeArticle(jobId, ARTICLE_ID, PIN_TITLE, ARTICLE_URL, PIN_AUTHOR, PIN_BODY, config, bot);

  expect(lastSystemPrompt).toBe(
    buildXArticleSystemPrompt({ title: PIN_TITLE, author: PIN_AUTHOR, url: ARTICLE_URL }),
  );
  // Swapped arguments compose a different string, so the equality above is a
  // pin on the ORDER and not only on the builder.
  expect(lastSystemPrompt).not.toBe(
    buildXArticleSystemPrompt({ title: PIN_TITLE, author: ARTICLE_URL, url: PIN_AUTHOR }),
  );
  // Neither neighbour's builder, over the same inputs.
  expect(lastSystemPrompt).not.toBe(
    buildArticleSystemPrompt({ title: PIN_TITLE, author: PIN_AUTHOR, url: ARTICLE_URL }),
  );
  expect(lastSystemPrompt).not.toBe(
    buildAnthropicSystemPrompt({ framing: "anthropic", title: PIN_TITLE, url: ARTICLE_URL }),
  );
  // The three context lines really are in there — a builder that dropped one
  // would move both sides of the equality and nothing else here would notice.
  expect(lastSystemPrompt).toContain(`Article title: ${PIN_TITLE}`);
  expect(lastSystemPrompt).toContain(`Article author: @${PIN_AUTHOR}`);
  expect(lastSystemPrompt).toContain(`Article URL: ${ARTICLE_URL}`);
  // The pasted body IS the user prompt — this vertical has no user-prompt builder.
  expect(lastPrompt).toBe(PIN_BODY);
});

// --- The text's links (plan muninn-summary-links, PR 2) ---------------------
// Invented markup and URLs; the `t.co` lookup and the repo line are seams, so
// nothing here reaches the network.

const LINKED_BODY = [
  "An invented article body that names its sources.",
  "",
  "The harness lives at [the repo](https://t.co/InventedA1) and the write-up at https://example.org/write-up.",
  "Also see https://t.co/InventedB2 and the author's profile https://x.com/someone_invented.",
].join("\n");

test("t.co targets replace the hrefs, the model picks from the list, the section lands before the ingest", async () => {
  claudeResult = "CATEGORY: ai/rag\nLINKS: 1\n\nSUMMARY:\n### Heading\n- point";
  const resolved: string[] = [];
  const jobId = createJob(ARTICLE_ID, PIN_TITLE, ARTICLE_URL, PIN_AUTHOR);
  await summarizeArticle(jobId, ARTICLE_ID, PIN_TITLE, ARTICLE_URL, PIN_AUTHOR, LINKED_BODY, config, bot, {
    resolveRedirect: async (url) => {
      resolved.push(url);
      return url === "https://t.co/InventedA1" ? "https://github.com/example/harness" : null;
    },
    repoLine: async () => "An invented harness, TypeScript, MIT, ★ 12 on 2026-10-25",
  });

  expect(resolved.sort()).toEqual(["https://t.co/InventedA1", "https://t.co/InventedB2"]);
  // The model reads the target, not the t.co href; the unresolved one stays as it was.
  expect(lastPrompt).toContain("[the repo](https://github.com/example/harness)");
  expect(lastPrompt).toContain("https://t.co/InventedB2");
  expect(lastPrompt).toContain(
    "## Links in the text\n\n1. the repo — https://github.com/example/harness [code or paper]\n2. example.org/write-up — https://example.org/write-up",
  );
  expect(lastPrompt).not.toMatch(/\d+\. .*x\.com/);
  expect(lastPrompt).not.toMatch(/\d+\. .*t\.co/);
  expect(lastSystemPrompt).toBe(
    buildXArticleSystemPrompt({ title: PIN_TITLE, author: PIN_AUTHOR, url: ARTICLE_URL, linksStep: true }),
  );
  expect(lastSystemPrompt).toContain('2. Then add one line "LINKS: <ids>"');
  // The owner check reads these off the `claude` span on /traces.
  expect(lastClaudeSpanAttrs).toMatchObject({
    source: "x-article",
    linkCandidates: "2",
    linkCandidatesTruncated: "0",
    tcoFound: "2",
    tcoResolved: "1",
  });

  const section =
    "## Links\n\n- 📦 [the repo](https://github.com/example/harness) — An invented harness, TypeScript, MIT, ★ 12 on 2026-10-25 · from text";
  expect(getJob(jobId)!.summary).toBe(`### Heading\n- point\n\n${section}`);
  expect(ingestPayload!.summary).toBe(`### Heading\n- point\n\n${section}`);
  expect(String(ingestPayload!.summary)).not.toContain("LINKS:");
});

test("LINKS: none writes no section, and the line never reaches the body", async () => {
  claudeResult = "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n- point\n\nLINKS: none";
  const jobId = createJob(ARTICLE_ID, PIN_TITLE, ARTICLE_URL, PIN_AUTHOR);
  await summarizeArticle(jobId, ARTICLE_ID, PIN_TITLE, ARTICLE_URL, PIN_AUTHOR, LINKED_BODY, config, bot, {
    resolveRedirect: async () => null,
    repoLine: async () => null,
  });
  expect(getJob(jobId)!.summary).toBe("### Heading\n- point");
});
