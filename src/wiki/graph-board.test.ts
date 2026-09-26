/**
 * The issue board's half of `GET /api/wiki/graph`: the three `scope=wiki`
 * opt-ins' parsing, the index-local aggregates and keyless pages, the lookup
 * join, and the many-key ledger join (batching, a 404, a malformed answer,
 * `tracked: false`, the project bound, the deadline). `parseJiraKeysLedger`'s
 * own tests live in `trackers/jira.test.ts`. Synthetic keys (`DEMO`),
 * host (`example.invalid`) and repo (`example-org/demo-repo`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetWikiCacheForTest, getWikiIndex, type WikiIndex } from "./store.ts";
import { buildGraph, type GraphLedgerPort } from "./graph.ts";
import { applyBoardJoins, joinIssueFields, joinKeysLedger, ledgerKeyBatches } from "./graph-board.ts";
import { GRAPH_NODES_MAX, parseGraphQuery, type GraphIssueNode, type GraphPageNode, type GraphPayload, type GraphQuery } from "./graph-types.ts";
import type { ProvenanceContext } from "./provenance-service.ts";
import type { IssueFacts, TrackerConfig } from "./trackers/types.ts";
import { boardNotes } from "../dashboard/views/components/wiki-board-view.ts";

const url = (k: string) => `https://example.invalid/browse/${k}`;
const CONFIG = {
  typeMap: { plans: "plan" },
  trackers: [{ id: "jira", projects: ["DEMO"], hosts: ["example.invalid"], ledgerProjects: ["DEMO"] }],
};
const PAGES: Record<string, string> = {
  "a.md": "---\ntitle: DEMO-101 del en\njira: [DEMO-101]\nupdated: 2026-01-05\nprs: [example-org/demo-repo#2]\n---\n\nBody.\n",
  "b.md": "---\ntitle: Del to\ntags: [demo-101]\nupdated: 2026-01-09\nprs: [Example-Org/Demo-Repo#2, example-org/demo-repo#3]\n---\n\nBody.\n",
  "plans/p.md": "---\ntitle: DEMO-102 plan\ntype: plan\nupdated: 2026-01-02\n---\n\nPlan.\n",
  // No counting key: plain, link-only and mention-only.
  "loose.md": "---\ntitle: Løs side\nupdated: 2026-01-07\nprs: [example-org/demo-repo#9]\n---\n\nBody.\n",
  "linkonly.md": `---\ntitle: Bare lenke\nupdated: 2026-01-03\n---\n\nEpic: [DEMO-103](${url("DEMO-103")}).\n`,
  "mention.md": "---\ntitle: Nevner\nupdated: 2026-01-01\n---\n\nDEMO-101 nevnt.\n",
  // Bookkeeping: never keyless, never in an aggregate.
  "log.md": "---\ntitle: Logg\nprs: [example-org/demo-repo#77]\n---\n\nDEMO-101 i loggen.\n",
  "index.md": "---\ntitle: Indeks\n---\n\nBody.\n",
};

const roots: string[] = [];
let idx: WikiIndex;
const noLedger: GraphLedgerPort = {
  configured: false,
  publicUrl: null,
  merges: async () => ({ merges: [], asked: false, reachable: false, partial: false, truncated: false }) as never,
  facts: async () => ({ facts: new Map(), unresolved: new Set() }) as never,
  timedOut: () => false,
};

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wiki-graph-board-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(PAGES)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
    // The page's recency is the newest of its signals, the mtime among them:
    // pin it to the page's own `updated:` so the order is the fixture's.
    const day = /updated: (\S+)/.exec(body)?.[1] ?? "2025-06-01";
    const t = new Date(`${day}T12:00:00Z`);
    await utimes(path.join(root, rel), t, t);
  }
  await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify(CONFIG), "utf8");
  idx = (await getWikiIndex({ root, refresh: true }))!;
});
afterAll(async () => {
  __resetWikiCacheForTest();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const wikiQuery = (extra: Partial<GraphQuery> = {}): GraphQuery => ({ scope: "wiki", root: "", depth: 1, level: 1, ...extra });
async function graph(extra: Partial<GraphQuery> = {}) {
  const r = await buildGraph(idx, wikiQuery(extra), noLedger);
  if (!r.ok) throw new Error(r.error);
  return r.payload;
}
const issue = (nodes: readonly { id: string }[], key: string) => nodes.find((n) => n.id === `issue:jira:${key}`) as GraphIssueNode;

describe("parseGraphQuery: the board's opt-ins", () => {
  test("each opt-in is read at scope=wiki with its one value", () => {
    const r = parseGraphQuery({ scope: "wiki", keyless: "1", fields: "issue", ledger: "keys" });
    expect(r.ok && [r.query.keyless, r.query.issueFields, r.query.keysLedger]).toEqual([true, true, true]);
  });
  test("absent or blank leaves the query exactly PR 4's", () => {
    const r = parseGraphQuery({ scope: "wiki", keyless: "", fields: null });
    expect(r.ok && r.query).toEqual({ scope: "wiki", root: "", depth: 1, level: 1 });
  });
  test("another value is a 400 naming the parameter", () => {
    expect(parseGraphQuery({ scope: "wiki", keyless: "yes" })).toEqual({ ok: false, error: "keyless must be 1" });
    expect(parseGraphQuery({ scope: "wiki", fields: "page" })).toEqual({ ok: false, error: "fields must be issue" });
    expect(parseGraphQuery({ scope: "wiki", ledger: "sessions" })).toEqual({ ok: false, error: "ledger must be keys" });
  });
  test("any scope but wiki refuses them", () => {
    expect(parseGraphQuery({ scope: "page", root: "a.md", ledger: "keys" })).toEqual({
      ok: false,
      error: "ledger is only read at scope=wiki",
    });
  });
});

describe("buildGraph: the index-local opt-ins", () => {
  test("without them issue nodes carry no board field and there is no keylessPages", async () => {
    const p = await graph();
    expect(p.keylessPages).toBeUndefined();
    const n = issue(p.nodes, "DEMO-101");
    expect(Object.keys(n).sort()).toEqual(["hop", "id", "key", "label", "lane", "pageCount", "planPages", "tracker", "url"]);
  });

  test("fields=issue: stamped count, newest page time and deduped PRs over the key's counting pages", async () => {
    const p = await graph({ issueFields: true });
    const n101 = issue(p.nodes, "DEMO-101");
    const pageTime = (rel: string) => (p.nodes.find((n) => n.id === `page:${rel}`) as GraphPageNode).pageTimeMs;
    expect(n101.pageCount).toBe(2);
    expect(n101.stampedCount).toBe(1);
    expect(pageTime("b.md")).toBeGreaterThan(pageTime("a.md"));
    expect(n101.lastActivityMs).toBe(pageTime("b.md"));
    expect(n101.lastActivityMs).toBeGreaterThan(0);
    // One PR spelled two ways is one; the bookkeeping log's #77 and the mention are not counted.
    expect(n101.prRefs).toEqual(["example-org/demo-repo#2", "example-org/demo-repo#3"]);
    const n102 = issue(p.nodes, "DEMO-102");
    expect([n102.stampedCount, n102.planPages.length, n102.prRefs]).toEqual([0, 1, []]);
  });

  test("the aggregates do not depend on the drawn edges: depth 0 gives the same numbers", async () => {
    const a = issue((await graph({ issueFields: true })).nodes, "DEMO-101");
    const b = issue((await graph({ issueFields: true, depth: 0 })).nodes, "DEMO-101");
    expect([b.stampedCount, b.lastActivityMs, b.prRefs]).toEqual([a.stampedCount, a.lastActivityMs, a.prRefs]);
  });

  test("keyless=1: every non-bookkeeping page with no counting key, newest first, on no edge", async () => {
    const p = await graph({ keyless: true, depth: 0 });
    expect(p.keylessPages!.map((n) => n.relPath)).toEqual(["loose.md", "linkonly.md", "mention.md"]);
    expect(p.keylessPages![0]!.prRefs).toEqual(["example-org/demo-repo#9"]);
    expect(p.keylessPages!.every((n) => n.hop === 0 && n.lane === "page")).toBe(true);
    // Not graph nodes: a graph client never draws them.
    expect(p.nodes.some((n) => n.id === "page:loose.md")).toBe(false);
    expect(p.edges).toEqual([]);
  });
});

const trackers = () => idx.readerConfig!.trackers!;

function ctxWith(opts: {
  fetch?: (path: string, signal?: AbortSignal) => Promise<unknown>;
  configured?: boolean;
  lookup?: Map<string, IssueFacts> | null;
}): ProvenanceContext & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    sessionLedger: {
      baseUrl: "http://ledger.test",
      urlConfigured: opts.configured ?? true,
      fetchSessions: async () => ({}),
      fetchMerges: async () => ({}),
      fetchHandoff: async () => ({}),
      fetchMergesForPrs: async () => ({}),
      fetchIssueLedger: async (p, signal) => {
        paths.push(p);
        return opts.fetch ? opts.fetch(p, signal) : {};
      },
    },
    knowledgeApiUrl: "http://huginn.test",
    publicUrl: null,
    lookupIssues: async () => opts.lookup ?? null,
  };
}

/** The CU-2 answer for the keys in a `/api/jira/keys?keys=` path. */
const keysAnswer = (p: string, tracked: (k: string) => boolean = () => true) => ({
  keys: decodeURIComponent(p.slice(p.indexOf("=") + 1))
    .split(",")
    .map((key) => ({
      key,
      tracked: tracked(key),
      sessionCount: tracked(key) ? 3 : 0,
      totalCost: tracked(key) ? 4.505 : 0,
      costedSessions: tracked(key) ? 2 : 0,
      lastSeen: tracked(key) ? "2026-01-06T10:00:00Z" : null,
      truncated: false,
    })),
  limit: 200,
  truncated: false,
});

