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
import { __resetWikiCacheForTest, getWikiIndex, type WikiIndex } from "./store.ts";
import type { ProvenanceMerge } from "./provenance.ts";
import type { SessionLedgerResult } from "./session-ledger.ts";
import { buildGraph, knownPrRefs, mergePrRef, type GraphLedgerPort } from "./graph.ts";
import * as graphTypes from "./graph-types.ts";
import {
  GRAPH_SESSIONS_MAX,
  parseGraphQuery,
  parseIssueRoot,
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
const S5 = sid(5);
const LONG_ID = "a".repeat(5000);

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
  // Fix round 1: one PR named by a page (mixed case) and by a URL-less merge
  // row; junk session refs; two bookkeeping pages reachable through the PR and
  // the session.
  "dup.md": `---\ntitle: Duplikat\nsessions: [claude-code:${S5}, see notes, x y, ${LONG_ID}]\nprs: [Example-Org/Demo-Repo#51]\n---\n\nBody.\n`,
  "log.md": "---\ntitle: Logg\nprs: [example-org/demo-repo#51]\n---\n\nBody.\n",
  "sub/index.md": `---\ntitle: Indeks\nsessions: [${S5}]\n---\n\nBody.\n`,
  // Exactly the cap in real ids, plus one junk ref that must not count.
  "cap-junk.md": `---\ntitle: Tak\nsessions: [see notes, ${Array.from({ length: GRAPH_SESSIONS_MAX }, (_, i) => sid(3000 + i)).join(", ")}]\n---\n\nBody.\n`,
  // Fix round 2: a bookkeeping page that names the series.
  "serie-logg/log.md": "---\ntitle: Serielogg\nseries: demo-serie\n---\n\nBody.\n",
};

const MERGES: Record<string, Partial<ProvenanceMerge>[]> = {
  [S1]: [{ url: "https://github.com/example-org/demo-repo/pull/21", prNumber: 21, subject: "Fiks A" }],
  [S2]: [{ url: "https://github.com/example-org/demo-repo/pull/22", prNumber: 22 }],
  [S3]: [{ url: "https://github.com/example-org/demo-repo/pull/31", prNumber: 31 }],
  [S5]: [
    // No URL: the page's `Example-Org/Demo-Repo#51` by basename + number.
    { repo: "/src/DEMO-repo", prNumber: 51 },
    // No URL and no page names it: the `<basename>#n` fallback.
    { repo: "/src/other-repo", prNumber: 52 },
    // The merge command never confirmed it.
    { url: "https://github.com/example-org/demo-repo/pull/53", prNumber: 53, mergeOk: false },
  ],
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
    timedOut: () => false,
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
      return { asked: true, reachable: true, partial: false, truncated: false, merges };
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
    expect(p.ledger).toEqual({ configured: true, asked: true, reachable: true, timedOut: false, mergesPartial: false, mergesTruncated: false });
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
    expect(p.ledger).toEqual({ configured: false, asked: false, reachable: false, timedOut: false, mergesPartial: false, mergesTruncated: false });
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
      const r = parseGraphQuery({ scope, root: scope === "issue" ? "jira:DEMO-1" : "x", level });
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
  test("S1: a URL-less row resolves onto a page's PR by basename + number, unless two owners claim it", () => {
    const known = knownPrRefs([{ prRefs: ["Example-Org/Demo-Repo#5"] }, { prRefs: ["other-org/twin#6"] }, { prRefs: ["example-org/twin#6"] }]);
    expect(mergePrRef(base, known)).toBe("Example-Org/Demo-Repo#5");
    // A fork or a shared repo name: no owner is guessed.
    expect(mergePrRef({ ...base, repo: "/src/twin", prNumber: 6 }, known)).toBe("twin#6");
    expect(mergePrRef({ ...base, prNumber: 7 }, known)).toBe("demo-repo#7");
  });
});

// ── Fix round 1 ─────────────────────────────────────────────────────────────

const idsOf = (p: GraphPayload, lane: GraphLane) => p.nodes.filter((n) => n.lane === lane).map((n) => n.id).sort();

