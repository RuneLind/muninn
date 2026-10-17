/**
 * The work facts on the wire: `/api/wiki/pages` carries each page's `work` and
 * the threads, `/api/wiki/page`'s `meta` carries the same `work` (the article
 * header and the rail chip read one value), and the outgoing, backlink and
 * related rows carry none. With no sessions memo, no `work` anywhere (D11).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { __resetWikiRegistryForTest, getWikiRegistry } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { __resetWorkSessionsForTest, refreshWorkSessions } from "../../wiki/work-sessions.ts";
import { WORK_WINDOW_MS } from "../../wiki/work-focus.ts";

const NOW = Date.now();
const SINCE = NOW - WORK_WINDOW_MS;

describe("work facts on the listing and the page", () => {
  let root = "";
  let app: Hono;
  let prevExtra: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-work-"));
    await mkdir(path.join(root, "plans"));
    await writeFile(path.join(root, "plans/a.mdx"), "---\ntitle: A — the work\n---\n\nSee [[b]].\n");
    await writeFile(path.join(root, "plans/b.mdx"), "---\ntitle: B\n---\n\nSee [[a]].\n");
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `workwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetWorkSessionsForTest();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterAll(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetWorkSessionsForTest();
    await rm(root, { recursive: true, force: true });
  });

  const get = async (url: string) => {
    const res = await app.request(url);
    expect(res.status).toBe(200);
    return res;
  };

  test("no sessions memo: no work field on any surface", async () => {
    expect(await (await get("/api/wiki/pages?wiki=workwiki")).text()).not.toContain('"work"');
    expect(await (await get("/api/wiki/page?wiki=workwiki&relPath=plans%2Fb.mdx")).text()).not.toContain('"work"');
  });

  test("a touched-only page: the header's meta and the rail's listing row carry the same work", async () => {
    const registered = getWikiRegistry().find((e) => e.name === "workwiki")!.root;
    const t = NOW - 3_600_000;
    await refreshWorkSessions(registered, {
      urlConfigured: true,
      baseUrl: "http://ledger.test",
      now: () => NOW,
      registry: async () => [{ name: "workwiki", root: registered }],
      fetchSessions: async () => ({
        form: "sessions",
        truncated: false,
        sessions: [
          // An earlier bulk pass holds b's first write, so s1 did not create it
          // (the file's birthtime is this test's run, inside the window).
          {
            id: "s0",
            provider: "claude",
            title: "Sweep",
            first: t - 7_200_000,
            last: t - 7_000_000,
            bulk: true,
            text: { from: "prompt", paths: [], links: [], files: [] },
            files: [{ p: "plans/b.mdx", edits: 1, firstMs: t - 7_200_000, lastMs: t - 7_000_000 }],
          },
          {
            id: "s1",
            provider: "claude",
            title: "Work on a",
            first: t,
            last: t + 60_000,
            bulk: false,
            text: { from: "prompt", paths: [], links: [], files: [] },
            files: [
              { p: "plans/a.mdx", edits: 9, firstMs: t, lastMs: t + 60_000 },
              { p: "plans/b.mdx", edits: 1, firstMs: t, lastMs: t + 30_000 },
            ],
          },
        ],
      }),
      fetchPreWindow: async (_root, until) => ({ until, truncated: false, pages: [{ p: "plans/b.mdx", w: SINCE - 86_400_000 }] }),
    });
    __resetWikiCacheForTest();

    const listing = (await (await get("/api/wiki/pages?wiki=workwiki")).json()) as {
      pages: Array<{ relPath: string; work?: { state: string } }>;
      work?: { threads: Array<{ key: string; touched: string[] }> };
    };
    const b = listing.pages.find((p) => p.relPath === "plans/b.mdx")!;
    expect(b.work).toMatchObject({ state: "T", preMs: SINCE - 86_400_000 });
    expect(listing.work!.threads).toMatchObject([{ key: "plans/a.mdx", touched: ["plans/b.mdx"] }]);

    const page = (await (await get("/api/wiki/page?wiki=workwiki&relPath=plans%2Fb.mdx")).json()) as {
      meta: { work?: unknown };
      outgoing: Array<{ work?: unknown }>;
      backlinks: Array<{ work?: unknown }>;
      related?: Array<{ work?: unknown }>;
    };
    expect(page.meta.work).toEqual(b.work);
    expect(page.outgoing.length + page.backlinks.length).toBeGreaterThan(0);
    for (const row of [...page.outgoing, ...page.backlinks, ...(page.related ?? [])]) expect(row.work).toBeUndefined();
  });
});

describe("grouping evidence on the listing", () => {
  let root = "";
  let app: Hono;
  let prevExtra: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-evidence-"));
    await mkdir(path.join(root, "plans"));
    // Two threads, one session each: `a` owns ABC-1 and names `c` in related:
    // (unquoted, so YAML alone would not read it); `c` names ABC-1 by its
    // stamped jira: line; both carry one series.
    await writeFile(
      path.join(root, "plans/a.mdx"),
      "---\ntitle: A\nseries: Work\nowns: [ABC-1]\nrelated: [[c]], [[nowhere]]\n---\n\nBody.\n",
    );
    await writeFile(path.join(root, "plans/c.mdx"), "---\ntitle: C\nseries: work\njira: [ABC-1]\n---\n\nBody.\n");
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `evwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetWorkSessionsForTest();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
    const registered = getWikiRegistry().find((e) => e.name === "evwiki")!.root;
    const t = NOW - 3_600_000;
    const s = (id: string, p: string, at: number) => ({
      id,
      provider: "claude",
      title: `Work on ${p}`,
      first: at,
      last: at + 60_000,
      bulk: false,
      text: { from: "prompt", paths: [], links: [], files: [] },
      files: [{ p, edits: 6, firstMs: at, lastMs: at + 60_000 }],
    });
    await refreshWorkSessions(registered, {
      urlConfigured: true,
      baseUrl: "http://ledger.test",
      now: () => NOW,
      registry: async () => [{ name: "evwiki", root: registered }],
      fetchSessions: async () => ({ form: "sessions", truncated: false, sessions: [s("s1", "plans/a.mdx", t), s("s2", "plans/c.mdx", t - 600_000)] }),
      fetchPreWindow: async (_root, until) => ({ until, truncated: false, pages: [] }),
    });
    __resetWikiCacheForTest();
  });

  afterAll(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetWorkSessionsForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("the versioned block rides IndexWork beside the unchanged thread array; pages carry no index-only fields", async () => {
    const res = await app.request("/api/wiki/pages?wiki=evwiki");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pages: Record<string, unknown>[];
      work: { threads: { key: string; pages: string[] }[]; evidence: Record<string, unknown> };
    };
    expect(body.work.threads.map((t) => t.pages)).toEqual([["plans/a.mdx"], ["plans/c.mdx"]]);
    expect(body.work.evidence).toEqual({
      version: 1,
      threads: { candidates: 2, shipped: 2 },
      relations: {
        complete: true,
        reasons: [],
        series: { "plans/a.mdx": "work", "plans/c.mdx": "work" },
        projects: {},
        related: [["plans/a.mdx", "plans/c.mdx"]],
        issues: [["ABC-1", "plans/a.mdx", "plans/c.mdx"]],
        ambiguousIssues: [],
        relatedSkipped: { skipped: 1, ambiguous: 0 },
      },
      contributions: {
        complete: true,
        reasons: [],
        rows: [
          ["claude:s1", "plans/a.mdx", "plans/a.mdx", "focus", 6, NOW - 3_600_000, NOW - 3_540_000],
          ["claude:s2", "plans/c.mdx", "plans/c.mdx", "focus", 6, NOW - 4_200_000, NOW - 4_140_000],
        ],
      },
    });
    for (const p of body.pages) for (const k of ["owns", "related", "relatedSkipped", "relatedAmbiguous"]) expect(p).not.toHaveProperty(k);
    const page = (await (await app.request("/api/wiki/page?wiki=evwiki&relPath=plans%2Fa.mdx")).json()) as { meta: Record<string, unknown> };
    for (const k of ["owns", "related", "relatedSkipped", "relatedAmbiguous"]) expect(page.meta).not.toHaveProperty(k);
  });
});
