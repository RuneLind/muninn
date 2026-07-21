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
const { createJob, getJob } = await import("./state.ts");

const config = { knowledgeApiUrl: "http://kb.test", claudeTimeoutMs: 120_000 } as unknown as Config;
const bot = { name: "jarvis", dir: "/tmp/bot", model: "sonnet" } as unknown as BotConfig;

beforeEach(() => {
  claudeResult = "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n- point";
  ingestOk = true;
  ingestFilePath = undefined;
  ingestPayload = undefined;
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
