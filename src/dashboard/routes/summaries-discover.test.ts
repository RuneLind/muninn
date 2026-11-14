/**
 * `POST /api/summaries/discover` — every seam injected: the raw read is an
 * in-memory map, the two model calls are canned answers, the search is a map
 * of invented hits per query, the known-video listing a list of urls.
 * Invented ids and titles only (public repo).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  defaultSummariesDiscoverDeps,
  registerSummariesDiscoverRoutes,
  KNOWN_IDS_TTL_MS,
  type SummariesDiscoverDeps,
} from "./summaries-discover.ts";
import { __setAuthPolicyForTest } from "../../auth/policy.ts";
import type { YouTubeHit } from "../../youtube/discover.ts";

const config = { knowledgeApiUrl: "http://huginn.invalid" } as never;
const bot = { name: "summarizer", dir: "/tmp/summarizer", connector: "claude-sdk" } as never;

const SEED = "seedseed001";
const DOC = "ai/agents/Invented seed talk.md";
const RAW = `---\ndate: "2026-03-22"\nurl: "https://www.youtube.com/watch?v=${SEED}"\ncategory: "ai/agents"\n---\n\nAn invented summary about agent evals.\n\n## Transcript\n\n### [00:00:00]\n\nSecret transcript words.\n`;

const hit = (id: string, title = `Video ${id}`): YouTubeHit => ({
  videoId: id,
  title,
  channel: "Invented",
  durationSec: 600,
  viewCount: 1000,
  url: `https://www.youtube.com/watch?v=${id}`,
});
const ID = (n: number) => `vid${String(n).padStart(8, "0")}`;

let files: Map<string, string>;
let queriesAnswer: string | (() => Promise<string>);
let rankAnswer: string | ((prompt: string) => Promise<string>);
let searchHits: Record<string, YouTubeHit[] | null>;
let searches: string[];
let knownUrls: string[];
let listings: number;
let profile: string | null;
let prompts: { queries: string[]; rank: string[] };
let clock: number;

function deps(over: Partial<SummariesDiscoverDeps> = {}): SummariesDiscoverDeps {
  return {
    readRaw: async (_c, docId) => files.get(docId) ?? null,
    bots: () => [bot],
    queriesCall: async (p) => {
      prompts.queries.push(p);
      return typeof queriesAnswer === "string" ? queriesAnswer : queriesAnswer();
    },
    rankCall: async (p) => {
      prompts.rank.push(p);
      return typeof rankAnswer === "string" ? rankAnswer : rankAnswer(p);
    },
    search: async (q, n) => {
      searches.push(`${q}|${n}`);
      return q in searchHits ? searchHits[q]! : [];
    },
    listKnownUrls: async () => {
      listings++;
      return knownUrls;
    },
    profile: async () => profile,
    tracer: () => null,
    now: () => clock,
    ...over,
  };
}

function app(d: SummariesDiscoverDeps = deps()): Hono {
  const a = new Hono();
  registerSummariesDiscoverRoutes(a, config, d);
  return a;
}

const post = (a: Hono, body: unknown, ct = "application/json") =>
  a.request("/api/summaries/discover", { method: "POST", headers: { "content-type": ct }, body: JSON.stringify(body) });

beforeEach(() => {
  files = new Map([[DOC, RAW]]);
  queriesAnswer = JSON.stringify([
    { query: "agent evals", why: "same topic" },
    { query: "eval harness talk", why: "deeper" },
  ]);
  // n is 1-based over the fresh list.
  rankAnswer = JSON.stringify([
    { n: 1, score: 0.6, why: "ok" },
    { n: 2, score: 0.9, why: "best" },
  ]);
  searchHits = {
    "agent evals": [hit(SEED), hit(ID(1)), hit(ID(2))],
    "eval harness talk": [hit(ID(2)), hit(ID(3)), hit(ID(4))],
  };
  searches = [];
  knownUrls = [`https://www.youtube.com/watch?v=${ID(1)}`, "https://youtu.be/" + ID(4), "not a url", "https://vimeo.com/1"];
  listings = 0;
  profile = null;
  prompts = { queries: [], rank: [] };
  clock = 1_000_000;
});

describe("refusals", () => {
  test("415 without application/json", async () => {
    const res = await post(app(), { source: "youtube", docId: DOC }, "text/plain");
    expect(res.status).toBe(415);
  });
  test("400 for an unknown source, a non-YouTube source, a bad doc id", async () => {
    const a = app();
    expect((await post(a, { source: "nope", docId: DOC })).status).toBe(400);
    const vimeo = await post(a, { source: "vimeo", docId: DOC });
    expect(vimeo.status).toBe(400);
    expect(((await vimeo.json()) as { code: string }).code).toBe("not_youtube");
    const bad = await post(a, { source: "youtube", docId: "../etc/passwd" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("bad_doc_id");
    expect(prompts.queries).toHaveLength(0);
  });
  test("404 when the document is missing; 502 when the read fails", async () => {
    expect((await post(app(), { source: "youtube", docId: "ai/x/Gone.md" })).status).toBe(404);
    const failing = app(deps({ readRaw: async () => { throw new Error("boom"); } }));
    const res = await post(failing, { source: "youtube", docId: DOC });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("upstream");
  });
  test("409 while the same document is being discovered; free again afterwards", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    queriesAnswer = async () => {
      await held;
      return JSON.stringify([{ query: "agent evals", why: "" }]);
    };
    const a = app();
    const first = post(a, { source: "youtube", docId: DOC });
    await Bun.sleep(5);
    const second = await post(a, { source: "youtube", docId: DOC });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("running");
    release();
    expect((await first).status).toBe(200);
    queriesAnswer = JSON.stringify([{ query: "agent evals", why: "" }]);
    expect((await post(a, { source: "youtube", docId: DOC })).status).toBe(200);
  });
});

describe("model failures", () => {
  test("502 model_failed when the queries call throws", async () => {
    queriesAnswer = async () => { throw new Error("down"); };
    const res = await post(app(), { source: "youtube", docId: DOC });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: expect.any(String), code: "model_failed" });
    expect(searches).toHaveLength(0);
  });
  test("502 model_unparseable for no array and for an array with no usable query", async () => {
    for (const answer of ["no idea", '[{"query": "   "}]']) {
      queriesAnswer = answer;
      const res = await post(app(), { source: "youtube", docId: DOC });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { code: string }).code).toBe("model_unparseable");
    }
  });
  test("502 for a failed and an unparseable rank call", async () => {
    rankAnswer = async () => { throw new Error("down"); };
    let res = await post(app(), { source: "youtube", docId: DOC });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("model_failed");
    rankAnswer = "prose only";
    res = await post(app(), { source: "youtube", docId: DOC });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("model_unparseable");
  });
});

describe("search and dedup", () => {
  test("503 search_failed when every search failed", async () => {
    searchHits = { "agent evals": null, "eval harness talk": null };
    const res = await post(app(), { source: "youtube", docId: DOC });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("search_failed");
    expect(prompts.rank).toHaveLength(0);
  });
  test("one failed search of two still answers from the other", async () => {
    searchHits["agent evals"] = null;
    rankAnswer = JSON.stringify([{ n: 1, score: 0.8, why: "x" }]);
    const res = await post(app(), { source: "youtube", docId: DOC });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { videoId: string }[]; searched: number; known: number };
    // ID(2), ID(3) fresh, ID(4) known.
    expect(body.searched).toBe(3);
    expect(body.known).toBe(1);
    expect(body.results.map((r) => r.videoId)).toEqual([ID(2)]);
  });
  test("drops the seed and every known id, unions by id, ranks by score, carries the first query", async () => {
    const res = await post(app(), { source: "youtube", docId: DOC });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      queries: { query: string; why: string }[];
      results: { videoId: string; score: number; why: string; query: string; url: string }[];
      searched: number;
      known: number;
    };
    expect(searches).toEqual(["agent evals|10", "eval harness talk|10"]);
    expect(body.queries).toEqual([
      { query: "agent evals", why: "same topic" },
      { query: "eval harness talk", why: "deeper" },
    ]);
    // Union: SEED, 1, 2, 3, 4 → seed + 1 + 4 dropped; fresh = [2, 3].
    expect(body.searched).toBe(5);
    expect(body.known).toBe(3);
    expect(body.results.map((r) => [r.videoId, r.score, r.query])).toEqual([
      [ID(3), 0.9, "eval harness talk"],
      [ID(2), 0.6, "agent evals"],
    ]);
    expect(body.results[0]!.url).toBe(`https://www.youtube.com/watch?v=${ID(3)}`);
    // The rank prompt lists only fresh videos, numbered from 1.
    expect(prompts.rank[0]).toContain(`1. Video ${ID(2)}`);
    expect(prompts.rank[0]).toContain(`2. Video ${ID(3)}`);
    expect(prompts.rank[0]).not.toContain(`Video ${SEED}`);
    expect(prompts.rank[0]).not.toContain(`Video ${ID(1)}`);
  });
  test("the queries prompt reads the summary, never the transcript", async () => {
    await post(app(), { source: "youtube", docId: DOC });
    expect(prompts.queries[0]).toContain("Title: Invented seed talk");
    expect(prompts.queries[0]).toContain("agent evals");
    expect(prompts.queries[0]).not.toContain("Secret transcript words");
  });
  test("nothing new: no rank call, empty results", async () => {
    knownUrls.push(`https://www.youtube.com/watch?v=${ID(2)}`, `https://www.youtube.com/watch?v=${ID(3)}`);
    const res = await post(app(), { source: "youtube", docId: DOC });
    expect(await res.json()).toEqual({ queries: expect.any(Array), results: [], searched: 5, known: 5 });
    expect(prompts.rank).toHaveLength(0);
  });
  test("omitted and out-of-range gate items are not shown; at most 8", async () => {
    searchHits = { "agent evals": Array.from({ length: 10 }, (_, i) => hit(ID(10 + i))), "eval harness talk": [] };
    knownUrls = [];
    rankAnswer = JSON.stringify([
      ...Array.from({ length: 9 }, (_, i) => ({ n: i + 1, score: 0.5 + i / 100, why: `w${i}` })),
      { n: 99, score: 1, why: "out of range" },
    ]);
    const body = (await (await post(app(), { source: "youtube", docId: DOC })).json()) as { results: { videoId: string }[] };
    expect(body.results).toHaveLength(8);
    expect(body.results[0]!.videoId).toBe(ID(18));
    expect(body.results.map((r) => r.videoId)).not.toContain(ID(19));
    expect(body.results.map((r) => r.videoId)).not.toContain(ID(10));
  });
  test("the known set is cached for the TTL and re-read after it; a failed listing degrades and is not cached", async () => {
    const a = app();
    await post(a, { source: "youtube", docId: DOC });
    await post(a, { source: "youtube", docId: DOC });
    expect(listings).toBe(1);
    clock += KNOWN_IDS_TTL_MS + 1;
    await post(a, { source: "youtube", docId: DOC });
    expect(listings).toBe(2);

    let calls = 0;
    const b = app(deps({ listKnownUrls: async () => { calls++; throw new Error("huginn down"); } }));
    const res = await post(b, { source: "youtube", docId: DOC });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { known: number }).known).toBe(1); // the seed alone
    await post(b, { source: "youtube", docId: DOC });
    expect(calls).toBe(2);
  });
  test("concurrent discoveries of different documents share one listing", async () => {
    files.set("ai/agents/Other.md", RAW);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    const a = app(deps({ listKnownUrls: async () => { calls++; await held; return knownUrls; } }));
    const p1 = post(a, { source: "youtube", docId: DOC });
    const p2 = post(a, { source: "youtube", docId: "ai/agents/Other.md" });
    await Bun.sleep(10);
    release();
    expect((await p1).status).toBe(200);
    expect((await p2).status).toBe(200);
    expect(calls).toBe(1);
  });
});

describe("interest profile", () => {
  test("wraps the rank prompt when the dep returns one, and not otherwise", async () => {
    profile = "Invented interest: eval harnesses";
    await post(app(), { source: "youtube", docId: DOC });
    expect(prompts.rank[0]).toContain("Invented interest: eval harnesses");
    profile = null;
    await post(app(), { source: "youtube", docId: DOC });
    expect(prompts.rank[1]).not.toContain("current interests");
  });
  test("the default profile dep gives none on an authenticating instance (no DB read)", async () => {
    __setAuthPolicyForTest({ authenticating: true, mode: "local" });
    try {
      expect(await defaultSummariesDiscoverDeps(config).profile(bot)).toBeNull();
    } finally {
      __setAuthPolicyForTest(null);
    }
  });
});
