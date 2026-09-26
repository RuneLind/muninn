/**
 * The graph walk through a real index build: the depth/level walk, edges only
 * through counting relations, the session cap, the scope defaults and the
 * no-tracker answer. Synthetic keys (`DEMO`), host (`example.invalid`) and
 * repos (`example-org/demo-repo`). No session or PR is shared between pages.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetWikiCacheForTest, getWikiIndex, type WikiIndex } from "../store.ts";
import type { ProvenanceMerge } from "../provenance.ts";
import type { SessionLedgerResult } from "../session-ledger.ts";
import { buildGraph, mergePrRef, type GraphLedgerPort } from "./graph.ts";
import {
  GRAPH_SESSIONS_MAX,
  parseGraphQuery,
  type GraphLane,
  type GraphPayload,
  type GraphQuery,
} from "./graph-types.ts";

const url = (k: string) => `https://example.invalid/browse/${k}`;
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const S1 = sid(1);
const S2 = sid(2);
const S3 = sid(3);
const S4 = sid(4);

const CONFIG = {
  typeMap: { plans: "plan" },
  trackers: [
    {
      id: "jira",
      projects: ["DEMO"],
      hosts: ["example.invalid"],
      createdMarkers: ["opprettet"],
      planTitle: "plan(er|en)?(?!\\p{L})",
    },
  ],
};

const PAGES: Record<string, string> = {
  // Created ×3, tag ×2, a mention and a link-only key; two sessions, one PR.
  "anchor.md":
    `---\ntitle: Rotårsak\ntags: [demo-120, demo-121]\nsessions: [claude-code:${S1}, claude-code:${S2}]\nprs: [example-org/demo-repo#11]\n---\n\n` +
    `Jira opprettet: [DEMO-101](${url("DEMO-101")}), [DEMO-102](${url("DEMO-102")}) og [DEMO-103](${url("DEMO-103")}).\n\n` +
    `Se også DEMO-122. Epic: [DEMO-190](${url("DEMO-190")}).\n`,
  // Two hops out (through DEMO-101 and DEMO-120), each with a session and a PR three hops out.
  "notes/demo-101-arbeidsplan.md": `---\ntitle: DEMO-101 arbeidsplan\nsessions: [claude-code:${S3}]\nprs: [example-org/demo-repo#12]\n---\n\nPlan.\n`,
  "notes/tagged.md": `---\ntitle: Tagget\ntags: [demo-120]\nsessions: [${S4}]\n---\n\nBody.\n`,
  // Only a mention of, and only a link to, one of the anchor's keys: no edge.
  "notes/mention-only.md": "---\ntitle: Nevnt\n---\n\nDEMO-102 nevnt her.\n",
  "notes/linked-102.md": `---\ntitle: Lenket\n---\n\nEpic: [DEMO-102](${url("DEMO-102")}).\n`,
  // The mention key's own page — reached only if a mention were an edge.
  "notes/demo-122-bakgrunn.md": "---\ntitle: DEMO-122 bakgrunn\n---\n\nBody.\n",
  // A series of two.
  "series/a.md": "---\ntitle: DEMO-130 del en\nseries: demo-serie\n---\n\nBody.\n",
  "series/b.md": "---\ntitle: Del to\nseries: demo-serie\ntags: [demo-131]\n---\n\nBody.\n",
  // Past the session cap.
  "many.md": `---\ntitle: DEMO-140 mange\nsessions: [${Array.from({ length: GRAPH_SESSIONS_MAX + 1 }, (_, i) => sid(1000 + i)).join(", ")}]\n---\n\nBody.\n`,
};

const MERGES: Record<string, Partial<ProvenanceMerge>[]> = {
  [S1]: [{ url: "https://github.com/example-org/demo-repo/pull/21", prNumber: 21, subject: "Fiks A" }],
  [S2]: [{ url: "https://github.com/example-org/demo-repo/pull/22", prNumber: 22 }],
  [S3]: [{ url: "https://github.com/example-org/demo-repo/pull/31", prNumber: 31 }],
};

const roots: string[] = [];
let idx: WikiIndex;
let plain: WikiIndex;

async function build(config: object | null): Promise<WikiIndex> {
  const root = await mkdtemp(path.join(tmpdir(), "wiki-graph-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(PAGES)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
  if (config) await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify(config), "utf8");
  return (await getWikiIndex({ root, refresh: true }))!;
}

beforeAll(async () => {
  idx = await build(CONFIG);
  plain = await build(null);
});
afterAll(async () => {
  __resetWikiCacheForTest();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** A fake ledger that records every call. */
