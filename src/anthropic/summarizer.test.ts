import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";

// --- Module mocks (registered before the dynamic import below) ---
// The Claude call, the knowledge-API client, and the candidate DB writer are
// mocked so the pipeline runs without a real `claude` spawn, a live Huginn, or
// a Postgres connection. Behaviour is driven by the mutable vars below, reset
// to a happy-path default in beforeEach.

const CAND_URL = "https://github.com/anthropics/skills/commit/3541475";
// anthropic-knowledge doc id (slug+hash) used to resolve source content…
const KNOWLEDGE_DOC_ID = "github.com-anthropics-skills-commit-3541475-f586.md";
// …vs the anthropic-summaries doc id, which is collection-relative (category-prefixed).
const SUMMARY_DOC_ID = "ai/claude/Update claude-api skill.md";

// Knowledge-API behaviour: documents listing (primary id resolution),
// title-search (fallback), and the per-doc fetch.
let docListing: Array<{ id: string; url?: string }> = [];
let searchResults: Array<{ id: string; url?: string; relevance?: number }> = [];
let docText = "";
let docDate: string | undefined;

// Claude response (CATEGORY/SUMMARY envelope) + captured prompt.
let claudeResult = "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Heading\n- point";
let lastPrompt = "";

// Direct-fetch fallback + ingest behaviour (global fetch).
let directOk = true;
let directText = "raw fetched markdown body";
let ingestOk = true;
let ingestStatus = 200;
let ingestBody: Record<string, unknown> = {
  status: "ok",
  file_path: `/abs/data/sources/anthropic-summaries/${SUMMARY_DOC_ID}`,
};

// Recorded candidate status writes; optionally make one status write throw.
let statusCalls: Array<{ id: string; status: string; docId: string | null }> = [];
let throwOnStatus: string | null = null;

mock.module("../ai/executor.ts", () => ({
  executeClaudePrompt: async (prompt: string, _c: unknown, _b: unknown, _sys?: string, onProgress?: (e: { type: string; text: string }) => void) => {
    lastPrompt = prompt;
    onProgress?.({ type: "text_delta", text: claudeResult });
    return { result: claudeResult, outputTokens: 42, inputTokens: 10, wallClockMs: 5 };
  },
}));

mock.module("../ai/knowledge-api-client.ts", () => ({
  fetchKnowledgeApi: async (_baseUrl: string, path: string) => {
    if (path.includes("/documents")) return { documents: docListing };
    if (path.includes("/api/search")) return { results: searchResults };
    if (path.includes("/api/document/")) return { text: docText, metadata: docDate ? { date: docDate } : {} };
    return {};
  },
}));

mock.module("../db/summary-candidates.ts", () => ({
  setCandidateStatus: async (id: string, status: string, docId: string | null = null) => {
    statusCalls.push({ id, status, docId });
    if (throwOnStatus && status === throwOnStatus) throw new Error("db write failed");
  },
}));

const originalFetch = globalThis.fetch;
function installFetchMock() {
  // @ts-expect-error — minimal Response stand-in is enough for the summarizer.
  globalThis.fetch = async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/anthropic-summaries/ingest")) {
      return {
        ok: ingestOk,
        status: ingestStatus,
        json: async () => ingestBody,
        text: async () => JSON.stringify(ingestBody),
      };
    }
    // Direct-fetch fallback.
    return {
      ok: directOk,
      status: directOk ? 200 : 404,
      text: async () => directText,
    };
  };
}

const { summarizeCandidate } = await import("./summarizer.ts");
const { createJob, getJob } = await import("./state.ts");

const config = { knowledgeApiUrl: "http://kb.test" } as unknown as Config;
const bot = { dir: "/tmp/bot", model: "sonnet" } as unknown as BotConfig;

