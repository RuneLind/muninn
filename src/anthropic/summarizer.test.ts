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

// Source-page drafter trigger — spied, never run (the real one is fire-and-forget
// and hits huginn/DB). Records the args so the tests assert the docId/category/url
// the summarizer hands it.
let sourceDraftCalls: Array<{ input: Record<string, unknown> }> = [];
mock.module("../gardener/source-drafter-run.ts", () => ({
  triggerSourceDraftFromCapture: (_bot: unknown, input: Record<string, unknown>) => {
    sourceDraftCalls.push({ input });
  },
}));

// Link-enrichment (X path) fetch behaviour: the youtube transcript endpoint and
// the article direct fetch. Reset to a happy default in beforeEach.
let transcriptOk = true;
let transcriptText = "TRANSCRIPT: the linked 28-minute video walks through agent loops.";
let articleOk = true;
let articleText = "ARTICLE BODY: the linked long-form write-up.";
/** Every URL global fetch was asked for — a refused URL must never appear here. */
let fetchedUrls: string[] = [];

const originalFetch = globalThis.fetch;
/**
 * The two fetches that follow a third-party URL (article enrichment + the direct
 * fallback) now go through `../summaries/safe-fetch.ts`, which reads `status`,
 * `headers` and `body` — so these stand-ins are REAL `Response`s, not `{ok, text}`
 * literals: a stub without a content-type header is refused by the guard, which is
 * the guard doing its job, not a mock detail worth faking around.
 */
function installFetchMock() {
  const body = (text: string, ok: boolean, type = "text/html; charset=utf-8") =>
    new Response(ok ? text : "not found", {
      status: ok ? 200 : 404,
      headers: { "content-type": type },
    });
  // @ts-expect-error — the Response subset the summarizer uses.
  globalThis.fetch = async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchedUrls.push(url);
    if (url.includes("/api/anthropic-summaries/ingest")) {
      return {
        ok: ingestOk,
        status: ingestStatus,
        json: async () => ingestBody,
        text: async () => JSON.stringify(ingestBody),
      };
    }
    // YouTube transcript enrichment (X path) — NOT guarded (our own baseUrl).
    if (url.includes("/api/youtube/transcript/")) {
      return {
        ok: transcriptOk,
        status: transcriptOk ? 200 : 404,
        json: async () => ({ transcript: transcriptText }),
      };
    }
    // Article enrichment — a guarded direct fetch of the external destination URL.
    if (url.startsWith("https://article.test/")) return body(articleText, articleOk);
    // A public-looking host that bounces to a loopback service — the redirect hop
    // is where the guard has to catch this one.
    if (url.startsWith("https://redirector.test/")) {
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:3010/api/activity" },
      });
    }
    // Direct-fetch fallback (guarded).
    return body(directText, directOk);
  };
}

/**
 * The guard RESOLVES a hostname and judges the address, so the `.test` hosts these
 * tests use would be refused as unresolvable — DNS is faked here exactly the way
 * `fetch` is, mapping every NAME to a public address. IP literals skip DNS entirely,
 * so the loopback-refusal test below still exercises the real refusal.
 */
