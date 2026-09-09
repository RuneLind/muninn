import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";

// --- Module mocks (registered before the dynamic import below) ---
// The Claude call is mocked so the pipeline runs without a real spawn; the
// source-draft trigger is spied. Ingest behaviour is driven by the fetch mock.

let claudeResult = "CATEGORY: ai/general\n\nSUMMARY:\n### Heading\n- point";
let ingestOk = true;
let ingestFilePath: string | undefined;
let ingestPayload: Record<string, unknown> | undefined;
/** What the run actually sent — the builder pin at the bottom compares against these. */
let lastPrompt = "";
let lastSystemPrompt = "";

mock.module("../ai/one-shot.ts", () => ({
  executeOneShot: async (
    prompt: string,
    _c: unknown,
    _b: unknown,
    opts?: { systemPrompt?: string; onProgress?: (e: { type: string; text: string }) => void },
  ) => {
    lastPrompt = prompt;
    lastSystemPrompt = opts?.systemPrompt ?? "";
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
    if (url.includes("/api/articles/ingest")) {
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
const { buildArticleSystemPrompt } = await import("./prompt.ts");
const { buildXArticleSystemPrompt } = await import("../x-article/prompt.ts");
const { buildAnthropicSystemPrompt } = await import("../anthropic/prompt.ts");
const { createJob, getJob } = await import("./state.ts");

const config = { knowledgeApiUrl: "http://kb.test", claudeTimeoutMs: 120_000 } as unknown as Config;
const bot = { name: "jarvis", dir: "/tmp/bot", model: "sonnet" } as unknown as BotConfig;

const ART_URL = "https://linkedin.com/posts/someone-123";

beforeEach(() => {
  claudeResult = "CATEGORY: ai/general\n\nSUMMARY:\n### Heading\n- point";
  ingestOk = true;
  ingestFilePath = undefined;
  ingestPayload = undefined;
  lastPrompt = "";
  lastSystemPrompt = "";
  sourceDraftCalls = [];
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("fires the source-draft trigger with the huginn file_path docId, category, and url", async () => {
  ingestFilePath = "ai/general/Pasted Article.md";
  const jobId = createJob("Pasted Article", ART_URL, "Someone");
  await summarizeArticle(jobId, "Pasted Article", ART_URL, "Someone", "a long pasted article body", config, bot);

  expect(sourceDraftCalls).toHaveLength(1);
  expect(sourceDraftCalls[0]!.input).toMatchObject({
    collection: "article-summaries",
    docId: "ai/general/Pasted Article.md",
    url: ART_URL,
    category: "ai/general",
    sourceTitle: "Pasted Article",
  });
});

test("skips the source-draft trigger entirely when ingest returns no file_path (no fallback id)", async () => {
  // A pasted article often has no url, so without huginn's stored file_path there's
  // no keyable id — skip rather than coerce.
  const jobId = createJob("Pasted Article", ART_URL, "Someone");
  await summarizeArticle(jobId, "Pasted Article", ART_URL, "Someone", "a long pasted article body", config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete"); // job still completes
  expect(sourceDraftCalls).toHaveLength(0);
});

test("URL-less pasted article still triggers when a file_path exists — url is '' (pending-ingestion path)", async () => {
  ingestFilePath = "ai/general/No URL Article.md";
  const jobId = createJob("No URL Article"); // no url, no author
  await summarizeArticle(jobId, "No URL Article", "", "", "a long pasted article body with no source url", config, bot);

  expect(sourceDraftCalls).toHaveLength(1);
  expect(sourceDraftCalls[0]!.input).toMatchObject({
    collection: "article-summaries",
    docId: "ai/general/No URL Article.md",
    url: "",
  });
});

/**
 * The run uses ITS OWN builder, over the right arguments.
 *
 * Three text verticals compose their system prompt out of the same shared
 * scaffold, so a call site pointed at the neighbour's builder — or one that
 * stopped passing `author` — still produces a plausible prompt and still parses.
 * Equality against the builder catches the first; DISTINCT values plus the
 * explicit context lines catch the second.
 */
const PIN_TITLE = "Pasted Article";
const PIN_AUTHOR = "Someone";
const PIN_BODY = "a long pasted article body";

test("the run sends article's OWN system prompt, carrying both optional context lines", async () => {
  const jobId = createJob(PIN_TITLE, ART_URL, PIN_AUTHOR);
  await summarizeArticle(jobId, PIN_TITLE, ART_URL, PIN_AUTHOR, PIN_BODY, config, bot);

  expect(lastSystemPrompt).toBe(
    buildArticleSystemPrompt({ title: PIN_TITLE, author: PIN_AUTHOR, url: ART_URL }),
  );
  // A run that stopped passing the author is a DIFFERENT prompt, so the
  // equality above pins the argument and not only the builder.
  expect(lastSystemPrompt).not.toBe(buildArticleSystemPrompt({ title: PIN_TITLE, url: ART_URL }));
  expect(lastSystemPrompt).not.toBe(
    buildArticleSystemPrompt({ title: PIN_TITLE, author: ART_URL, url: PIN_AUTHOR }),
  );
  // Neither neighbour's builder, over the same inputs.
  expect(lastSystemPrompt).not.toBe(
    buildXArticleSystemPrompt({ title: PIN_TITLE, author: PIN_AUTHOR, url: ART_URL }),
  );
  expect(lastSystemPrompt).not.toBe(
    buildAnthropicSystemPrompt({ framing: "anthropic", title: PIN_TITLE, url: ART_URL }),
  );
  // The lines themselves — a builder that dropped one would move both sides of
  // the equality and nothing else here would notice.
  expect(lastSystemPrompt).toContain(`Article title: ${PIN_TITLE}`);
  expect(lastSystemPrompt).toContain(`Article author: ${PIN_AUTHOR}`);
  expect(lastSystemPrompt).toContain(`Article URL: ${ART_URL}`);
  // The pasted body IS the user prompt — this vertical has no user-prompt builder.
  expect(lastPrompt).toBe(PIN_BODY);
});

test("a paste with no url and no author omits those lines rather than sending blank ones", async () => {
  const jobId = createJob("No URL Article");
  await summarizeArticle(jobId, "No URL Article", "", "", PIN_BODY, config, bot);

  expect(lastSystemPrompt).toBe(buildArticleSystemPrompt({ title: "No URL Article" }));
  expect(lastSystemPrompt).not.toContain("Article author:");
  expect(lastSystemPrompt).not.toContain("Article URL:");
});