beforeEach(() => {
  docListing = [{ id: KNOWLEDGE_DOC_ID, url: CAND_URL }];
  searchResults = [{ id: KNOWLEDGE_DOC_ID, url: CAND_URL, relevance: 0.99 }];
  docText = "# Commit\nAdds the claude-api skill split.";
  docDate = "2026-06-25";
  claudeResult = "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Heading\n- point";
  lastPrompt = "";
  directOk = true;
  directText = "raw fetched markdown body";
  ingestOk = true;
  ingestStatus = 200;
  ingestBody = { status: "ok", file_path: `/abs/data/sources/anthropic-summaries/${SUMMARY_DOC_ID}` };
  statusCalls = [];
  throwOnStatus = null;
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("happy path: resolves via documents listing, summarizes, ingests, flips candidate to summarized + doc_id", async () => {
  const jobId = createJob("cand-1", "Update claude-api skill", CAND_URL);
  await summarizeCandidate(jobId, "cand-1", "Update claude-api skill", CAND_URL, config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(job.category).toBe("ai/claude-code");
  expect(job.summary).toContain("### Heading");
  // doc_id is the collection-relative (category-prefixed) path from file_path.
  expect(job.docId).toBe(SUMMARY_DOC_ID);

  expect(statusCalls).toHaveLength(1);
  expect(statusCalls[0]).toEqual({ id: "cand-1", status: "summarized", docId: SUMMARY_DOC_ID });
});

test("resolves via title-search when the documents listing misses", async () => {
  docListing = []; // listing has no match…
  // …but title-search returns the exact-url hit.
  const jobId = createJob("cand-1b", "Update claude-api skill", CAND_URL);
  await summarizeCandidate(jobId, "cand-1b", "Update claude-api skill", CAND_URL, config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(statusCalls[0]!.status).toBe("summarized");
});

test("clamps a valid-but-non-ai category back to ai/general", async () => {
  claudeResult = "CATEGORY: tech\n\nSUMMARY:\nbody";
  const jobId = createJob("cand-2", "Title", CAND_URL);
  await summarizeCandidate(jobId, "cand-2", "Title", CAND_URL, config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(job.category).toBe("ai/general");
  expect(statusCalls[0]!.status).toBe("summarized");
});

test("caps oversized content before summarizing so the prompt can't overflow", async () => {
  docListing = [];
  searchResults = [];
  directOk = true;
  directText = "x".repeat(500_000); // ~1MB HTML page stand-in
  const jobId = createJob("cand-cap", "Title", CAND_URL);
  await summarizeCandidate(jobId, "cand-cap", "Title", CAND_URL, config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  // The prompt fed to Claude must be bounded (cap 100k + a small truncation note),
  // not the full 500k-char body.
  expect(lastPrompt.length).toBeLessThan(110_000);
  expect(lastPrompt).toContain("content truncated for length");
});

test("falls back to direct fetch when neither listing nor search resolves the url", async () => {
  docListing = [];
  searchResults = [{ id: "some-other-doc.md", url: "https://example.com/other", relevance: 0.9 }];
  const jobId = createJob("cand-3", "Title", CAND_URL);
  await summarizeCandidate(jobId, "cand-3", "Title", CAND_URL, config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(statusCalls[0]!.status).toBe("summarized");
});

test("fails the job and errors the candidate when content cannot be resolved", async () => {
  docListing = [];
  searchResults = [];
  directOk = false; // direct fetch 404s too
  const jobId = createJob("cand-4", "Title", CAND_URL);
  await summarizeCandidate(jobId, "cand-4", "Title", CAND_URL, config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("error");
  expect(statusCalls).toHaveLength(1);
  expect(statusCalls[0]).toEqual({ id: "cand-4", status: "error", docId: null });
});

test("keeps the job complete when the final candidate status write fails", async () => {
  // The summary is already ingested; a DB hiccup persisting the candidate
  // bookkeeping must not flip the completed job to error.
  throwOnStatus = "summarized";
  const jobId = createJob("cand-6", "Title", CAND_URL);
  await summarizeCandidate(jobId, "cand-6", "Title", CAND_URL, config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(job.docId).toBe(SUMMARY_DOC_ID);
  // Only the (failed) summarized write was attempted — no error-status overwrite.
  expect(statusCalls).toEqual([{ id: "cand-6", status: "summarized", docId: SUMMARY_DOC_ID }]);
});

test("errors the candidate when ingest returns non-200", async () => {
  ingestOk = false;
  ingestStatus = 500;
  ingestBody = { detail: "boom" };
  const jobId = createJob("cand-5", "Title", CAND_URL);
  await summarizeCandidate(jobId, "cand-5", "Title", CAND_URL, config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("error");
  expect(statusCalls[0]).toEqual({ id: "cand-5", status: "error", docId: null });
});
