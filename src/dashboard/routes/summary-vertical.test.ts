import { test, expect } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import type { Job, JobEvent } from "../../summaries/job-store.ts";
import { registerSummaryVertical, type SummaryVerticalStore } from "./summary-vertical.ts";

type Status = "pending" | "summarizing" | "complete" | "error";
type Fields = { videoId: string };
type TestJob = Job<Status, Fields>;

const CONFIG = { knowledgeApiUrl: "http://kb.test" } as Config;

function makeJob(overrides: Partial<TestJob>): TestJob {
  return {
    id: "job-1",
    title: "T",
    url: "https://example.com/v",
    status: "pending",
    createdAt: Date.now(),
    text: "",
    videoId: "v1",
    ...overrides,
  } as TestJob;
}

/** A store that returns a single fixed job (or none). subscribe is a no-op — the
 *  terminal-short-circuit tests never reach it. */
function fixedStore(job: TestJob | undefined, recorder?: { limit?: number }): SummaryVerticalStore<Status, Fields> {
  return {
    getJob: (id) => (job && id === job.id ? job : undefined),
    getRecentJobs: (limit) => {
      if (recorder) recorder.limit = limit;
      return job ? [job] : [];
    },
    subscribe: (_id: string, _fn: (event: JobEvent<Status>) => void) => () => {},
  };
}

function appFor(
  store: SummaryVerticalStore<Status, Fields>,
  extra?: {
    redirect?: { path: string; source: string };
    corsPreflight?: boolean;
    completeCarriesSummary?: boolean;
  },
): Hono {
  const app = new Hono();
  registerSummaryVertical(app, CONFIG, {
    apiBase: "/api/test",
    collection: "test-summaries",
    store,
    ...extra,
  });
  return app;
}

test("stream: 404 when the job is unknown", async () => {
  const app = appFor(fixedStore(undefined));
  const res = await app.request("/api/test/stream/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Job not found" });
});

test("stream: replays state and short-circuits on a terminal complete job (bare {})", async () => {
  const job = makeJob({
    status: "complete",
    text: "hello world",
    category: "ai/general",
    summary: "the summary",
    similar: [{ title: "S", url: "https://s" }],
  });
  const app = appFor(fixedStore(job));
  const body = await (await app.request("/api/test/stream/job-1")).text();

  expect(body).toContain("event: status");
  expect(body).toContain(`data: ${JSON.stringify({ status: "complete" })}`);
  expect(body).toContain("event: text_delta");
  expect(body).toContain(`data: ${JSON.stringify({ text: "hello world" })}`);
  expect(body).toContain("event: category");
  expect(body).toContain(`data: ${JSON.stringify({ category: "ai/general" })}`);
  expect(body).toContain("event: similar");
  expect(body).toContain("event: complete");
  // Non-tiktok: bare {} on the terminal complete replay, no summary leaked.
  expect(body).toContain("event: complete\ndata: {}");
  expect(body).not.toContain("the summary");
});

test("stream: tiktok variant ships the parsed summary on the terminal complete replay", async () => {
  const job = makeJob({ status: "complete", text: "chatter", summary: "clean summary" });
  const app = appFor(fixedStore(job), { completeCarriesSummary: true });
  const body = await (await app.request("/api/test/stream/job-1")).text();

  expect(body).toContain("event: complete");
  expect(body).toContain(`data: ${JSON.stringify({ summary: "clean summary" })}`);
});

test("stream: short-circuits on a terminal error job with the error message", async () => {
  const job = makeJob({ status: "error", error: "boom" });
  const app = appFor(fixedStore(job));
  const body = await (await app.request("/api/test/stream/job-1")).text();

  expect(body).toContain("event: error");
  expect(body).toContain(`data: ${JSON.stringify({ message: "boom" })}`);
  expect(body).not.toContain("event: complete");
});

test("jobs: clamps the limit into [1, 100] and defaults to 20", async () => {
  const cases: Array<[string | null, number]> = [
    ["500", 100],
    ["0", 1],
    ["5", 5],
    [null, 20],
  ];
  for (const [q, expected] of cases) {
    const rec: { limit?: number } = {};
    const app = appFor(fixedStore(makeJob({}), rec));
    const path = q === null ? "/api/test/jobs" : `/api/test/jobs?limit=${q}`;
    await app.request(path);
    expect(rec.limit).toBe(expected);
  }
});

test("document: forwards the still-encoded doc id verbatim (no lossy re-decode)", async () => {
  const origFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const app = appFor(fixedStore(makeJob({})));
    // Reserved chars stay percent-encoded (%2C comma, %2F slash, %24 dollar).
    const res = await app.request("/api/test/document/ai%2Cclaude%2FFoo%24.md");
    expect(res.status).toBe(200);
    expect(capturedUrl).toBe("http://kb.test/api/document/test-summaries/ai%2Cclaude%2FFoo%24.md");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("similar: 400 without q, else proxies to the collection search", async () => {
  const app = appFor(fixedStore(makeJob({})));
  const noQ = await app.request("/api/test/similar");
  expect(noQ.status).toBe(400);

  const origFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await app.request("/api/test/similar?q=hello");
    expect(capturedUrl).toContain("http://kb.test/api/search?");
    expect(capturedUrl).toContain("collection=test-summaries");
    expect(capturedUrl).toContain("limit=7");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("redirect: bare path 302s to /summaries carrying the source tag + inbound params", async () => {
  const app = appFor(fixedStore(makeJob({})), { redirect: { path: "/foo", source: "foo" } });
  const res = await app.request("/foo?job=123", { redirect: "manual" });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/summaries?job=123&source=foo");
});

test("cors preflight: OPTIONS <apiBase>/summarize → 204 with CORS headers", async () => {
  const app = appFor(fixedStore(makeJob({})), { corsPreflight: true });
  const res = await app.request("/api/test/summarize", { method: "OPTIONS" });
  expect(res.status).toBe(204);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST");
});

test("cors preflight: omitted when corsPreflight is not set (no OPTIONS handler)", async () => {
  const app = appFor(fixedStore(makeJob({})));
  const res = await app.request("/api/test/summarize", { method: "OPTIONS" });
  expect(res.status).toBe(404);
});
