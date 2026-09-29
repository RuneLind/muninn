import { test, expect, afterEach } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { SUMMARY_SOURCES } from "../../summaries/sources.ts";
import {
  _resetSameStoryWarningsForTests,
  registerSummariesContextRoutes,
  SAME_STORY_LIMIT,
  SAME_STORY_MAX_Q_BYTES,
  type SummariesContextDeps,
} from "./summaries-context.ts";

const CONFIG = { knowledgeApiUrl: "http://kb.test" } as Config;
const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function appWith(deps?: Partial<SummariesContextDeps>): Hono {
  const app = new Hono();
  registerSummariesContextRoutes(app, CONFIG, {
    lookupSourceProposals: async () => [],
    ...deps,
  });
  return app;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake huginn that serves every summary collection but `missing`, and
 *  answers /api/search the way huginn does: 404 when any listed collection is
 *  not served. */
function fakeHuginn(missing: string, calls: string[]): void {
  const served = SUMMARY_SOURCES.map((s) => s.collection).filter((c) => c !== missing).concat(["wiki"]);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname === "/api/collections") return json({ collections: served.map((name) => ({ name })) });
    if (url.pathname === "/api/search") {
      const asked = url.searchParams.getAll("collection");
      const absent = asked.find((c) => !served.includes(c));
      if (absent) return json({ detail: `Collection '${absent}' not found` }, 404);
      return json({
        results: [
          { collection: "youtube-summaries", id: "a.md", relevance: 0.6 },
          { collection: "anthropic-summaries", id: "b.md", relevance: 0.5 },
          { collection: "wiki", id: "c.md", relevance: 0.4 },
        ],
      });
    }
    return json({}, 404);
  }) as typeof fetch;
}

test("same-story: a summary collection huginn does not serve is left out of the search, not a 404", async () => {
  const calls: string[] = [];
  fakeHuginn("tiktok-summaries", calls);
  const res = await appWith().request("/api/summaries/same-story?q=Qwen%203.8");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.missing).toEqual(["tiktok-summaries"]);
  const search = new URL("http://x" + calls.find((c) => c.startsWith("/api/search"))!);
  expect(search.searchParams.getAll("collection").sort()).toEqual(
    SUMMARY_SOURCES.map((s) => s.collection).filter((c) => c !== "tiktok-summaries").sort(),
  );
  expect(search.searchParams.get("limit")).toBe(String(SAME_STORY_LIMIT));
  expect(search.searchParams.get("corrective")).toBe("off");
  expect(search.searchParams.get("max_chunk_chars")).toBe("200");
  // Cheap by construction: no cross-encoder pass, one chunk per document.
  expect(search.searchParams.get("rerank")).toBe("false");
  expect(search.searchParams.get("max_chunks_per_doc")).toBe("1");
  expect(SAME_STORY_LIMIT).toBe(15);
  // Each hit carries its source; a hit from a non-summary collection is dropped.
  expect(body.results.map((r: { id: string; source: string }) => [r.id, r.source])).toEqual([
    ["a.md", "youtube"],
    ["b.md", "anthropic"],
  ]);
});

test("same-story: no summary collection served answers an empty list without searching", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return json({ collections: [{ name: "wiki" }] });
  }) as typeof fetch;
  const res = await appWith().request("/api/summaries/same-story?q=x");
  expect(await res.json()).toEqual({ results: [], missing: SUMMARY_SOURCES.map((s) => s.collection) });
  expect(calls.some((c) => c.includes("/api/search"))).toBe(false);
});

test("same-story: 400 without q or with an over-long q; 502 when huginn fails", async () => {
  expect((await appWith().request("/api/summaries/same-story")).status).toBe(400);
  expect((await appWith().request("/api/summaries/same-story?q=%20")).status).toBe(400);
  expect((await appWith().request(`/api/summaries/same-story?q=${"a".repeat(SAME_STORY_MAX_Q_BYTES + 1)}`)).status).toBe(400);
  globalThis.fetch = (async () => json({ error: "down" }, 500)) as unknown as typeof fetch;
  expect((await appWith().request("/api/summaries/same-story?q=x")).status).toBe(502);
});

