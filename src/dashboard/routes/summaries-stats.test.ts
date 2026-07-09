import { test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import {
  registerSummariesRoutes,
  __resetSummariesStatsCacheForTest,
  type SummariesStatsDeps,
} from "./summaries-routes.ts";

const CONFIG = { knowledgeApiUrl: "http://kb.test" } as Config;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Per-collection listing fixtures, dated relative to now so they're in-window. */
function fixtures() {
  const now = Date.now();
  return {
    "youtube-summaries": [
      { id: "yt1", date: iso(now - 2 * DAY), url: "https://yt/1", title: "YT One" },
      { id: "yt2", date: iso(now - 3 * DAY), url: "https://yt/2" },
    ],
    "x-articles": [{ id: "xa1", date: iso(now - 4 * DAY), url: "https://x/1" }],
    "anthropic-summaries": [{ id: "an-old", date: iso(now - 200 * DAY) }], // out of 30d window
    "tiktok-summaries": [{ id: "tt-undated" }], // no date ⇒ undated, but kept in window
  } as Record<string, Array<Record<string, unknown>>>;
}

let fetchCalls: string[] = [];
let origFetch: typeof fetch;
let failCollections = new Set<string>();

function installFetch() {
  origFetch = globalThis.fetch;
  const data = fixtures();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    const m = url.match(/\/api\/collection\/([^/]+)\/documents/);
    const collection = m ? m[1]! : "";
    if (failCollections.has(collection)) {
      return new Response("nope", { status: 500 });
    }
    return new Response(JSON.stringify({ documents: data[collection] ?? [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function fakeDeps(overrides?: {
  consumed?: string[];
  pending?: string[];
  seenBots?: string[];
  throwCoverage?: boolean;
}): SummariesStatsDeps {
  return {
    getConsumed: async (bot) => {
      overrides?.seenBots?.push(bot);
      if (overrides?.throwCoverage) throw new Error("db down");
      return new Set(overrides?.consumed ?? []);
    },
    getPending: async () => new Set(overrides?.pending ?? []),
  };
}

function appWith(deps: SummariesStatsDeps): Hono {
  const app = new Hono();
  registerSummariesRoutes(app, CONFIG, deps);
  return app;
}

beforeEach(() => {
  __resetSummariesStatsCacheForTest();
  fetchCalls = [];
  failCollections = new Set();
  installFetch();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

test("returns months (8) + per-source rollup + reconciling coverage", async () => {
  const app = appWith(
    fakeDeps({ consumed: ["youtube-summaries/yt1"], pending: ["x-articles/xa1"] }),
  );
  const res = await app.request("/api/summaries/stats");
  expect(res.status).toBe(200);
  const body = await res.json();

  expect(body.months).toHaveLength(8);

  // Window docs: yt1, yt2, xa1 (dated in window) = 3; an-old is 200d ago so
  // excluded, and tt-undated has no date so it's excluded from the coverage
  // window too (reported via coverage.undated instead of inflating the totals).
  expect(body.coverage.total).toBe(3);
  expect(body.coverage.consumed).toBe(1);
  expect(body.coverage.pending).toBe(1);
  expect(body.coverage.neverClustered).toHaveLength(1);
  expect(body.coverage.undated).toBe(1);
  expect(body.coverage.total).toBe(
    body.coverage.consumed + body.coverage.pending + body.coverage.neverClustered.length,
  );

  // Undated tiktok doc reported in bySource, not charted.
  expect(body.bySource.tiktok.undated).toBe(1);
  // No errors when every collection loads.
  expect(body.errors).toBeUndefined();

  // Never-clustered rows carry title (id fallback) + url when present.
  const yt2 = body.coverage.neverClustered.find((d: any) => d.id === "yt2");
  expect(yt2.title).toBe("yt2");
  expect(yt2.url).toBe("https://yt/2");
});

test("a failed collection contributes an error but the rest still load (partial, 200)", async () => {
  failCollections = new Set(["anthropic-summaries"]);
  const app = appWith(fakeDeps());
  const res = await app.request("/api/summaries/stats");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.errors).toBeDefined();
  expect(body.errors.map((e: any) => e.source)).toContain("anthropic");
  // youtube docs still counted.
  expect(body.coverage.total).toBeGreaterThan(0);
});

test("caches within the TTL (no re-fetch) and ?refresh=1 bypasses the cache read", async () => {
  const app = appWith(fakeDeps());
  await app.request("/api/summaries/stats");
  const afterFirst = fetchCalls.length;
  expect(afterFirst).toBe(4); // one fetch per collection

  await app.request("/api/summaries/stats");
  expect(fetchCalls.length).toBe(afterFirst); // served from cache

  await app.request("/api/summaries/stats?refresh=1");
  expect(fetchCalls.length).toBe(afterFirst + 4); // refresh re-fetched
});

test("a degraded (errors) payload is NOT cached — the next request re-fetches", async () => {
  failCollections = new Set(["anthropic-summaries"]);
  const app = appWith(fakeDeps());

  const first = await (await app.request("/api/summaries/stats")).json();
  expect(first.errors).toBeDefined();
  const afterFirst = fetchCalls.length;

  // Huginn recovers — a plain (non-refresh) request must not be served the
  // stale degraded payload from cache for the whole TTL.
  failCollections = new Set();
  const second = await (await app.request("/api/summaries/stats")).json();
  expect(fetchCalls.length).toBe(afterFirst + 4); // re-fetched all collections
  expect(second.errors).toBeUndefined();

  // The now-clean result IS cached.
  await app.request("/api/summaries/stats");
  expect(fetchCalls.length).toBe(afterFirst + 4);
});

test("passes ?bot= through to the coverage lookups (default jarvis)", async () => {
  const seenBots: string[] = [];
  const app = appWith(fakeDeps({ seenBots }));
  await app.request("/api/summaries/stats");
  await app.request("/api/summaries/stats?bot=melosys&refresh=1");
  expect(seenBots).toContain("jarvis");
  expect(seenBots).toContain("melosys");
});

test("degrades to a 200 with an error note when the coverage lookup throws", async () => {
  const app = appWith(fakeDeps({ throwCoverage: true }));
  const res = await app.request("/api/summaries/stats");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.months).toEqual([]);
  expect(body.coverage.total).toBe(0);
  expect(body.errors[0].source).toBe("coverage");
});
