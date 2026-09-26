/**
 * `GET /api/wiki/graph` through the wiki route group: the 400/404 ladder, the
 * no-tracker answer, the one ledger fan-out a level-3 GET buys and the none a
 * level-1 GET buys, and its place on `SIDE_EFFECTING_GETS`. Synthetic keys.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import type { ProvenanceContext } from "../../wiki/provenance-service.ts";
import { isSideEffectingRequest } from "../../auth/origin.ts";
import type { Config } from "../../config.ts";
import { renderWikiBoardPage } from "../views/wiki-board-page.ts";

const S1 = "00000000-0000-4000-8000-000000000001";
const CONFIG = { trackers: [{ id: "jira", projects: ["DEMO"], hosts: ["example.invalid"], ledgerProjects: ["DEMO"] }] };
const PAGE = `---\ntitle: DEMO-101 side\nsessions: [claude-code:${S1}]\n---\n\nBody.\n`;

const roots: string[] = [];
const calls: string[] = [];
/** The signal each ledger call was handed, in order. */
const signals: (AbortSignal | undefined)[] = [];
let app: Hono;

async function wiki(config: object | null): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "wiki-graph-route-"));
  roots.push(root);
  await writeFile(path.join(root, "side.md"), PAGE, "utf8");
  if (config) await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify(config), "utf8");
  return root;
}

const ctx: ProvenanceContext = {
  sessionLedger: {
    baseUrl: "http://ledger.test",
    urlConfigured: true,
    fetchSessions: async (ids, signal) => {
      calls.push(`sessions:${ids.join(",")}`);
      signals.push(signal);
      return { sessions: ids.map((sessionId) => ({ sessionId, title: "Økt" })) };
    },
    fetchMerges: async (ids, signal) => {
      calls.push(`merges:${ids.join(",")}`);
      signals.push(signal);
      return { merges: [{ sessionId: S1, repo: "/src/demo", prNumber: 7, url: "https://github.com/example-org/demo/pull/7" }] };
    },
    fetchHandoff: async () => ({ available: false }),
    fetchMergesForPrs: async () => ({ merges: [], unmapped: [] }),
    fetchIssueLedger: async (p) => {
      calls.push(`issue-ledger:${p}`);
      const keys = decodeURIComponent(p.slice(p.indexOf("=") + 1)).split(",");
      return {
        keys: keys.map((key) => ({ key, tracked: true, sessionCount: 2, totalCost: 3, costedSessions: 2, lastSeen: null, truncated: false })),
      };
    },
  },
  knowledgeApiUrl: "http://huginn.test",
  publicUrl: null,
  loadJiraIndex: async () => null,
  lookupIssues: async () => {
    calls.push("lookup");
    return new Map([["DEMO-101", { title: "Side", status: "In Progress" }]]);
  },
};

