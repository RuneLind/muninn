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
let lastSystemPrompt = "";
// Paths the summarizer asked the knowledge API for (source-content resolution).
let docFetchPaths: string[] = [];

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

mock.module("../ai/one-shot.ts", () => ({
  executeOneShot: async (prompt: string, _c: unknown, _b: unknown, opts?: { systemPrompt?: string; onProgress?: (e: { type: string; text: string }) => void }) => {
    lastPrompt = prompt;
    lastSystemPrompt = opts?.systemPrompt ?? "";
    opts?.onProgress?.({ type: "text_delta", text: claudeResult });
    return { result: claudeResult, outputTokens: 42, inputTokens: 10, wallClockMs: 5 };
  },
  // summarizer-shared imports this too (the thinking-budget capability gate) —
  // mirror the real rule rather than hardcoding, so the mock can't drift.
  connectorCapabilities: (b: { connector?: string }) => {
    const isClaude = (b.connector ?? "claude-cli") === "claude-cli" || b.connector === "claude-sdk";
    return { supportsExtraDirs: isClaude, supportsThinkingBudget: isClaude };
  },
}));

mock.module("../ai/knowledge-api-client.ts", () => ({
  fetchKnowledgeApi: async (_baseUrl: string, path: string) => {
    if (path.includes("/documents")) return { documents: docListing };
    if (path.includes("/api/search")) return { results: searchResults };
    if (path.includes("/api/document/")) {
      docFetchPaths.push(path);
      return { text: docText, metadata: docDate ? { date: docDate } : {} };
    }
    return {};
  },
}));

mock.module("../db/summary-candidates.ts", () => ({
  setCandidateStatus: async (id: string, status: string, docId: string | null = null) => {
    statusCalls.push({ id, status, docId });
    if (throwOnStatus && status === throwOnStatus) throw new Error("db write failed");
  },
}));