test("doc-context: maps source to its collection and returns the rows", async () => {
  const asked: [string, string][] = [];
  const app = appWith({
    lookupSourceProposals: async (collection, docId) => {
      asked.push([collection, docId]);
      return [{ id: "p1", bot: "jarvis", targetPath: "sources/x.mdx", status: "draft" }];
    },
  });
  const res = await app.request(`/api/summaries/doc-context?source=vimeo&docId=${encodeURIComponent("ai/Talk.md")}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ proposals: [{ id: "p1", bot: "jarvis", targetPath: "sources/x.mdx", status: "draft" }] });
  expect(asked).toEqual([["vimeo-summaries", "ai/Talk.md"]]);
  expect((await app.request("/api/summaries/doc-context?source=bogus&docId=a.md")).status).toBe(400);
  expect((await app.request("/api/summaries/doc-context?source=youtube")).status).toBe(400);
});

test("doc-context: a failing lookup is a 500 with no driver text", async () => {
  const app = appWith({ lookupSourceProposals: async () => { throw new Error("CONNECTION_CLOSED db-host"); } });
  const res = await app.request("/api/summaries/doc-context?source=youtube&docId=a.md");
  expect(res.status).toBe(500);
  expect(JSON.stringify(await res.json())).not.toContain("db-host");
});

test("same-story: q is bounded by its encoded size, not its length", async () => {
  expect(SAME_STORY_MAX_Q_BYTES).toBe(2048);
  const calls: string[] = [];
  fakeHuginn("", calls);
  // 200 emoji are 400 UTF-16 units and 2,400 encoded bytes.
  const emoji = encodeURIComponent("🧠".repeat(200));
  expect((await appWith().request(`/api/summaries/same-story?q=${emoji}`)).status).toBe(400);
  expect(calls).toEqual([]);
  // At the cap exactly, it searches.
  const fits = encodeURIComponent("🧠".repeat(170) + "a".repeat(SAME_STORY_MAX_Q_BYTES - 170 * 12));
  expect((await appWith().request(`/api/summaries/same-story?q=${fits}`)).status).toBe(200);
});

/** A fake huginn whose /api/search answers after `ms`, or rejects the moment
 *  its request is aborted; `signals` gets each search request's signal. */
function slowHuginn(signals: AbortSignal[], ms = 400): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/collections") {
      return json({ collections: SUMMARY_SOURCES.map((s) => ({ name: s.collection })) });
    }
    const signal = init?.signal as AbortSignal;
    signals.push(signal);
    return new Promise<Response>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      setTimeout(() => resolve(json({ results: [] })), ms);
    });
  }) as typeof fetch;
}

test("same-story: an abandoned request aborts its huginn fetch", async () => {
  const signals: AbortSignal[] = [];
  slowHuginn(signals);
  const client = new AbortController();
  const pending = appWith().request(new Request("http://x/api/summaries/same-story?q=Qwen", { signal: client.signal }));
  while (signals.length === 0) await Bun.sleep(5);
  expect(signals[0]!.aborted).toBe(false);
  client.abort();
  await Bun.sleep(20);
  expect(signals[0]!.aborted).toBe(true);
  await pending;
});

async function captureWarns(fn: (records: LogRecord[]) => Promise<void>): Promise<void> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (r: LogRecord) => records.push(r) },
    loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "warning" }],
    reset: true,
  });
  try {
    await fn(records);
  } finally {
    await reset();
  }
}

test("same-story: a malformed /api/collections answer is a 502 with one warn per shape, not 'all missing'", async () => {
  _resetSameStoryWarningsForTests();
  await captureWarns(async (records) => {
    let listed: unknown = { collections: "youtube-summaries" };
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return json(listed);
    }) as typeof fetch;
    const app = appWith();
    expect((await app.request("/api/summaries/same-story?q=x")).status).toBe(502);
    expect((await app.request("/api/summaries/same-story?q=x")).status).toBe(502);
    listed = { collections: [{ id: 1 }, "wiki"] };
    expect((await app.request("/api/summaries/same-story?q=x")).status).toBe(502);
    listed = {};
    expect((await app.request("/api/summaries/same-story?q=x")).status).toBe(502);
    expect(calls.some((c) => c.includes("/api/search"))).toBe(false);
    const warns = records.filter((r) => r.level === "warning");
    expect(warns).toHaveLength(3);
    // An empty list is a valid answer: no summary collection served.
    listed = { collections: [] };
    const empty = await app.request("/api/summaries/same-story?q=x");
    expect(empty.status).toBe(200);
    expect((await empty.json()).missing).toHaveLength(SUMMARY_SOURCES.length);
  });
});

test("doc-context: a docId with a NUL is a 400 before the lookup", async () => {
  const asked: string[] = [];
  const ok = appWith({ lookupSourceProposals: async (_c, id) => { asked.push(id); return []; } });
  expect((await ok.request("/api/summaries/doc-context?source=youtube&docId=a%00b.md")).status).toBe(400);
  expect(asked).toEqual([]);
});

test("doc-context: the warn log truncates a long docId", async () => {
  await captureWarns(async (records) => {
    const failing = appWith({ lookupSourceProposals: async () => { throw new Error("boom"); } });
    const long = "d".repeat(5000) + ".md";
    expect((await failing.request(`/api/summaries/doc-context?source=youtube&docId=${long}`)).status).toBe(500);
    const warn = records.find((r) => r.level === "warning")!;
    expect(String(warn.properties.docId).length).toBeLessThanOrEqual(201);
  });
});

test("same-story: an abandoned request is not logged as huginn unreachable", async () => {
  await captureWarns(async (records) => {
    const signals: AbortSignal[] = [];
    slowHuginn(signals);
    const client = new AbortController();
    const pending = appWith().request(new Request("http://x/api/summaries/same-story?q=Qwen", { signal: client.signal }));
    while (signals.length === 0) await Bun.sleep(5);
    client.abort();
    await pending;
    expect(records.filter((r) => r.level === "warning")).toEqual([]);
  });
});
