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
import { runDiscovery } from "../../youtube/discover-run.ts";
import type { YouTubeHit } from "../../youtube/discover.ts";
import type { CapturedDoc } from "../../youtube/discover-deps.ts";
import type {
  DiscoverHitInput,
  DiscoverHitState,
  DiscoverRunInput,
  DiscoverShelf,
  DiscoverVideoDetails,
} from "../../db/youtube-discover.ts";

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
let captured: CapturedDoc[];
let profile: string | null;
let prompts: { queries: string[]; rank: string[] };
let clock: number;
/** The in-memory store: saved runs, per-video state and details. */
let saved: { run: DiscoverRunInput; hits: DiscoverHitInput[] }[];
let states: Map<string, DiscoverHitState>;
let detailsCache: Map<string, DiscoverVideoDetails | null>;
let probes: string[];
let probeAnswer: (id: string, signal?: AbortSignal) => Promise<DiscoverVideoDetails | null | "unavailable">;
let saveFails: boolean;

const DETAILS: DiscoverVideoDetails = {
  description: "Invented description",
  chapters: [{ start: 0, title: "Intro" }],
  likeCount: 12,
  viewCount: 1000,
  uploadDate: "20260301",
  channelFollowerCount: 500,
  tags: ["evals"],
};

function store(): SummariesDiscoverDeps["store"] {
  return {
    saveRun: async (run, hits) => {
      if (saveFails) throw new Error("db down");
      saved.push({ run, hits: [...hits] });
      for (const h of hits) {
        if (!states.has(h.videoId)) states.set(h.videoId, "new");
        if (!detailsCache.has(h.videoId)) detailsCache.set(h.videoId, null);
      }
      return `00000000-0000-4000-8000-${String(saved.length).padStart(12, "0")}`;
    },
    knownIds: async () => new Set([...states].filter(([, st]) => st === "dismissed" || st === "queued").map(([id]) => id)),
    setState: async (id, st) => (states.has(id) ? (states.set(id, st), 1) : 0),
    getDetails: async (id) => (detailsCache.has(id) ? detailsCache.get(id)! : undefined),
    saveDetails: async (id, d) => void detailsCache.set(id, d),
    listShelves: async () => [] as DiscoverShelf[],
  };
}

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
    listCaptured: async () => captured,
    profile: async () => profile,
    tracer: () => null,
    now: () => clock,
    store: store(),
    probeDetails: async (id, signal) => {
      probes.push(id);
      return probeAnswer(id, signal);
    },
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
  captured = [];
  knownUrls = [`https://www.youtube.com/watch?v=${ID(1)}`, "https://youtu.be/" + ID(4), "not a url", "https://vimeo.com/1"];
  listings = 0;
  profile = null;
  prompts = { queries: [], rank: [] };
  clock = 1_000_000;
  saved = [];
  states = new Map();
  detailsCache = new Map();
  probes = [];
  probeAnswer = async () => DETAILS;
  saveFails = false;
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
  test("a score under the gate's floor is not shown, even when the model returns it", async () => {
    rankAnswer = JSON.stringify([
      { n: 1, score: 0.05, why: "off-contract low" },
      { n: 2, score: 0.5, why: "borderline" },
    ]);
    const res = await post(app(), { source: "youtube", docId: DOC });
    const body = (await res.json()) as { results: { videoId: string }[] };
    expect(body.results.map((r) => r.videoId)).toEqual([ID(3)]);
  });
  test("the floor is inclusive: a score of exactly 0.4 is shown, 0.39 is not", async () => {
    rankAnswer = JSON.stringify([
      { n: 1, score: 0.39, why: "just under" },
      { n: 2, score: 0.4, why: "at the floor" },
    ]);
    const res = await post(app(), { source: "youtube", docId: DOC });
    const body = (await res.json()) as { results: { videoId: string; score: number }[] };
    expect(body.results.map((r) => [r.videoId, r.score])).toEqual([[ID(3), 0.4]]);
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
    expect(await res.json()).toEqual({
      queries: expect.any(Array),
      results: [],
      searched: 5,
      known: 5,
      runId: expect.any(String),
      shelfUrl: expect.stringMatching(/^\/summaries\/discover#run-/),
    });
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
  test("the default profile dep never reads a profile on an authenticating instance", async () => {
    const loads: string[] = [];
    const loadProfile = async (name: string | undefined) => (loads.push(String(name)), "Invented profile");
    __setAuthPolicyForTest({ authenticating: true, mode: "local" });
    try {
      expect(await defaultSummariesDiscoverDeps(config, { loadProfile }).profile(bot)).toBeNull();
      expect(loads).toEqual([]);
    } finally {
      __setAuthPolicyForTest(null);
    }
  });
  test("the default profile dep reads the bot's profile under MUNINN_AUTH=off", async () => {
    const loads: string[] = [];
    const loadProfile = async (name: string | undefined) => (loads.push(String(name)), "Invented profile");
    __setAuthPolicyForTest({ authenticating: false, mode: "off" });
    try {
      const other = { name: "inventedbot", dir: "/tmp/inventedbot", connector: "claude-sdk" } as never;
      expect(await defaultSummariesDiscoverDeps(config, { loadProfile }).profile(other)).toBe("Invented profile");
      expect(loads).toEqual(["inventedbot"]);
    } finally {
      __setAuthPolicyForTest(null);
    }
  });
});

describe("stored runs (PR 2)", () => {
  test("a run is saved as a shelf: seed fields, origin reader, the shown results in order; the answer links it", async () => {
    const res = await post(app(), { source: "youtube", docId: DOC });
    const body = (await res.json()) as { runId: string; shelfUrl: string };
    expect(saved).toHaveLength(1);
    const { run, hits } = saved[0]!;
    expect(run).toMatchObject({
      seedSource: "youtube",
      seedDocId: DOC,
      seedTitle: "Invented seed talk",
      seedVideoId: SEED,
      seedCategory: "ai/agents",
      seedDate: "2026-03-22",
      searched: 5,
      known: 3,
      origin: "reader",
      botName: "summarizer",
    });
    expect(run.queries.map((q) => q.query)).toEqual(["agent evals", "eval harness talk"]);
    expect(hits.map((h) => [h.videoId, h.score])).toEqual([
      [ID(3), 0.9],
      [ID(2), 0.6],
    ]);
    expect(body.shelfUrl).toBe(`/summaries/discover#run-${body.runId}`);
  });
  test("origin page is accepted; any other origin is 400 before a model call", async () => {
    expect((await post(app(), { source: "youtube", docId: DOC, origin: "page" })).status).toBe(200);
    expect(saved[0]!.run.origin).toBe("page");
    const bad = await post(app(), { source: "youtube", docId: DOC, origin: "watcher" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("bad_origin");
    expect(prompts.queries).toHaveLength(1);
  });
  test("a failed save still answers the results, with no shelf", async () => {
    saveFails = true;
    const res = await post(app(), { source: "youtube", docId: DOC });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; runId: unknown; shelfUrl: unknown };
    expect(body.results).toHaveLength(2);
    expect(body.runId).toBeNull();
    expect(body.shelfUrl).toBeNull();
  });
  test("dismissed and queued videos join the known set; later and new ones do not", async () => {
    states.set(ID(2), "dismissed");
    states.set(ID(3), "later");
    rankAnswer = JSON.stringify([{ n: 1, score: 0.9, why: "x" }]);
    let body = (await (await post(app(), { source: "youtube", docId: DOC })).json()) as { results: { videoId: string }[]; known: number };
    expect(body.known).toBe(4);
    expect(body.results.map((r) => r.videoId)).toEqual([ID(3)]);
    states.set(ID(3), "queued");
    body = (await (await post(app(), { source: "youtube", docId: DOC })).json()) as { results: { videoId: string }[]; known: number };
    expect(body.known).toBe(5);
    expect(body.results).toEqual([]);
  });
  test("a failed dismissed/queued read degrades to the huginn listing alone", async () => {
    const d = deps();
    d.store = { ...d.store, knownIds: async () => { throw new Error("db down"); } };
    const res = await post(app(d), { source: "youtube", docId: DOC });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { known: number }).known).toBe(3);
  });
});