describe("fix round 1: PR identity, bookkeeping pages, junk refs, unconfirmed merges", () => {
  test("S1: a URL-less merge row lands on the page's own PR node (basename + number, any case), with both edges", async () => {
    const p = ok((await graph({ scope: "page", root: "dup.md", depth: 2, level: 3 })).res);
    const prs = idsOf(p, "pr");
    expect(prs).toContain("pr:example-org/demo-repo#51");
    expect(prs).not.toContain("pr:demo-repo#51");
    expect(prs.filter((id) => id.endsWith("#51"))).toHaveLength(1);
    const to51 = p.edges.filter((e) => e.target === "pr:example-org/demo-repo#51").map((e) => e.kind).sort();
    expect(to51).toEqual(["page-pr", "session-pr"]);
    // No page names #52: the `<basename>#n` fallback.
    expect(prs).toContain("pr:other-repo#52");
  });

  test("S2: bookkeeping pages (log, index) are never page nodes, even when a PR or a session reaches them", async () => {
    for (const depth of [2, 4]) {
      const p = ok((await graph({ scope: "page", root: "dup.md", depth, level: 3 })).res);
      expect(idsOf(p, "page")).toEqual(["page:dup.md"]);
    }
    const root = (await graph({ scope: "page", root: "log.md", level: 3 })).res;
    expect(root.ok).toBe(false);
  });

  test("S6: junk session refs are not drawn and do not count toward the session cap", async () => {
    const p = ok((await graph({ scope: "page", root: "dup.md", depth: 1, level: 2 })).res);
    expect(idsOf(p, "session")).toEqual([`session:${S5}`]);
    const cap = ok((await graph({ scope: "page", root: "cap-junk.md", depth: 1, level: 2 })).res);
    expect(cap.truncated).toBeUndefined();
    expect(idsOf(cap, "session")).toHaveLength(GRAPH_SESSIONS_MAX);
    expect(idsOf(cap, "session")).not.toContain("session:see notes");
  });

  test("S7: a merge row the merge command never confirmed qualifies its PR node", async () => {
    const p = ok((await graph({ scope: "page", root: "dup.md", depth: 2, level: 3 })).res);
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    expect(byId.get("pr:example-org/demo-repo#53")).toMatchObject({ mergeUnconfirmed: true });
    expect(byId.get("pr:example-org/demo-repo#51")).not.toHaveProperty("mergeUnconfirmed");
  });
});

describe("fix round 1: the merges leg's own state", () => {
  test("S4: a merges leg that asked nothing (every id refused) is not a ledger that did not answer", async () => {
    const port = fakePort();
    port.merges = async () => ({ asked: false, reachable: false, partial: false, truncated: false, merges: [] });
    const p = ok((await graph({ scope: "page", root: "dup.md", depth: 2, level: 3 }, port)).res);
    expect(p.ledger.reachable).toBe(true);
  });

  test("S5: a partial or truncated merges answer is carried to the payload", async () => {
    const port = fakePort();
    const inner = port.merges;
    port.merges = async (ids) => ({ ...(await inner(ids)), partial: true, truncated: true });
    const p = ok((await graph({ scope: "page", root: "dup.md", depth: 2, level: 3 }, port)).res);
    expect(p.ledger).toMatchObject({ mergesPartial: true, mergesTruncated: true });
    const clean = ok((await graph({ scope: "page", root: "dup.md", depth: 2, level: 3 })).res);
    expect(clean.ledger).toMatchObject({ mergesPartial: false, mergesTruncated: false });
  });

  test("S11: a ledger string field that is not a string reaches the node as null", async () => {
    const port = fakePort();
    const inner = port.facts;
    port.facts = async (ids) => {
      const r = await inner(ids);
      for (const id of ids) r.facts.set(id, { sessionId: id, first: 12345 as unknown as string, last: {} as unknown as string, host: 7 as unknown as string });
      return r;
    };
    const p = ok((await graph({ scope: "page", root: "anchor.md", depth: 1, level: 2 }, port)).res);
    const s = p.nodes.find((n) => n.lane === "session")!;
    expect(s).toMatchObject({ first: null, last: null });
  });
});

describe("fix round 1: the edge cap", () => {
  test("S3: past GRAPH_EDGES_MAX edges the answer is truncated by edges, at exactly the cap", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-graph-wide-"));
    roots.push(root);
    const keys = Array.from({ length: 70 }, (_, i) => `demo-${200 + i}`);
    for (let i = 0; i < 100; i++) {
      await writeFile(path.join(root, `p${i}.md`), `---\ntitle: Side ${i}\ntags: [${keys.join(", ")}]\n---\n\nBody.\n`, "utf8");
    }
    await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify(CONFIG), "utf8");
    const wide = (await getWikiIndex({ root, refresh: true }))!;
    const p = ok((await graph({ scope: "wiki" }, fakePort(), wide)).res);
    expect(p.nodes.length).toBe(170);
    expect(p.truncatedBy).toContain("edges");
    expect(p.edges.length).toBe(graphTypes.GRAPH_EDGES_MAX);
  });
});

describe("fix round 1: issue roots", () => {
  test("S9/T3: a root that is not `tracker:KEY` shaped is a 400 naming root", () => {
    for (const root of ["DEMO-203", "JIRA:DEMO-203", "jira:DEMO-203:x", "jira:", ":DEMO-203", "jira:DEMO 203"]) {
      const r = parseGraphQuery({ scope: "issue", root });
      expect(r.ok, root).toBe(false);
      if (!r.ok) expect(r.error, root).toContain("root");
    }
    expect(parseIssueRoot("jira:DEMO-203")).toEqual({ tracker: "jira", key: "DEMO-203" });
    expect(parseIssueRoot("jira:DEMO-203:x")).toBeNull();
  });

  test("S9: a well-shaped root the tracker cannot read as a key is a 400 naming root; an unknown key stays 404", async () => {
    const bad = (await graph({ scope: "issue", root: "jira:nope" })).res;
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.status).toBe(400);
      expect(bad.error).toContain("root");
    }
    const unknown = (await graph({ scope: "issue", root: "jira:DEMO-999" })).res;
    expect(!unknown.ok && unknown.status).toBe(404);
  });
});

