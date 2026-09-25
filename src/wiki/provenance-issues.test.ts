/**
 * Connections' issue rows through the real index build: the widened gate, the
 * per-key map and plan coverage, the deferred rows `pageProvenance` joins, and
 * the ledger's cap. Synthetic keys (`DEMO`) and host (`example.invalid`).
 *
 * The second wiki carries the same pages with NO `trackers` block — the pin for
 * the rule that a wiki without a tracker keeps today's stamped-only behaviour:
 * no rows, no `issues` on the payload, the gate reading the stamped lines only.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetWikiCacheForTest, getWikiIndex, type WikiIndex } from "./store.ts";
import { hasProvenance, provenanceStripCertain } from "./provenance.ts";
import {
  ISSUE_LEDGER_CONCURRENCY,
  ISSUE_LEDGER_MAX,
  pageProvenance,
  resolveIssueRows,
  type ProvenanceContext,
} from "./provenance-service.ts";
import { isPlanPage, issueRowsFor } from "./trackers/rows.ts";
import { parseTrackersConfig } from "./trackers/index.ts";
import type { IssueFacts, IssueRow } from "./trackers/types.ts";
import { Hono } from "hono";
import { registerWikiRoutes } from "../dashboard/routes/wiki-routes.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "./registry-memo.ts";
import type { Config } from "../config.ts";

const url = (k: string) => `https://example.invalid/browse/${k}`;

const CONFIG = {
  // `type: plan` resolves only where the wiki's ontology names `plan` — the
  // kode-wiki's own `typeMap` does.
  typeMap: { plans: "plan" },
  trackers: [
    {
      id: "jira",
      projects: ["DEMO", "OTHER"],
      hosts: ["example.invalid"],
      frontmatterKeys: ["issue"],
      createdMarkers: ["opprettet"],
      planTitle: "plan(er|en)?(?!\\p{L})",
      planTitleExclude: "testplan",
      statusMap: { "Til Utvikle": "todo", Ferdig: "done" },
      ledgerProjects: ["DEMO"],
    },
  ],
};

const PAGES: Record<string, string> = {
  // Anchor-shaped: created three, two tags, one mention, a session line.
  "anchor.md":
    "---\ntitle: Rotårsak\ntags: [demo-120, demo-121]\nsessions: [claude-code:00000000-0000-4000-8000-000000000001]\n---\n\n" +
    `Jira opprettet: [DEMO-101](${url("DEMO-101")}), [DEMO-102](${url("DEMO-102")}) og [DEMO-103](${url("DEMO-103")}).\n\n` +
    "Se også DEMO-122.\n",
  // Inferred keys, no provenance lines at all.
  "inferred.md": "---\ntitle: DEMO-130 og DEMO-131 notater\n---\n\nIngen proveniens.\n",
  "explainer.html": "<!doctype html><html><head><title>DEMO-150 forklart</title></head><body></body></html>",
  // Plans: a title-keyed plan (by planTitle), a stem-only `type: plan`, an
  // `issue:`-only plan, and a plan TAGGED with a key it does not plan.
  "notes/demo-101-arbeidsplan.md": "---\ntitle: DEMO-101 arbeidsplan\n---\n\nPlan.\n",
  "notes/2026-01-11-demo-160-x.md": "---\ntitle: Utrulling\ntype: plan\n---\n\nPlan.\n",
  "plans/utrulling.md": "---\ntitle: Utrulling\nissue: DEMO-170\n---\n\nPlan.\n",
  "plans/kjoreplan.md": "---\ntitle: Kjøreplan\ntags: [demo-121]\n---\n\nPlan.\n",
  "notes/testplan.md": "---\ntitle: DEMO-102 testplan\n---\n\nNot a plan.\n",
  // Link only: demoted, opens no provenance.
  "linked.md": `---\ntitle: Lenket\n---\n\nEpic: [DEMO-190](${url("DEMO-190")}).\n`,
  // Stamped only.
  "stamped.md": "---\ntitle: Stemplet\njira: [DEMO-180]\n---\n\nBody.\n",
  // Many keys: past the ledger's per-page cap.
  "many.md": `---\ntitle: ${Array.from({ length: 11 }, (_, i) => `DEMO-${140 + i}`).join(" ")}\n---\n\nBody.\n`,
  // A non-ledger project.
  "other.md": "---\ntitle: OTHER-7 notater\n---\n\nBody.\n",
};

const roots: string[] = [];
let tracked: WikiIndex;
let plainIdx: WikiIndex;

async function build(withTrackers: boolean): Promise<WikiIndex> {
  const root = await mkdtemp(path.join(tmpdir(), "prov-issues-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(PAGES)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
  if (withTrackers) await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify(CONFIG), "utf8");
  return (await getWikiIndex({ root, refresh: true }))!;
}

beforeAll(async () => {
  tracked = await build(true);
  plainIdx = await build(false);
});
afterAll(async () => {
  __resetWikiCacheForTest();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const meta = (idx: WikiIndex, rel: string) => idx.resolveRelPath(rel)!;
const rowsOf = (idx: WikiIndex, rel: string) =>
  issueRowsFor(meta(idx, rel), idx.issueKeys, idx.readerConfig?.trackers ?? []);
const row = (rows: IssueRow[], key: string) => rows.find((r) => r.key === key)!;

function ctx(over: Partial<ProvenanceContext> = {}, ledger?: (path: string) => Promise<unknown>): ProvenanceContext {
  return {
    sessionLedger: {
      baseUrl: "http://ledger.test",
      urlConfigured: !!ledger,
      fetchSessions: async () => ({ sessions: [] }),
      fetchMerges: async () => ({ merges: [] }),
      fetchHandoff: async () => ({ available: false }),
      fetchMergesForPrs: async () => ({ merges: [], unmapped: [] }),
      ...(ledger ? { fetchIssueLedger: (p: string) => ledger(p) } : {}),
    },
    knowledgeApiUrl: "http://huginn.test",
    publicUrl: null,
    loadJiraIndex: async () => null,
    stampable: () => true,
    lookupIssues: async () =>
      new Map<string, IssueFacts>([
        ["DEMO-101", { title: "Første", status: "Til Utvikle", updated: "2026-01-02T03:04:05.000+0100" }],
        ["DEMO-102", { title: "Andre", status: "Ferdig", epicLink: "DEMO-100", epicSummary: "Epos" }],
        ["DEMO-103", { title: "Tredje", status: "Merkelig" }],
      ]),
    ...over,
  };
}

describe("the gate", () => {
  test("a counting inferred issue opens provenance; a link- or mention-only one does not", () => {
    expect(hasProvenance(meta(tracked, "inferred.md"))).toBe(true);
    expect(hasProvenance(meta(tracked, "explainer.html"))).toBe(true);
    expect(hasProvenance(meta(tracked, "linked.md"))).toBe(false);
    expect(provenanceStripCertain(meta(tracked, "inferred.md"))).toBe(true);
    expect(provenanceStripCertain({ prs: ["o/r#1"] })).toBe(false);
    expect(hasProvenance({ prs: ["o/r#1"] })).toBe(true);
  });

  test("on a wiki with no tracker the same pages answer from the stamped lines only", () => {
    expect(hasProvenance(meta(plainIdx, "inferred.md"))).toBe(false);
    expect(hasProvenance(meta(plainIdx, "explainer.html"))).toBe(false);
    expect(hasProvenance(meta(plainIdx, "stamped.md"))).toBe(true);
    expect(rowsOf(plainIdx, "stamped.md")).toEqual([]);
    expect(plainIdx.issueKeys?.size).toBe(0);
  });
});

describe("rows and coverage", () => {
  test("the anchor page: three created, two tags, one mention", () => {
    const rows = rowsOf(tracked, "anchor.md");
    expect(rows.map((r) => [r.key, r.relations[0]])).toEqual([
      ["DEMO-101", "created"],
      ["DEMO-102", "created"],
      ["DEMO-103", "created"],
      ["DEMO-120", "tag"],
      ["DEMO-121", "tag"],
      ["DEMO-122", "mention"],
    ]);
    expect(row(rows, "DEMO-101").url).toBe(url("DEMO-101"));
    expect(row(rows, "DEMO-101").field).toBe("jira");
  });

  test("a title-keyed plan covers; a plan TAGGED with a key does not; a testplan is no plan", () => {
    const rows = rowsOf(tracked, "anchor.md");
    expect(row(rows, "DEMO-101").planPages.map((p) => p.relPath)).toEqual(["notes/demo-101-arbeidsplan.md"]);
    expect(row(rows, "DEMO-121").planPages).toEqual([]);
    expect(row(rows, "DEMO-102").planPages).toEqual([]);
    expect(row(rows, "DEMO-121").pageCount).toBe(2);
  });

  test("the stem-only and the issue:-only plans cover their keys", () => {
    const stem = rowsOf(tracked, "notes/2026-01-11-demo-160-x.md");
    expect(stem.map((r) => [r.key, r.relations[0]])).toEqual([["DEMO-160", "stem"]]);
    expect(stem[0]!.planPages.length).toBe(1);
    const declared = rowsOf(tracked, "plans/utrulling.md");
    expect(declared.map((r) => [r.key, r.relations[0]])).toEqual([["DEMO-170", "declared"]]);
    expect(declared[0]!.planPages.length).toBe(1);
  });

  test("isPlanPage: type, the plans/ folder, or the title rule", () => {
    const [config] = parseTrackersConfig(CONFIG.trackers, () => {});
    expect(isPlanPage({ relPath: "a.md", title: "x", type: "plan" }, config!)).toBe(true);
    expect(isPlanPage({ relPath: "plans/a.md", title: "x", type: "note" }, config!)).toBe(true);
    expect(isPlanPage({ relPath: "a.md", title: "Arbeidsplan", type: "note" }, config!)).toBe(true);
    expect(isPlanPage({ relPath: "a.md", title: "Testplan", type: "note" }, config!)).toBe(false);
    expect(isPlanPage({ relPath: "a.md", title: "Planlegging", type: "note" }, config!)).toBe(false);
  });
});

describe("pageProvenance", () => {
  test("a markdown page with inferred keys and no provenance lines gets a block with rows", async () => {
    const p = await pageProvenance(meta(tracked, "inferred.md"), ctx(), undefined, tracked);
    expect(p?.issues?.map((r) => r.key)).toEqual(["DEMO-130", "DEMO-131"]);
    expect(p?.sessions).toEqual([]);
    expect(p?.jira).toEqual([]);
  });

  test("so does an .html page with a key in its <title>", async () => {
    const p = await pageProvenance(meta(tracked, "explainer.html"), ctx(), undefined, tracked);
    expect(p?.issues?.map((r) => [r.key, r.relations[0]])).toEqual([["DEMO-150", "title"]]);
  });

  test("the deferred row: status through the statusMap, unmapped is unknown, epic, updated, known", async () => {
    const p = await pageProvenance(meta(tracked, "anchor.md"), ctx(), undefined, tracked);
    const rows = p!.issues!;
    expect(row(rows, "DEMO-101")).toMatchObject({
      title: "Første",
      status: "Til Utvikle",
      category: "todo",
      updated: "2026-01-02T03:04:05.000+0100",
      known: true,
    });
    expect(row(rows, "DEMO-102")).toMatchObject({ category: "done", epic: { key: "DEMO-100", summary: "Epos" } });
    expect(row(rows, "DEMO-103").category).toBe("unknown");
    expect(row(rows, "DEMO-120")).toMatchObject({ known: false, category: "unknown" });
  });

  test("a lookup that degrades leaves the rows bare — no category, so no Draft plan", async () => {
    const p = await pageProvenance(meta(tracked, "anchor.md"), ctx({ lookupIssues: async () => null }), undefined, tracked);
    expect(p!.issues!.every((r) => r.category === undefined && r.known === undefined)).toBe(true);
  });

  test("a wiki with no tracker: no `issues` key on the payload at all", async () => {
    const p = await pageProvenance(meta(plainIdx, "stamped.md"), ctx(), undefined, plainIdx);
    expect(p).not.toBeNull();
    expect("issues" in p!).toBe(false);
    expect(p!.jira.map((j) => j.key)).toEqual(["DEMO-180"]);
  });
});

describe("the ledger", () => {
  test("priced per key; a demoted key is not asked; a project outside ledgerProjects is not tracked", async () => {
    const asked: string[] = [];
    const ledger = async (p: string) => {
      asked.push(p);
      return { key: "x", sessions: [{}, {}], totalCost: 12.345, costedSessions: 2, truncated: false, limit: 2000 };
    };
    const p = await pageProvenance(meta(tracked, "anchor.md"), ctx({}, ledger), undefined, tracked);
    const rows = p!.issues!;
    expect(row(rows, "DEMO-101").ledger).toEqual({ state: "priced", sessions: 2, totalCost: 12.35, costedSessions: 2, truncated: false });
    expect(row(rows, "DEMO-122").ledger).toEqual({ state: "unpriced", reason: "demoted" });
    expect(asked).toHaveLength(5);
    expect(asked[0]).toBe("/api/jira?key=DEMO-101");

    const other = await pageProvenance(meta(tracked, "other.md"), ctx({}, ledger), undefined, tracked);
    expect(other!.issues![0]!.ledger).toEqual({ state: "not-tracked" });
  });

  test(`at most ${ISSUE_LEDGER_MAX} keys a page, ${ISSUE_LEDGER_CONCURRENCY} in flight; the rest say why`, async () => {
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const ledger = async () => {
      calls++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { sessions: [], totalCost: 0, costedSessions: 0, truncated: false };
    };
    const p = await pageProvenance(meta(tracked, "many.md"), ctx({}, ledger), undefined, tracked);
    expect(calls).toBe(ISSUE_LEDGER_MAX);
    expect(peak).toBe(ISSUE_LEDGER_CONCURRENCY);
    const capped = p!.issues!.filter((r) => r.ledger?.state === "unpriced" && r.ledger.reason === "cap");
    expect(capped).toHaveLength(11 - ISSUE_LEDGER_MAX);
  });

  test("a ledger past the deadline renders without cost, and the payload still answers", async () => {
    const hang = () => new Promise<unknown>(() => {});
    const rows = rowsOf(tracked, "inferred.md");
    const [config] = tracked.readerConfig!.trackers!;
    const c = ctx({ budgetMs: 20 }, hang);
    const out = await resolveIssueRows(rows, [config!], c, AbortSignal.timeout(20));
    expect(out.map((r) => r.ledger)).toEqual([
      { state: "unpriced", reason: "deadline" },
      { state: "unpriced", reason: "deadline" },
    ]);
  });

  test("no ledger on this host: counting keys say `not-configured`", async () => {
    const p = await pageProvenance(meta(tracked, "inferred.md"), ctx(), undefined, tracked);
    expect(p!.issues!.map((r) => r.ledger)).toEqual([
      { state: "unpriced", reason: "not-configured" },
      { state: "unpriced", reason: "not-configured" },
    ]);
  });
});

describe("the page route", () => {
  let app: Hono;
  beforeAll(() => {
    __setWikiRegistryForTest([
      { name: "trk", root: tracked.root, source: "extra" },
      { name: "plain", root: plainIdx.root, source: "extra" },
    ]);
    app = new Hono();
    registerWikiRoutes(app, { knowledgeApiUrl: "http://huginn.test", claudeUsageUrl: null, claudeUsagePublicUrl: null } as Config, ctx());
  });
  afterAll(() => __resetWikiRegistryForTest());
  const get = async (q: string) => (await app.request(q)).json() as Promise<Record<string, unknown>>;

  test("inline rows + provenancePending for a page with only inferred keys, markdown and .html alike", async () => {
    for (const rel of ["inferred.md", "explainer.html"]) {
      const body = await get(`/api/wiki/page?wiki=trk&relPath=${rel}`);
      expect(body.provenancePending).toBe(true);
      expect((body.issueRows as IssueRow[]).length).toBeGreaterThan(0);
      expect(body.issueStampable).toBe(true);
      // The inline half carries no network-joined field.
      expect((body.issueRows as IssueRow[]).every((r) => r.category === undefined && r.ledger === undefined)).toBe(true);
    }
    const prov = await get("/api/wiki/page/provenance?wiki=trk&relPath=inferred.md");
    expect(((prov.provenance as { issues: IssueRow[] }).issues).map((r) => r.category)).toEqual(["unknown", "unknown"]);
  });

  test("a wiki with no tracker: no rows, no pending on an unstamped page, and the stamped page as before", async () => {
    const inferred = await get("/api/wiki/page?wiki=plain&relPath=inferred.md");
    expect("issueRows" in inferred).toBe(false);
    expect("provenancePending" in inferred).toBe(false);
    const stamped = await get("/api/wiki/page?wiki=plain&relPath=stamped.md");
    expect(stamped.provenancePending).toBe(true);
    expect("issueRows" in stamped).toBe(false);
    const prov = (await get("/api/wiki/page/provenance?wiki=plain&relPath=stamped.md")).provenance as Record<string, unknown>;
    expect("issues" in prov).toBe(false);
  });
});