const postTo = (a: Hono, path: string, body: unknown, ct = "application/json") =>
  a.request(path, { method: "POST", headers: { "content-type": ct }, body: JSON.stringify(body) });

describe("POST /api/summaries/discover/state", () => {
  test("415, a bad id and a bad state are refused", async () => {
    const a = app();
    expect((await postTo(a, "/api/summaries/discover/state", { videoId: ID(1), state: "later" }, "text/plain")).status).toBe(415);
    const badId = await postTo(a, "/api/summaries/discover/state", { videoId: "../x", state: "later" });
    expect(((await badId.json()) as { code: string }).code).toBe("bad_video_id");
    const badState = await postTo(a, "/api/summaries/discover/state", { videoId: ID(1), state: "summarized" });
    expect(badState.status).toBe(400);
    expect(((await badState.json()) as { code: string }).code).toBe("bad_state");
  });
  test("404 for a video no shelf has; 200 sets the state", async () => {
    const a = app();
    expect((await postTo(a, "/api/summaries/discover/state", { videoId: ID(1), state: "later" })).status).toBe(404);
    states.set(ID(1), "new");
    const res = await postTo(a, "/api/summaries/discover/state", { videoId: ID(1), state: "dismissed" });
    expect(await res.json()).toEqual({ videoId: ID(1), state: "dismissed" });
    expect(states.get(ID(1))).toBe("dismissed");
  });
});