// ── Fix round 2 ─────────────────────────────────────────────────────────────

describe("fix round 2", () => {
  test("D1: past the edge cap no node is drawn without the edge that reached it, and the walk stays deterministic", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-graph-orphan-"));
    roots.push(root);
    // A hub with 70 keys, 100 pages carrying all 70 plus one key of their own:
    // hop 1 exhausts the edge budget, hop 2 reaches 100 new issues.
    const shared = Array.from({ length: 70 }, (_, i) => `demo-${200 + i}`);
    await writeFile(path.join(root, "hub.md"), `---\ntitle: Hub\ntags: [${shared.join(", ")}]\n---\n\nBody.\n`, "utf8");
    for (let i = 0; i < 100; i++) {
      await writeFile(path.join(root, `p${i}.md`), `---\ntitle: Side ${i}\ntags: [${[...shared, `demo-${500 + i}`].join(", ")}]\n---\n\nBody.\n`, "utf8");
    }
    await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify(CONFIG), "utf8");
    const wide = (await getWikiIndex({ root, refresh: true }))!;
    const run = async () => ok((await graph({ scope: "page", root: "hub.md", depth: 3, level: 1 }, fakePort(), wide)).res);
    const p = await run();
    expect(p.truncatedBy).toEqual(["edges"]);
    expect(p.edges.length).toBe(graphTypes.GRAPH_EDGES_MAX);
    const touched = new Set(p.edges.flatMap((e) => [e.source, e.target]));
    const orphans = p.nodes.filter((n) => n.hop > 0 && !touched.has(n.id)).map((n) => n.id);
    expect(orphans).toEqual([]);
    const again = await run();
    expect(again.nodes.map((n) => n.id)).toEqual(p.nodes.map((n) => n.id));
    expect(again.edges).toEqual(p.edges);
  });

  test("N3: a merge row whose session id is not an id shape draws no session node", async () => {
    const port = fakePort();
    const inner = port.merges;
    port.merges = async (ids) => {
      const r = await inner(ids);
      const extra = r.merges.filter((m) => m.sessionId === S1).map((m) => ({ ...m, sessionId: "see notes" }));
      return { ...r, merges: [...r.merges, ...extra] };
    };
    const p = ok((await graph({ scope: "page", root: "anchor.md", depth: 3, level: 3 }, port)).res);
    expect(idsOf(p, "pr")).toContain("pr:example-org/demo-repo#21");
    expect(idsOf(p, "session")).not.toContain("session:see notes");
    expect(p.nodes.filter((n) => n.lane === "session" && n.sessionId.includes(" "))).toEqual([]);
  });

  test("M27: one confirmed and one unconfirmed merge row confirm the PR, in either order", async () => {
    for (const order of [
      [false, true],
      [true, false],
    ]) {
      const port = fakePort();
      const inner = port.merges;
      port.merges = async (ids) => {
        const r = await inner(ids);
        const s1 = r.merges.find((m) => m.sessionId === S1)!;
        const rest = r.merges.filter((m) => m.sessionId !== S1);
        return { ...r, merges: [...order.map((mergeOk) => ({ ...s1, mergeOk })), ...rest] };
      };
      const p = ok((await graph({ scope: "page", root: "anchor.md", depth: 2, level: 3 }, port)).res);
      const pr = p.nodes.find((n) => n.id === "pr:example-org/demo-repo#21")!;
      expect(pr, JSON.stringify(order)).not.toHaveProperty("mergeUnconfirmed");
    }
  });

  test("M28: a bookkeeping root answers 404", async () => {
    const res = (await graph({ scope: "page", root: "log.md", level: 3 })).res;
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(404);
      expect(res.error).toContain("bookkeeping");
    }
  });

  test("M7: scope=series never roots at a bookkeeping page of the series", async () => {
    const p = ok((await graph({ scope: "series", root: "demo-serie" })).res);
    expect(idsOf(p, "page")).not.toContain("page:serie-logg/log.md");
    expect(p.nodes.filter((n) => n.hop === 0).map((n) => n.id)).toEqual(["page:series/a.md", "page:series/b.md"]);
  });

  test("M26: a root the tracker cannot read as a key is echoed in the 400, bounded", async () => {
    const short = (await graph({ scope: "issue", root: "jira:nope" })).res;
    expect(!short.ok && short.status).toBe(400);
    if (!short.ok) expect(short.error).toContain("jira:nope");
    const long = (await graph({ scope: "issue", root: `jira:${"n".repeat(5000)}` })).res;
    expect(!long.ok && long.status).toBe(400);
    if (!long.ok) {
      expect(long.error).toContain("jira:nnnn");
      expect(long.error.length).toBeLessThan(200);
    }
  });
});