const nodesFor = (keys: string[]): GraphIssueNode[] =>
  keys.map((key) => ({ id: `issue:jira:${key}`, lane: "issue", hop: 0, tracker: "jira", key, label: "Jira", url: "", pageCount: 1, planPages: [] }));

describe("joinKeysLedger", () => {
  test("one call per 200 keys, and every key priced from its own row", async () => {
    const keys = Array.from({ length: 450 }, (_, i) => `DEMO-${1000 + i}`);
    const nodes = nodesFor(keys);
    const ctx = ctxWith({ fetch: async (p) => keysAnswer(p) });
    const state = await joinKeysLedger(nodes, trackers(), ctx);
    expect(ctx.paths.length).toBe(3);
    expect(ctx.paths.map((p) => p.split(",").length)).toEqual([200, 200, 50]);
    expect(ctx.paths[0]!.startsWith("/api/jira/keys?keys=DEMO-1000,")).toBe(true);
    expect(state).toEqual({ configured: true, calls: 3, answered: 3, reachable: true, timedOut: false });
    expect(nodes[449]!.keyLedger).toEqual({
      state: "priced",
      sessions: 3,
      totalCost: 4.51,
      costedSessions: 2,
      truncated: false,
      lastSeen: "2026-01-06T10:00:00Z",
    });
  });

  test("a 404 (a claude-usage without the route) leaves every key unpriced, never zero", async () => {
    const nodes = nodesFor(["DEMO-101", "DEMO-102"]);
    const ctx = ctxWith({
      fetch: async () => {
        throw Object.assign(new Error("claude-usage returned HTTP 404 for http://ledger.test"), { status: 404 });
      },
    });
    const state = await joinKeysLedger(nodes, trackers(), ctx);
    expect(state.reachable).toBe(false);
    expect(nodes.map((n) => n.keyLedger)).toEqual([
      { state: "unpriced", reason: "unreachable" },
      { state: "unpriced", reason: "unreachable" },
    ]);
  });

  test("a malformed answer is unreachable, and a malformed row leaves its key unanswered", async () => {
    const nodes = nodesFor(["DEMO-101"]);
    await joinKeysLedger(nodes, trackers(), ctxWith({ fetch: async () => ({ sessions: [] }) }));
    expect(nodes[0]!.keyLedger).toEqual({ state: "unpriced", reason: "unreachable" });
    const two = nodesFor(["DEMO-101", "DEMO-102"]);
    const state = await joinKeysLedger(
      two,
      trackers(),
      ctxWith({ fetch: async () => ({ keys: [{ key: "DEMO-101", tracked: true, sessionCount: "3" }, keysAnswer("x=DEMO-102").keys[0]] }) }),
    );
    expect(state.reachable).toBe(true);
    expect(two.map((n) => n.keyLedger!.state)).toEqual(["unpriced", "priced"]);
  });

  test("tracked:false and a project outside ledgerProjects are not tracked; the second is never asked", async () => {
    const withOther: TrackerConfig[] = [{ ...trackers()[0]!, projects: ["DEMO", "ZETA"], ledgerProjects: ["DEMO"] }];
    const nodes = nodesFor(["DEMO-101", "DEMO-150", "ZETA-7"]);
    const ctx = ctxWith({ fetch: async (p) => keysAnswer(p, (k) => k !== "DEMO-150") });
    await joinKeysLedger(nodes, withOther, ctx);
    expect(ctx.paths).toEqual(["/api/jira/keys?keys=DEMO-101,DEMO-150"]);
    expect(nodes.map((n) => n.keyLedger!.state)).toEqual(["priced", "not-tracked", "not-tracked"]);
  });

  test("no ledger configured: no call, every key not-configured", async () => {
    const nodes = nodesFor(["DEMO-101"]);
    const ctx = ctxWith({ configured: false });
    const state = await joinKeysLedger(nodes, trackers(), ctx);
    expect([ctx.paths.length, state.calls, state.reachable, nodes[0]!.keyLedger]).toEqual([
      0,
      0,
      false,
      { state: "unpriced", reason: "not-configured" },
    ]);
  });

  test("a ledger that never answers is cut at the deadline", async () => {
    const nodes = nodesFor(["DEMO-101"]);
    const deadline = AbortSignal.timeout(20);
    const ctx = ctxWith({ fetch: () => new Promise(() => {}) });
    const state = await joinKeysLedger(nodes, trackers(), ctx, deadline, deadline);
    expect(state).toEqual({ configured: true, calls: 1, answered: 0, reachable: false, timedOut: true });
    expect(nodes[0]!.keyLedger).toEqual({ state: "unpriced", reason: "deadline" });
  });

  test("ledgerKeyBatches: calls of at most max keys", () => {
    expect(ledgerKeyBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(ledgerKeyBatches([], 200)).toEqual([]);
  });
});

describe("joinIssueFields", () => {
  test("a lookup that answered: title, status, category, and known on every key", async () => {
    const nodes = nodesFor(["DEMO-101", "DEMO-102", "DEMO-199"]);
    const lookup = new Map<string, IssueFacts>([
      ["DEMO-101", { title: "Grunnfeil", status: "In Progress", updated: "2026-01-04T10:00:00.000+0100" }],
      ["DEMO-102", { title: "Ukjent status", status: "Parkert" }],
    ]);
    const state = await joinIssueFields(nodes, trackers(), ctxWith({ lookup }));
    expect(state).toEqual({ available: true });
    expect(nodes.map((n) => [n.known, n.category, n.status ?? null])).toEqual([
      [true, "active", "In Progress"],
      [true, "unknown", "Parkert"],
      [false, "unknown", null],
    ]);
    expect(nodes[0]!.title).toBe("Grunnfeil");
  });
  test("a lookup that did not answer: nothing on the nodes, and available false", async () => {
    const nodes = nodesFor(["DEMO-101"]);
    expect(await joinIssueFields(nodes, trackers(), ctxWith({ lookup: null }))).toEqual({ available: false });
    expect([nodes[0]!.known, nodes[0]!.category]).toEqual([undefined, undefined]);
  });
});

describe("fix round 1", () => {
  test("S1: a padded or repeated opt-in is a 400 naming the parameter", () => {
    expect(parseGraphQuery({ scope: "wiki", keyless: " 1 " })).toEqual({ ok: false, error: "keyless must be 1" });
    expect(parseGraphQuery({ scope: "wiki", keyless: ["1", "2"] })).toEqual({ ok: false, error: "keyless must be given once" });
    expect(parseGraphQuery({ scope: "wiki", ledger: ["keys", "keys"] })).toEqual({ ok: false, error: "ledger must be given once" });
    const once = parseGraphQuery({ scope: "wiki", keyless: ["1"], fields: ["issue"] });
    expect(once.ok && [once.query.keyless, once.query.issueFields]).toEqual([true, true]);
  });

  test("S2: keyless is cut past GRAPH_NODES_MAX, said on its own flag, and the drawn graph is not called cut", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-graph-board-keyless-"));
    roots.push(root);
    await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify(CONFIG), "utf8");
    await Promise.all(
      Array.from({ length: GRAPH_NODES_MAX + 1 }, (_, i) => writeFile(path.join(root, `p${i}.md`), `---\ntitle: P${i}\n---\n\nBody.\n`, "utf8")),
    );
    const big = (await getWikiIndex({ root, refresh: true }))!;
    const r = await buildGraph(big, wikiQuery({ keyless: true, depth: 0 }), noLedger);
    if (!r.ok) throw new Error(r.error);
    expect(r.payload.keylessPages!.length).toBe(GRAPH_NODES_MAX);
    expect(r.payload.keylessTruncated).toBe(true);
    expect([r.payload.truncated, r.payload.truncatedBy]).toEqual([undefined, undefined]);
  });

  test("C8: a key the answer holds no row for is unpriced with reason no-row; the call still reached", async () => {
    const nodes = nodesFor(["DEMO-101"]);
    const state = await joinKeysLedger(nodes, trackers(), ctxWith({ fetch: async () => ({ keys: [] }) }));
    expect(state.reachable).toBe(true);
    expect(nodes[0]!.keyLedger).toEqual({ state: "unpriced", reason: "no-row" });
  });

  test("S4: applyBoardJoins starts the lookup and the keys ledger together, and sets both states", async () => {
    let lookupDone = false;
    let ledgerBeforeLookup: boolean | undefined;
    const ctx = ctxWith({
      fetch: async (p) => {
        ledgerBeforeLookup ??= !lookupDone;
        return keysAnswer(p);
      },
    });
    ctx.lookupIssues = async () => {
      await new Promise((r) => setTimeout(r, 40));
      lookupDone = true;
      return new Map();
    };
    const payload = { nodes: nodesFor(["DEMO-101"]) } as unknown as GraphPayload;
    await applyBoardJoins(payload, { issueFields: true, keysLedger: true }, trackers(), ctx, {});
    expect(ledgerBeforeLookup).toBe(true);
    expect(payload.issueLookup).toEqual({ available: true });
    expect(payload.keysLedger).toMatchObject({ calls: 1, answered: 1, reachable: true });
  });
});