describe("POST /api/summaries/discover/details", () => {
  test("404 and no probe for a video no shelf has", async () => {
    const res = await postTo(app(), "/api/summaries/discover/details", { videoId: ID(1) });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("unknown_video");
    expect(probes).toEqual([]);
  });
  test("probes once, caches, and answers from the cache afterwards", async () => {
    detailsCache.set(ID(1), null);
    const a = app();
    let res = await postTo(a, "/api/summaries/discover/details", { videoId: ID(1) });
    expect(await res.json()).toEqual({ videoId: ID(1), details: DETAILS, cached: false });
    res = await postTo(a, "/api/summaries/discover/details", { videoId: ID(1) });
    expect(await res.json()).toEqual({ videoId: ID(1), details: DETAILS, cached: true });
    expect(probes).toEqual([ID(1)]);
  });
  test("two concurrent opens of one video share one probe", async () => {
    detailsCache.set(ID(1), null);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    probeAnswer = async () => (await held, DETAILS);
    const a = app();
    const p1 = postTo(a, "/api/summaries/discover/details", { videoId: ID(1) });
    const p2 = postTo(a, "/api/summaries/discover/details", { videoId: ID(1) });
    await Bun.sleep(5);
    release();
    expect((await p1).status).toBe(200);
    expect((await p2).status).toBe(200);
    expect(probes).toEqual([ID(1)]);
  });
  test("a failed probe is 502 and caches nothing", async () => {
    detailsCache.set(ID(1), null);
    probeAnswer = async () => null;
    const res = await postTo(app(), "/api/summaries/discover/details", { videoId: ID(1) });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("probe_failed");
    expect(detailsCache.get(ID(1))).toBeNull();
  });
});

describe("GET /summaries/discover", () => {
  test("renders the stored shelves into the page's JSON, with every < escaped", async () => {
    const shelf: DiscoverShelf = {
      runId: "00000000-0000-4000-8000-000000000001",
      seedSource: "youtube",
      seedDocId: DOC,
      seedTitle: "Invented </script><b>seed</b>",
      seedVideoId: SEED,
      seedCategory: "ai/agents",
      seedDate: "2026-03-22",
      queries: [{ query: "agent evals", why: "same" }],
      searched: 5,
      known: 1,
      origin: "reader",
      createdAt: 0,
      hits: [],
    };
    const d = deps();
    d.store = { ...d.store, listShelves: async () => [shelf] };
    const res = await app(d).request("/summaries/discover");
    expect(res.status).toBe(200);
    const html = await res.text();
    const json = /<script type="application\/json" id="dscData">([^<]*)<\/script>/.exec(html)?.[1];
    expect(json).toBeDefined();
    expect(JSON.parse(json!).shelves[0].seedTitle).toBe("Invented </script><b>seed</b>");
    expect(html).not.toContain("</script><b>seed");
  });
});

describe("runDiscovery failure causes", () => {
  test("a failed read, queries call and rank call carry the error text for the caller's log", async () => {
    const base = {
      readRaw: async () => RAW,
      queriesCall: async () => JSON.stringify([{ query: "agent evals", why: "" }]),
      rankCall: async () => "[]",
      search: async () => [hit(ID(1))],
      knownIds: async () => new Set<string>(),
      profile: async () => null,
    };
    const target = { collection: "youtube-summaries", docId: DOC };
    const read = await runDiscovery({ ...base, readRaw: async () => { throw new Error("huginn 503 invented"); } }, bot, null, target);
    expect(read).toMatchObject({ ok: false, code: "upstream", cause: "huginn 503 invented" });
    const q = await runDiscovery({ ...base, queriesCall: async () => { throw new Error("quota invented"); } }, bot, null, target);
    expect(q).toMatchObject({ ok: false, code: "model_failed", cause: "queries call: quota invented" });
    const r = await runDiscovery({ ...base, rankCall: async () => { throw new Error("timeout invented"); } }, bot, null, target);
    expect(r).toMatchObject({ ok: false, code: "model_failed", cause: "rank call: timeout invented" });
  });
});

