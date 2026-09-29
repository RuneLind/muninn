import { test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { SUMMARY_SOURCES } from "../../summaries/sources.ts";
import { registerSummariesContextRoutes, SAME_STORY_LIMIT, type SummariesContextDeps } from "./summaries-context.ts";

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
  expect((await appWith().request(`/api/summaries/same-story?q=${"a".repeat(2001)}`)).status).toBe(400);
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