beforeAll(async () => {
  __setWikiRegistryForTest([
    { name: "trk", root: await wiki(CONFIG), source: "extra" },
    { name: "plain", root: await wiki(null), source: "extra" },
  ]);
  app = new Hono();
  registerWikiRoutes(app, { knowledgeApiUrl: "http://huginn.test", claudeUsageUrl: null, claudeUsagePublicUrl: null } as Config, ctx);
});
afterAll(async () => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const get = async (q: string) => {
  const res = await app.request(`/api/wiki/graph?${q}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("GET /api/wiki/graph", () => {
  test("level 3 on a page: four lanes, one sessions and one merges call", async () => {
    calls.length = 0;
    const { status, body } = await get("wiki=trk&scope=page&root=side.md&level=3");
    expect(status).toBe(200);
    expect(body.lanes).toEqual(["issue", "page", "session", "pr"]);
    const ids = (body.nodes as { id: string }[]).map((n) => n.id).sort();
    expect(ids).toEqual(["issue:jira:DEMO-101", "page:side.md", "pr:example-org/demo#7", `session:${S1}`]);
    expect(calls.sort()).toEqual([`merges:${S1}`, `sessions:${S1}`]);
  });

  test("wiki scope defaults to level 1 and calls no ledger", async () => {
    calls.length = 0;
    const { status, body } = await get("wiki=trk&scope=wiki");
    expect(status).toBe(200);
    expect(body.level).toBe(1);
    expect(body.lanes).toEqual(["issue", "page"]);
    expect(calls).toEqual([]);
  });

  test("400 for a bad query, 404 for an unknown wiki, a wiki with no tracker and an unknown root", async () => {
    expect((await get("wiki=trk&scope=galaxy&root=x")).status).toBe(400);
    expect((await get("wiki=trk&scope=page")).status).toBe(400);
    expect((await get("wiki=trk&scope=page&root=side.md&depth=9")).status).toBe(400);
    expect((await get("wiki=nope&scope=wiki")).status).toBe(404);
    const plain = await get("wiki=plain&scope=page&root=side.md");
    expect(plain).toEqual({ status: 404, body: { error: "this wiki names no tracker" } });
    expect((await get("wiki=trk&scope=page&root=missing.md")).status).toBe(404);
  });

  test("is a side-effecting GET: a cross-site request is refused before it fans out", () => {
    expect(isSideEffectingRequest("GET", "/api/wiki/graph")).toBe(true);
    expect(isSideEffectingRequest("HEAD", "/api/wiki/graph")).toBe(true);
  });

  test("S8: a 404 echoes the root through the house bound, never the caller's whole input", async () => {
    const long = "x".repeat(5000);
    for (const q of [`scope=page&root=${long}.md`, `scope=series&root=${long}`]) {
      const { status, body } = await get(`wiki=trk&${q}`);
      expect(status).toBe(404);
      expect(String(body.error).length).toBeLessThan(200);
      expect(String(body.error)).toContain("xxxx");
    }
  });

  test("S9: an issue root that is not tracker:KEY shaped is a 400 naming root", async () => {
    for (const root of ["DEMO-101", "JIRA%3ADEMO-101", "jira%3ADEMO-101%3Ax"]) {
      const { status, body } = await get(`wiki=trk&scope=issue&root=${root}`);
      expect(status, root).toBe(400);
      expect(String(body.error)).toContain("root");
    }
    expect((await get("wiki=trk&scope=issue&root=jira%3ADEMO-999")).status).toBe(404);
  });

  test("S10: a client that goes away aborts the ledger fan-out", async () => {
    signals.length = 0;
    const gone = new AbortController();
    gone.abort();
    await app.request(new Request("http://x/api/wiki/graph?wiki=trk&scope=page&root=side.md&level=3", { signal: gone.signal }));
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) expect(s?.aborted).toBe(true);
  });

  test("the board's opt-ins: one keys-ledger call, one lookup, and the fields on the issue node", async () => {
    calls.length = 0;
    const { status, body } = await get("wiki=trk&scope=wiki&level=1&depth=0&keyless=1&fields=issue&ledger=keys");
    expect(status).toBe(200);
    expect(calls.sort()).toEqual(["issue-ledger:/api/jira/keys?keys=DEMO-101", "lookup"]);
    const [n] = body.nodes as Record<string, unknown>[];
    expect(n).toMatchObject({
      key: "DEMO-101",
      title: "Side",
      category: "active",
      known: true,
      stampedCount: 0,
      keyLedger: { state: "priced", sessions: 2, totalCost: 3 },
    });
    expect(body.issueLookup).toEqual({ available: true });
    expect(body.keysLedger).toEqual({ configured: true, calls: 1, answered: 1, reachable: true, timedOut: false });
    expect(body.keylessPages).toEqual([]);
  });

  test("S1: a repeated or padded opt-in is a 400 naming it, and calls nothing", async () => {
    calls.length = 0;
    expect(await get("wiki=trk&scope=wiki&keyless=1&keyless=2")).toEqual({ status: 400, body: { error: "keyless must be given once" } });
    expect(await get("wiki=trk&scope=wiki&fields=%20issue%20")).toEqual({ status: 400, body: { error: "fields must be issue" } });
    expect(calls).toEqual([]);
  });

  test("the opt-ins are refused off wiki scope, and without them a level-1 answer carries none of their fields", async () => {
    const off = await get("wiki=trk&scope=page&root=side.md&fields=issue");
    expect(off).toEqual({ status: 400, body: { error: "fields is only read at scope=wiki" } });
    calls.length = 0;
    const { body } = await get("wiki=trk&scope=wiki");
    expect(calls).toEqual([]);
    for (const k of ["keylessPages", "issueLookup", "keysLedger"]) expect(body[k]).toBeUndefined();
    expect((body.nodes as Record<string, unknown>[])[0]!.keyLedger).toBeUndefined();
  });
});

describe("GET /wiki/issues", () => {
  test("a tracker wiki renders the board shell; its client asks the graph route once", async () => {
    const res = await app.request("/wiki/issues?wiki=trk");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="boardTableWrap"');
    expect(html).toContain("Jira board");
    expect(html).toContain('window.__WIKI_BOARD__ = {"wiki":"trk"}');
  });

  test("a wiki with no trackers block, or an unknown wiki, answers 404 with no board", async () => {
    for (const w of ["plain", "nope"]) {
      const res = await app.request(`/wiki/issues?wiki=${w}`);
      expect(res.status, w).toBe(404);
      const html = await res.text();
      expect(html).toContain('id="boardRefusal"');
      expect(html).not.toContain("__WIKI_BOARD__");
    }
  });

  test("C15: a refusal drops the board's intro; the default wiki's reader link carries no empty wiki param", async () => {
    const html = await (await app.request("/wiki/issues?wiki=plain")).text();
    expect(html).not.toContain("One row per key");
    const def = await renderWikiBoardPage({ wiki: "", label: "Jira" });
    expect(def).toContain('href="/wiki">← Wiki reader');
  });

  test("fans out to nothing, so it is not a side-effecting GET", () => {
    expect(isSideEffectingRequest("GET", "/wiki/issues")).toBe(false);
  });
});

describe("GET /api/wiki/graph: fix round 2", () => {
  test("a repeated fields or ledger is a 400 naming it", async () => {
    calls.length = 0;
    expect(await get("wiki=trk&scope=wiki&fields=issue&fields=issue")).toEqual({ status: 400, body: { error: "fields must be given once" } });
    expect(await get("wiki=trk&scope=wiki&ledger=keys&ledger=keys")).toEqual({ status: 400, body: { error: "ledger must be given once" } });
    expect(calls).toEqual([]);
  });

  test("the route hands the board joins its signal and deadline: a hung lookup and ledger answer within the budget, timedOut", async () => {
    const hung = () => new Promise<never>(() => {});
    const slow: ProvenanceContext = {
      ...ctx,
      budgetMs: 30,
      sessionLedger: { ...ctx.sessionLedger, fetchIssueLedger: hung },
      lookupIssues: hung,
    };
    const app2 = new Hono();
    registerWikiRoutes(app2, { knowledgeApiUrl: "http://huginn.test", claudeUsageUrl: null, claudeUsagePublicUrl: null } as Config, slow);
    const res = await app2.request("/api/wiki/graph?wiki=trk&scope=wiki&depth=0&fields=issue&ledger=keys");
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.issueLookup).toEqual({ available: false });
    expect(body.keysLedger).toEqual({ configured: true, calls: 1, answered: 0, reachable: false, timedOut: true });
  }, 2_000);
});