// Link-enrichment (X path) fetch behaviour: the youtube transcript endpoint and
// the article direct fetch. Reset to a happy default in beforeEach.
let transcriptOk = true;
let transcriptText = "TRANSCRIPT: the linked 28-minute video walks through agent loops.";
let articleOk = true;
let articleText = "ARTICLE BODY: the linked long-form write-up.";

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
    // YouTube transcript enrichment (X path).
    if (url.includes("/api/youtube/transcript/")) {
      return {
        ok: transcriptOk,
        status: transcriptOk ? 200 : 404,
        json: async () => ({ transcript: transcriptText }),
      };
    }
    // Article enrichment — a direct fetch of the external destination URL.
    if (url.startsWith("https://article.test/")) {
      return {
        ok: articleOk,
        status: articleOk ? 200 : 404,
        text: async () => articleText,
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
  lastSystemPrompt = "";
  docFetchPaths = [];
  directOk = true;
  directText = "raw fetched markdown body";
  ingestOk = true;
  ingestStatus = 200;
  ingestBody = { status: "ok", file_path: `/abs/data/sources/anthropic-summaries/${SUMMARY_DOC_ID}` };
  statusCalls = [];
  throwOnStatus = null;
  transcriptOk = true;
  transcriptText = "TRANSCRIPT: the linked 28-minute video walks through agent loops.";
  articleOk = true;
  articleText = "ARTICLE BODY: the linked long-form write-up.";
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

test("derives a collection-relative doc_id from Huginn's already-relative file_path", async () => {
  // The REAL Huginn ingest returns file_path relative to the collection root
  // (write_categorized_markdown → "ai/general/Foo.md"), NOT an absolute path — so
  // the category prefix must survive (a bare basename 502s from the doc panel).
  ingestBody = { status: "ok", file_path: "ai/general/Add SDK disclosure process.md" };
  const jobId = createJob("cand-rel", "Add SDK disclosure process", CAND_URL);
  await summarizeCandidate(jobId, "cand-rel", "Add SDK disclosure process", CAND_URL, config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(job.docId).toBe("ai/general/Add SDK disclosure process.md");
  expect(statusCalls[0]).toEqual({
    id: "cand-rel",
    status: "summarized",
    docId: "ai/general/Add SDK disclosure process.md",
  });
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

// --- X source (source_doc_id path) — Phase 2 ---

const X_TWEET_URL = "https://x.com/karpathy/status/1789";
const X_DOC_ID = "2026-07-04_karpathy_1789.md";

test("X candidate: resolves content from the x-feed doc id, not the (unfetchable) url", async () => {
  docListing = []; // no anthropic-knowledge listing hit — must not fall back to it
  docText = "# @karpathy — Andrej Karpathy\n\nA long note on agent design and evals…";
  const jobId = createJob("x-1", "@karpathy: A long note on agent design", X_TWEET_URL);
  await summarizeCandidate(jobId, "x-1", "@karpathy: A long note on agent design", X_TWEET_URL, config, bot, X_DOC_ID);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  // Content came straight from the x-feed collection by doc id.
  expect(docFetchPaths.some((p) => p.includes(`/api/document/x-feed/`) && p.includes(encodeURIComponent(X_DOC_ID)))).toBe(true);
  // The X system-prompt variant was used (note framing, not "Anthropic release").
  expect(lastSystemPrompt).toContain("long-form X");
  // Still ingests onto the shared anthropic-summaries shelf, same CATEGORY contract.
  expect(job.category).toBe("ai/claude-code");
  expect(statusCalls[0]).toEqual({ id: "x-1", status: "summarized", docId: SUMMARY_DOC_ID });
});

test("X candidate: errors the job when the x-feed doc is empty (no url fallback)", async () => {
  docText = ""; // empty x-feed doc
  directOk = true; // even if a direct fetch would 200, the X path must not use it
  const jobId = createJob("x-2", "@someone: note", X_TWEET_URL);
  await summarizeCandidate(jobId, "x-2", "@someone: note", X_TWEET_URL, config, bot, X_DOC_ID);

  const job = getJob(jobId)!;
  expect(job.status).toBe("error");
  expect(statusCalls[0]).toEqual({ id: "x-2", status: "error", docId: null });
});

// --- Link enrichment (PR 2) ---

const YT_LINK = "https://youtu.be/dQw4w9WgXcQ";
// An x-feed doc footer with the plural **Links:** line carrying the destination.
function xDocWithLink(link: string): string {
  return [
    "# @karpathy — Andrej Karpathy",
    "",
    "just dropped a 28-minute video on agent design — watch it",
    "",
    "---",
    "",
    "- **Type:** tweet",
    "- **Link:** https://x.com/karpathy/status/1789",
    `- **Links:** ${link}`,
  ].join("\n");
}

test("X candidate: enriches a pointer tweet with the linked YouTube transcript", async () => {
  docText = xDocWithLink(YT_LINK);
  const jobId = createJob("x-yt", "@karpathy: 28-min video", X_TWEET_URL);
  await summarizeCandidate(jobId, "x-yt", "@karpathy: 28-min video", X_TWEET_URL, config, bot, X_DOC_ID, "x-post");

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  // The prompt fed to Claude carries BOTH the tweet text and the delimited linked
  // content — the transcript, not just the pointer tweet.
  expect(lastPrompt).toContain("just dropped a 28-minute video");
  expect(lastPrompt).toContain(`--- LINKED CONTENT (${YT_LINK}) ---`);
  expect(lastPrompt).toContain("TRANSCRIPT: the linked 28-minute video");
  // x-post framing: linked content is supporting context, the post stays the subject.
  expect(lastSystemPrompt).toContain("SUPPORTING CONTEXT");
});

test("X candidate: enriches with a direct article fetch for a non-youtube link", async () => {
  docText = xDocWithLink("https://article.test/deep-dive");
  const jobId = createJob("x-art", "@author: read this", X_TWEET_URL);
  await summarizeCandidate(jobId, "x-art", "@author: read this", X_TWEET_URL, config, bot, X_DOC_ID, "x-post");

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(lastPrompt).toContain("--- LINKED CONTENT (https://article.test/deep-dive) ---");
  expect(lastPrompt).toContain("ARTICLE BODY: the linked long-form write-up.");
});

test("X candidate: a failed link fetch degrades to tweet-only content, job still completes", async () => {
  docText = xDocWithLink(YT_LINK);
  transcriptOk = false; // transcript endpoint 404s
  const jobId = createJob("x-fail", "@karpathy: 28-min video", X_TWEET_URL);
  await summarizeCandidate(jobId, "x-fail", "@karpathy: 28-min video", X_TWEET_URL, config, bot, X_DOC_ID, "x-post");

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  // Tweet text survives; no LINKED CONTENT section was added.
  expect(lastPrompt).toContain("just dropped a 28-minute video");
  expect(lastPrompt).not.toContain("LINKED CONTENT");
  // No enrichment framing when nothing was folded in.
  expect(lastSystemPrompt).not.toContain("SUPPORTING CONTEXT");
  expect(statusCalls[0]!.status).toBe("summarized");
});

test("X candidate: a doc with no external link is byte-identical tweet-only content", async () => {
  docText = "# @someone\n\nA long-form note with no links at all.\n\n- **Type:** note";
  const jobId = createJob("x-nolink", "@someone: note", X_TWEET_URL);
  await summarizeCandidate(jobId, "x-nolink", "@someone: note", X_TWEET_URL, config, bot, X_DOC_ID, "x-post");

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(lastPrompt).not.toContain("LINKED CONTENT");
});