mock.module("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

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
  sourceDraftCalls = [];
  fetchedUrls = [];
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

test("fires the source-draft trigger with the collection-relative docId, category, and url", async () => {
  claudeResult = "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Heading\n- point";
  const jobId = createJob("cand-sd", "Update claude-api skill", CAND_URL);
  await summarizeCandidate(jobId, "cand-sd", "Update claude-api skill", CAND_URL, config, bot);

  expect(sourceDraftCalls).toHaveLength(1);
  expect(sourceDraftCalls[0]!.input).toMatchObject({
    collection: "anthropic-summaries",
    docId: SUMMARY_DOC_ID,
    url: CAND_URL,
    category: "ai/claude-code",
    sourceTitle: "Update claude-api skill",
  });
});

test("skips the source-draft trigger when ingest returns no file_path (null docId — never coerce)", async () => {
  ingestBody = { status: "ok" }; // no file_path ⇒ docId stays null
  const jobId = createJob("cand-nofp", "Title", CAND_URL);
  await summarizeCandidate(jobId, "cand-nofp", "Title", CAND_URL, config, bot);

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete"); // job still completes
  expect(sourceDraftCalls).toHaveLength(0); // but no source draft keyed on a null id
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

test("X candidate: a link pointing at OUR OWN dashboard is refused and degrades to tweet-only", async () => {
  // The contract: a tweet naming a loopback service gets the SAME outcome as a dead
  // link — tweet-only text, job complete, candidate summarized — and the dashboard
  // is never contacted, so nothing internal can reach the summary or the wiki.
  docText = xDocWithLink("http://127.0.0.1:3010/api/activity");
  const jobId = createJob("x-ssrf", "@someone: look at this", X_TWEET_URL);
  await summarizeCandidate(jobId, "x-ssrf", "@someone: look at this", X_TWEET_URL, config, bot, X_DOC_ID, "x-post");

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(lastPrompt).toContain("just dropped a 28-minute video");
  expect(lastPrompt).not.toContain("LINKED CONTENT");
  expect(lastSystemPrompt).not.toContain("SUPPORTING CONTEXT");
  expect(statusCalls[0]!.status).toBe("summarized");
  // Refused BEFORE the socket: the guard never handed the URL to fetch.
  expect(fetchedUrls.some((u) => u.includes("127.0.0.1:3010"))).toBe(false);
});

test("X candidate: a public link that REDIRECTS to our dashboard is refused at the hop", async () => {
  // The interesting shape — the footer URL passes every check a link-filter can do
  // and only the redirect target is internal. Same degrade as a dead link.
  docText = xDocWithLink("https://redirector.test/go");
  const jobId = createJob("x-redir", "@someone: look at this", X_TWEET_URL);
  await summarizeCandidate(jobId, "x-redir", "@someone: look at this", X_TWEET_URL, config, bot, X_DOC_ID, "x-post");

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(lastPrompt).toContain("just dropped a 28-minute video");
  expect(lastPrompt).not.toContain("LINKED CONTENT");
  expect(statusCalls[0]!.status).toBe("summarized");
  // Hop 1 was fetched (it looked fine); hop 2 never was.
  expect(fetchedUrls.some((u) => u.startsWith("https://redirector.test/"))).toBe(true);
  expect(fetchedUrls.some((u) => u.includes("127.0.0.1:3010"))).toBe(false);
});

// --- Destination-keyed pointer rows (x-link wave collapse) ---

// A destination-keyed row's `url` IS the group key, and the representative doc may list
// a DIFFERENT link first (multi-link footers, or a link that normalization rewrote).
const DEST_URL = "https://article.test/deep-dive";

test("x-link destination-keyed row enriches the CANDIDATE url, not the doc's links[0]", async () => {
  docText = [
    "# @karpathy — Andrej Karpathy",
    "",
    "this is the one to read",
    "",
    "---",
    "",
    "- **Link:** https://x.com/karpathy/status/1789",
    `- **Links:** ${YT_LINK} ${DEST_URL}`,
  ].join("\n");
  const jobId = createJob("x-dest", "@karpathy: read this", DEST_URL);
  await summarizeCandidate(jobId, "x-dest", "@karpathy: read this", DEST_URL, config, bot, X_DOC_ID, "x-link");

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  // The group URL was fetched — NOT the doc's first link (the YouTube transcript).
  expect(lastPrompt).toContain(`--- LINKED CONTENT (${DEST_URL}) ---`);
  expect(lastPrompt).toContain("ARTICLE BODY: the linked long-form write-up.");
  expect(lastPrompt).not.toContain("TRANSCRIPT: the linked 28-minute video");
  // x-link framing: the destination is the PRIMARY subject.
  expect(lastSystemPrompt).toContain("PRIMARY subject");
});

test("x-link kind-guard: an x-post row keeps enriching the doc's links[0]", async () => {
  docText = [
    "# @karpathy — Andrej Karpathy",
    "",
    "a long-form note that also links out",
    "",
    "---",
    "",
    "- **Type:** note",
    `- **Links:** ${YT_LINK} ${DEST_URL}`,
  ].join("\n");
  // Same candidate url, but kind x-post ⇒ the preference must NOT fire.
  const jobId = createJob("x-post-guard", "@karpathy: note", DEST_URL);
  await summarizeCandidate(jobId, "x-post-guard", "@karpathy: note", DEST_URL, config, bot, X_DOC_ID, "x-post");

  expect(getJob(jobId)!.status).toBe("complete");
  expect(lastPrompt).toContain(`--- LINKED CONTENT (${YT_LINK}) ---`);
  expect(lastPrompt).toContain("TRANSCRIPT: the linked 28-minute video");
});

test("x-link destination-keyed row falls back to a direct fetch when the x-feed doc is gone", async () => {
  docText = ""; // the representative tweet's doc evicted / re-indexed under a fresh id
  const jobId = createJob("x-stale", "@karpathy: read this", DEST_URL);
  await summarizeCandidate(jobId, "x-stale", "@karpathy: read this", DEST_URL, config, bot, X_DOC_ID, "x-link");

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  // Content came from the destination itself (non-x.com by construction), not nothing.
  expect(lastPrompt).toContain("ARTICLE BODY: the linked long-form write-up.");
  expect(statusCalls[0]!.status).toBe("summarized");
});

test("a tweet-keyed x-link row keeps the no-url-fallback rule (x.com login wall)", async () => {
  docText = "";
  directOk = true;
  const jobId = createJob("x-tweetkeyed", "@someone: pointer", X_TWEET_URL);
  await summarizeCandidate(jobId, "x-tweetkeyed", "@someone: pointer", X_TWEET_URL, config, bot, X_DOC_ID, "x-link");

  expect(getJob(jobId)!.status).toBe("error");
  expect(statusCalls[0]).toEqual({ id: "x-tweetkeyed", status: "error", docId: null });
});

test("X candidate: a doc with no external link is byte-identical tweet-only content", async () => {
  docText = "# @someone\n\nA long-form note with no links at all.\n\n- **Type:** note";
  const jobId = createJob("x-nolink", "@someone: note", X_TWEET_URL);
  await summarizeCandidate(jobId, "x-nolink", "@someone: note", X_TWEET_URL, config, bot, X_DOC_ID, "x-post");

  const job = getJob(jobId)!;
  expect(job.status).toBe("complete");
  expect(lastPrompt).not.toContain("LINKED CONTENT");
});
