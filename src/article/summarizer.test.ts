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

mock.module("../ai/one-shot.ts", () => ({
  executeOneShot: async (
    _prompt: string,
    _c: unknown,
    _b: unknown,
    opts?: { onProgress?: (e: { type: string; text: string }) => void },
  ) => {
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
const { createJob, getJob } = await import("./state.ts");

const config = { knowledgeApiUrl: "http://kb.test", claudeTimeoutMs: 120_000 } as unknown as Config;
const bot = { name: "jarvis", dir: "/tmp/bot", model: "sonnet" } as unknown as BotConfig;

const ART_URL = "https://linkedin.com/posts/someone-123";

beforeEach(() => {
  claudeResult = "CATEGORY: ai/general\n\nSUMMARY:\n### Heading\n- point";
  ingestOk = true;
  ingestFilePath = undefined;
  ingestPayload = undefined;
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