function fakePort(configured = true): GraphLedgerPort & { calls: { kind: string; ids: string[] }[] } {
  const calls: { kind: string; ids: string[] }[] = [];
  return {
    calls,
    configured,
    publicUrl: null,
    merges: async (ids) => {
      calls.push({ kind: "merges", ids });
      const merges = ids.flatMap((id) =>
        (MERGES[id] ?? []).map((m) => ({
          sessionId: id,
          repo: "/src/demo-repo",
          prNumber: null,
          url: null,
          subject: null,
          mergedAt: "2026-01-05T10:00:00Z",
          mergeOk: true,
          gate: null,
          preStandardization: false,
          ...m,
        })) as ProvenanceMerge[],
      );
      return { reachable: true, merges };
    },
    facts: async (ids): Promise<SessionLedgerResult> => {
      calls.push({ kind: "facts", ids });
      return {
        asked: true,
        reachable: true,
        partial: false,
        baseUrl: "http://ledger.test",
        urlConfigured: true,
        facts: new Map(ids.map((id) => [id, { sessionId: id, title: `Økt ${id.slice(-2)}`, cost: 1.5 }])),
        unresolved: new Set(),
        invalid: new Set(),
        truncated: false,
      };
    },
  };
}

async function graph(q: Partial<GraphQuery> & { scope: GraphQuery["scope"] }, port = fakePort(), index = idx) {
  const parsed = parseGraphQuery({
    scope: q.scope,
    root: q.root ?? "",
    depth: q.depth === undefined ? "" : String(q.depth),
    level: q.level === undefined ? "" : String(q.level),
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const res = await buildGraph(index, parsed.query, port);
  return { res, port };
}

function lanes(p: GraphPayload): Record<GraphLane, string[]> {
  const out: Record<GraphLane, string[]> = { issue: [], page: [], session: [], pr: [] };
  for (const n of p.nodes) {
    out[n.lane].push(n.lane === "issue" ? n.key : n.lane === "page" ? n.relPath : n.lane === "session" ? n.sessionId : n.ref);
  }
  return out;
}

const ok = (r: Awaited<ReturnType<typeof graph>>["res"]): GraphPayload => {
  if (!r.ok) throw new Error(r.error);
  return r.payload;
};

describe("buildGraph — the page scope at depth 2, level 3", () => {
  test("draws the five counting issues, their pages, the stamped sessions and the PRs one or two hops out", async () => {
    const { res, port } = await graph({ scope: "page", root: "anchor.md", depth: 2, level: 3 });
    const p = ok(res);
    const l = lanes(p);
    expect(l.issue.sort()).toEqual(["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-120", "DEMO-121"]);
    expect(l.page.sort()).toEqual(["anchor.md", "notes/demo-101-arbeidsplan.md", "notes/tagged.md"]);
    // S3 and S4 are stamped on the two-hop pages: three hops, not drawn.
    expect(l.session.sort()).toEqual([S1, S2]);
    // #11 from prRefs (1 hop), #21/#22 through the sessions (2 hops); #12 and #31 are 3+.
    expect(l.pr.sort()).toEqual(["example-org/demo-repo#11", "example-org/demo-repo#21", "example-org/demo-repo#22"]);
    expect(p.lanes).toEqual(["issue", "page", "session", "pr"]);
    expect(p.truncated).toBeUndefined();
    // Merges asked for the anchor's sessions only (the one expanded hop that
    // holds sessions); facts once for every drawn session.
    expect(port.calls).toEqual([
      { kind: "merges", ids: [S1, S2] },
      { kind: "facts", ids: [S1, S2] },
    ]);
    expect(p.ledger).toEqual({ configured: true, asked: true, reachable: true, timedOut: false });
  });

  test("hops: root 0, its issues/sessions/prRefs 1, the other pages and the merged PRs 2", async () => {
    const p = ok((await graph({ scope: "page", root: "anchor.md", depth: 2, level: 3 })).res);
    const hop = Object.fromEntries(p.nodes.map((n) => [n.id, n.hop]));
    expect(hop["page:anchor.md"]).toBe(0);
    expect(hop["issue:jira:DEMO-101"]).toBe(1);
    expect(hop[`session:${S1}`]).toBe(1);
    expect(hop["pr:example-org/demo-repo#11"]).toBe(1);
    expect(hop["page:notes/tagged.md"]).toBe(2);
    expect(hop["pr:example-org/demo-repo#21"]).toBe(2);
  });

  test("edges run only through counting relations; link and mention keys and their pages are absent", async () => {
    const p = ok((await graph({ scope: "page", root: "anchor.md", depth: 2, level: 3 })).res);
    const ids = new Set(p.nodes.map((n) => n.id));
    for (const absent of ["issue:jira:DEMO-122", "issue:jira:DEMO-190", "page:notes/mention-only.md", "page:notes/linked-102.md", "page:notes/demo-122-bakgrunn.md"]) {
      expect(ids.has(absent)).toBe(false);
    }
    for (const e of p.edges) {
      expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
      if (e.kind === "issue-page") {
        expect(e.relations!.length).toBeGreaterThan(0);
        expect(e.relations).not.toContain("mention");
        expect(e.relations!.every((r) => r === "link")).toBe(false);
      }
    }
    const kinds = p.edges.reduce<Record<string, number>>((acc, e) => ((acc[e.kind] = (acc[e.kind] ?? 0) + 1), acc), {});
    // 5 anchor↔issue + arbeidsplan↔101 + tagged↔120; 2 sessions; #11; S1→#21, S2→#22.
    expect(kinds).toEqual({ "issue-page": 7, "page-session": 2, "page-pr": 1, "session-pr": 2 });
  });

  test("session nodes carry the ledger's facts; PR nodes the merge subject", async () => {
    const p = ok((await graph({ scope: "page", root: "anchor.md", depth: 2, level: 3 })).res);
    const s1 = p.nodes.find((n) => n.id === `session:${S1}`)!;
    expect(s1).toMatchObject({ lane: "session", ref: `claude-code:${S1}`, provider: "claude-code", cost: 1.5, unresolved: false });
    const pr = p.nodes.find((n) => n.id === "pr:example-org/demo-repo#21")!;
    expect(pr).toMatchObject({ url: "https://github.com/example-org/demo-repo/pull/21", subject: "Fiks A" });
  });
});

describe("buildGraph — levels and depth", () => {
  test("level 1 draws issues and pages only, and makes no ledger call", async () => {
    const { res, port } = await graph({ scope: "page", root: "anchor.md", depth: 2, level: 1 });
    const p = ok(res);
    expect(p.lanes).toEqual(["issue", "page"]);
    expect(lanes(p).session).toEqual([]);
    expect(lanes(p).pr).toEqual([]);
    expect(port.calls).toEqual([]);
    expect(p.ledger.asked).toBe(false);
  });

  test("level 2 adds sessions but no PR lane, so no merges call", async () => {
    const { res, port } = await graph({ scope: "page", root: "anchor.md", depth: 2, level: 2 });
    const p = ok(res);
    expect(lanes(p).session.sort()).toEqual([S1, S2]);
    expect(lanes(p).pr).toEqual([]);
    expect(port.calls.map((c) => c.kind)).toEqual(["facts"]);
  });

  test("depth 1 never expands the sessions, so no merges call and no merged PR", async () => {
    const { res, port } = await graph({ scope: "page", root: "anchor.md", depth: 1, level: 3 });
    const p = ok(res);
    expect(lanes(p).pr).toEqual(["example-org/demo-repo#11"]);
    expect(lanes(p).page).toEqual(["anchor.md"]);
    expect(port.calls.map((c) => c.kind)).toEqual(["facts"]);
  });

  test("depth 0 is the root alone", async () => {
    const p = ok((await graph({ scope: "page", root: "anchor.md", depth: 0, level: 3 })).res);
    expect(p.nodes.map((n) => n.id)).toEqual(["page:anchor.md"]);
    expect(p.edges).toEqual([]);
  });

  test("an unconfigured ledger still draws the stamped sessions, unresolved, and asks nothing", async () => {
    const port = fakePort(false);
    const p = ok((await graph({ scope: "page", root: "anchor.md", depth: 2, level: 3 }, port)).res);
    expect(port.calls).toEqual([]);
    expect(lanes(p).session.sort()).toEqual([S1, S2]);
    expect(p.nodes.filter((n) => n.lane === "session").every((n) => n.lane === "session" && n.unresolved)).toBe(true);
    expect(lanes(p).pr).toEqual(["example-org/demo-repo#11"]);
    expect(p.ledger).toEqual({ configured: false, asked: false, reachable: false, timedOut: false });
  });
});

describe("buildGraph — scopes", () => {
  test("issue scope roots at the key: its counting pages, then their keys, sessions and PRs", async () => {
    const p = ok((await graph({ scope: "issue", root: "jira:demo-101" })).res);
    expect(p.root).toBe("jira:DEMO-101");
    expect(p.depth).toBe(2);
    expect(p.level).toBe(3);
    const l = lanes(p);
    expect(l.page.sort()).toEqual(["anchor.md", "notes/demo-101-arbeidsplan.md"]);
    expect(l.issue.sort()).toEqual(["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-120", "DEMO-121"]);
    expect(l.session.sort()).toEqual([S1, S2, S3]);
    expect(l.pr.sort()).toEqual(["example-org/demo-repo#11", "example-org/demo-repo#12"]);
  });

  test("series scope defaults to level 1 and roots at every member", async () => {
    const { res, port } = await graph({ scope: "series", root: "demo-serie" });
    const p = ok(res);
    expect(p.level).toBe(1);
    expect(port.calls).toEqual([]);
    expect(p.nodes.filter((n) => n.hop === 0).map((n) => n.id)).toEqual(["page:series/a.md", "page:series/b.md"]);
    expect(lanes(p).issue.sort()).toEqual(["DEMO-130", "DEMO-131"]);
  });

  test("wiki scope defaults to level 1, roots at every counting key, asks no ledger, and carries the board's fields", async () => {
    const { res, port } = await graph({ scope: "wiki" });
    const p = ok(res);
    expect(p.level).toBe(1);
    expect(p.depth).toBe(1);
    expect(port.calls).toEqual([]);
    const l = lanes(p);
    // Every counting key; never the link-only DEMO-190.
    expect(l.issue.sort()).toEqual(
      ["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-120", "DEMO-121", "DEMO-122", "DEMO-130", "DEMO-131", "DEMO-140"].sort(),
    );
    expect(l.page).not.toContain("notes/mention-only.md");
    expect(l.page).not.toContain("notes/linked-102.md");
    const anchor = p.nodes.find((n) => n.id === "page:anchor.md")!;
    expect(anchor).toMatchObject({ prRefs: ["example-org/demo-repo#11"] });
    expect(anchor.lane === "page" && anchor.pageTimeMs > 0).toBe(true);
    const k101 = p.nodes.find((n) => n.id === "issue:jira:DEMO-101")!;
    expect(k101).toMatchObject({
      key: "DEMO-101",
      label: "Jira",
      url: url("DEMO-101"),
      pageCount: 2,
      planPages: [{ relPath: "notes/demo-101-arbeidsplan.md", title: "DEMO-101 arbeidsplan" }],
    });
  });

  test("past the session cap the answer is truncated at exactly the cap", async () => {
    const p = ok((await graph({ scope: "page", root: "many.md", level: 2 })).res);
    expect(p.truncated).toBe(true);
    expect(p.truncatedBy).toEqual(["sessions"]);
    expect(lanes(p).session.length).toBe(GRAPH_SESSIONS_MAX);
  });

  test("404s: no tracker, an unknown page, a key no page counts, a missing series", async () => {
    for (const [q, index] of [
      [{ scope: "page", root: "anchor.md" }, plain],
      [{ scope: "page", root: "nope.md" }, idx],
      [{ scope: "issue", root: "jira:DEMO-190" }, idx],
      [{ scope: "issue", root: "jira:DEMO-999" }, idx],
      [{ scope: "issue", root: "nope" }, idx],
      [{ scope: "series", root: "nope" }, idx],
    ] as const) {
      const { res } = await graph(q as Partial<GraphQuery> & { scope: GraphQuery["scope"] }, fakePort(), index);
      expect(res.ok, JSON.stringify(q)).toBe(false);
    }
    const { res } = await graph({ scope: "page", root: "anchor.md" }, fakePort(), plain);
    expect(res).toEqual({ ok: false, status: 404, error: "this wiki names no tracker" });
  });
});

describe("parseGraphQuery", () => {
  test("defaults per scope", () => {
    const d = (scope: string, level = "") => {
      const r = parseGraphQuery({ scope, root: "x", level });
      if (!r.ok) throw new Error(r.error);
      return [r.query.depth, r.query.level];
    };
    expect(d("page")).toEqual([2, 3]);
    expect(d("issue")).toEqual([2, 3]);
    expect(d("series")).toEqual([2, 1]);
    expect(d("wiki")).toEqual([1, 1]);
    expect(d("wiki", "3")).toEqual([3, 3]);
    expect(d("")).toEqual([2, 3]);
  });

  test("refusals name the parameter", () => {
    const err = (q: Parameters<typeof parseGraphQuery>[0]) => {
      const r = parseGraphQuery(q);
      return r.ok ? "" : r.error;
    };
    expect(err({ scope: "galaxy", root: "x" })).toContain("scope");
    expect(err({ scope: "page" })).toContain("root");
    expect(err({ scope: "page", root: "x", level: "4" })).toContain("level");
    expect(err({ scope: "page", root: "x", level: "1.0" })).toContain("level");
    expect(err({ scope: "page", root: "x", depth: "5" })).toContain("depth");
    expect(err({ scope: "page", root: "x", depth: "-1" })).toContain("depth");
    // wiki needs no root, and ignores one.
    const w = parseGraphQuery({ scope: "wiki", root: "ignored" });
    expect(w.ok && w.query.root).toBe("");
  });
});

describe("mergePrRef", () => {
  const base: ProvenanceMerge = {
    sessionId: S1,
    repo: "/src/demo-repo",
    prNumber: 5,
    url: null,
    subject: null,
    mergedAt: null,
    mergeOk: true,
    gate: null,
    preStandardization: false,
  };
  test("reads the coordinate off a GitHub URL, else the repo dir, else nothing", () => {
    expect(mergePrRef({ ...base, url: "https://github.com/example-org/demo-repo/pull/5" })).toBe("example-org/demo-repo#5");
    expect(mergePrRef(base)).toBe("demo-repo#5");
    expect(mergePrRef({ ...base, prNumber: null })).toBeNull();
  });
});