describe("details: unavailable and abandoned (fix round 1)", () => {
  test("an unavailable video answers 410 and is not probed again", async () => {
    detailsCache.set(ID(1), null);
    probeAnswer = async () => "unavailable";
    const a = app();
    let res = await postTo(a, "/api/summaries/discover/details", { videoId: ID(1) });
    expect(res.status).toBe(410);
    expect(((await res.json()) as { code: string }).code).toBe("video_unavailable");
    res = await postTo(a, "/api/summaries/discover/details", { videoId: ID(1) });
    expect(res.status).toBe(410);
    expect(probes).toEqual([ID(1)]);
  });
  test("the probe is told when its only caller went away", async () => {
    detailsCache.set(ID(1), null);
    let seen: AbortSignal | undefined;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    probeAnswer = async (_id, signal) => {
      seen = signal;
      await held;
      return null;
    };
    const ctl = new AbortController();
    const pending = app().request("/api/summaries/discover/details", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoId: ID(1) }),
      signal: ctl.signal,
    });
    await Bun.sleep(5);
    expect(seen?.aborted).toBe(false);
    ctl.abort();
    await Bun.sleep(5);
    expect(seen?.aborted).toBe(true);
    release();
    await Promise.resolve(pending).catch(() => undefined);
  });
});

describe("details: a request after the last waiter left (fix round 2)", () => {
  test("joins a fresh probe, not the aborted one", async () => {
    detailsCache.set(ID(1), null);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    probeAnswer = async (_id, signal) => {
      await held;
      return signal?.aborted ? null : DETAILS;
    };
    const a = app();
    const ctl = new AbortController();
    const first = a.request("/api/summaries/discover/details", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoId: ID(1) }),
      signal: ctl.signal,
    });
    await Bun.sleep(5);
    ctl.abort();
    await Bun.sleep(5);
    const second = postTo(a, "/api/summaries/discover/details", { videoId: ID(1) });
    await Bun.sleep(5);
    release();
    await Promise.resolve(first).catch(() => undefined);
    const res = await second;
    expect(res.status).toBe(200);
    expect(probes).toEqual([ID(1), ID(1)]);
  });
});

describe("details: the aborted probe settling later (fix round 2)", () => {
  test("does not drop the fresh probe's entry: a third request joins the fresh probe", async () => {
    detailsCache.set(ID(1), null);
    const releases: (() => void)[] = [];
    probeAnswer = async (_id, signal) => {
      await new Promise<void>((r) => releases.push(r));
      return signal?.aborted ? null : DETAILS;
    };
    const a = app();
    const ctl = new AbortController();
    const first = a.request("/api/summaries/discover/details", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoId: ID(1) }),
      signal: ctl.signal,
    });
    await Bun.sleep(5);
    ctl.abort();
    const second = postTo(a, "/api/summaries/discover/details", { videoId: ID(1) });
    await Bun.sleep(5);
    releases[0]!(); // the aborted probe settles first
    await Promise.resolve(first).catch(() => undefined);
    await Bun.sleep(5);
    const third = postTo(a, "/api/summaries/discover/details", { videoId: ID(1) });
    await Bun.sleep(5);
    expect(probes).toEqual([ID(1), ID(1)]);
    releases[1]!();
    expect((await second).status).toBe(200);
    expect((await third).status).toBe(200);
  });
});

describe("GET /api/summaries/discover/seeds (PR 3)", () => {
  test("lists the summaries newest first with their categories", async () => {
    captured = [
      { id: "ai/agents/Old talk.md", url: null, date: "2026-11-01" },
      { id: "ai/agents/New talk.md", url: null, date: "2026-11-12" },
      { id: "music/Loose.md", url: null, date: null },
      { id: "Root talk.md", url: null, date: "2026-11-10" },
    ];
    const res = await app().request("/api/summaries/discover/seeds");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { docs: { id: string; title: string; category: string | null }[]; categories: unknown; now: number };
    expect(body.docs.map((d) => d.id)).toEqual(["ai/agents/New talk.md", "Root talk.md", "ai/agents/Old talk.md", "music/Loose.md"]);
    expect(body.docs[0]).toMatchObject({ title: "New talk", category: "ai/agents", date: "2026-11-12" });
    expect(body.docs[1]!.category).toBeNull();
    expect(body.categories).toEqual([
      { category: "ai/agents", count: 2 },
      { category: "music", count: 1 },
    ]);
    expect(body.now).toBe(clock);
  });

  test("a failed listing is 502", async () => {
    const res = await app(
      deps({
        listCaptured: async () => {
          throw new Error("huginn down");
        },
      }),
    ).request("/api/summaries/discover/seeds");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("upstream");
  });
});

describe("GET /api/summaries/discover/shelves (PR 3)", () => {
  test("answers the stored shelves", async () => {
    const shelf = { runId: "r1" } as unknown as DiscoverShelf;
    const d = deps();
    d.store.listShelves = async () => [shelf];
    const res = await app(d).request("/api/summaries/discover/shelves");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ shelves: [shelf] });
  });

  test("a failed read is 500", async () => {
    const d = deps();
    d.store.listShelves = async () => {
      throw new Error("db down");
    };
    const res = await app(d).request("/api/summaries/discover/shelves");
    expect(res.status).toBe(500);
  });
});