describe("fix round 2", () => {
  test("D2: a batch answering only tracked:false rows plus a failed batch: answered 1 of 2, and the board counts the failed keys", async () => {
    const keys = Array.from({ length: 201 }, (_, i) => `DEMO-${1000 + i}`);
    const nodes = nodesFor(keys);
    let n = 0;
    const ctx = ctxWith({
      fetch: async (p) => {
        if (n++ === 0) return keysAnswer(p, () => false);
        throw new Error("claude-usage returned HTTP 502");
      },
    });
    const state = await joinKeysLedger(nodes, trackers(), ctx);
    const payload: Pick<GraphPayload, "nodes" | "keysLedger"> = { nodes, keysLedger: state };
    expect(boardNotes(payload)).toEqual(["1 key could not be priced: the session ledger did not answer for it."]);
    expect(state).toEqual({ configured: true, calls: 2, answered: 1, reachable: false, timedOut: false });
  });

  const hung = () => new Promise<never>(() => {});

  test("P: applyBoardJoins hands the signal to the lookup: a hung lookup is cut, and the lookup reads unavailable", async () => {
    const ctx = ctxWith({ fetch: async (p) => keysAnswer(p) });
    ctx.lookupIssues = hung;
    const payload: Pick<GraphPayload, "nodes" | "issueLookup" | "keysLedger"> = { nodes: nodesFor(["DEMO-101"]) };
    await applyBoardJoins(payload as GraphPayload, { issueFields: true }, trackers(), ctx, { signal: AbortSignal.timeout(20) });
    expect(payload.issueLookup).toEqual({ available: false });
  }, 2_000);

  test("P: applyBoardJoins hands the signal to the ledger: a hung ledger is cut, each key unpriced", async () => {
    const payload: Pick<GraphPayload, "nodes" | "issueLookup" | "keysLedger"> = { nodes: nodesFor(["DEMO-101"]) };
    await applyBoardJoins(payload as GraphPayload, { keysLedger: true }, trackers(), ctxWith({ fetch: hung }), { signal: AbortSignal.timeout(20) });
    expect(payload.keysLedger).toEqual({ configured: true, calls: 1, answered: 0, reachable: false, timedOut: false });
    expect((payload.nodes[0] as GraphIssueNode).keyLedger).toEqual({ state: "unpriced", reason: "deadline" });
  }, 2_000);

  test("P: applyBoardJoins hands the deadline to the ledger, which then reports timedOut", async () => {
    const deadline = AbortSignal.timeout(20);
    const payload: Pick<GraphPayload, "nodes" | "issueLookup" | "keysLedger"> = { nodes: nodesFor(["DEMO-101"]) };
    await applyBoardJoins(payload as GraphPayload, { keysLedger: true }, trackers(), ctxWith({ fetch: hung }), { signal: deadline, deadline });
    expect(payload.keysLedger).toMatchObject({ timedOut: true, reachable: false });
  }, 2_000);

  test("P: exactly GRAPH_NODES_MAX keyless pages is not cut", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-graph-board-keyless-eq-"));
    roots.push(root);
    await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify(CONFIG), "utf8");
    await Promise.all(
      Array.from({ length: GRAPH_NODES_MAX }, (_, i) => writeFile(path.join(root, `p${i}.md`), `---\ntitle: P${i}\n---\n\nBody.\n`, "utf8")),
    );
    const r = await buildGraph((await getWikiIndex({ root, refresh: true }))!, wikiQuery({ keyless: true, depth: 0 }), noLedger);
    if (!r.ok) throw new Error(r.error);
    expect(r.payload.keylessPages!.length).toBe(GRAPH_NODES_MAX);
    expect(r.payload.keylessTruncated).toBeUndefined();
  });
});

