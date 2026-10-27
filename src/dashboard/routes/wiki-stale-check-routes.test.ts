/**
 * The Stale check's model half through the real routes (PR 2a): the verdicts
 * on `GET /api/wiki/stale`, `POST /api/wiki/stale/check` (SSE, at most 10
 * calls, cached verdicts reused) and `POST /api/wiki/stale/verdict` (Still
 * true, Not a status), over a temp git wiki with a fake model and an
 * in-memory verdict store. Every refusal the two POSTs own, and their place
 * in the tool half. The database store is `src/db/wiki-stale-verdicts.test.ts`'s.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { __resetWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { __setReadonlyWikiRootsForTest, __setWikiReadonlyForTest } from "../../wiki/readonly.ts";
import {
  __setStaleModelForTest,
  __setStaleVerdictStoreForTest,
  CHECK_MAX_CALLS,
  memoryStaleVerdictStore,
  type StaleModel,
} from "../../wiki/stale-confirm.ts";
import { testTempDir } from "../../test/temp-dir.ts";
import { wikiRouteTable } from "../../test/wiki-route-table.ts";

const page = (title: string, body: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`;
const EXTRA_LINKERS = 12;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, "-c", "user.email=f@example.com", "-c", "user.name=f", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

/** The SSE body as `[event, data]` pairs. */
function sseEvents(text: string): [string, Record<string, any>][] {
  return text
    .split("\n\n")
    .map((block) => {
      const ev = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return ev && data ? ([ev, JSON.parse(data)] as [string, Record<string, any>]) : null;
    })
    .filter((x): x is [string, Record<string, any>] => !!x);
}

describe("the Stale check's verdict routes", () => {
  let root = "";
  let app: Hono;
  let prevExtra: string | undefined;
  let prevBots: string | undefined;
  let botsDir = "";
  let store = memoryStaleVerdictStore();
  const prompts: string[] = [];
  const model: StaleModel = async (prompt) => {
    prompts.push(prompt);
    return prompt.includes("notes/old.md")
      ? '{"verdict":"stale","reason":"the pin moved","edit":{"old":"landed on 23.05","new":"landed on 18.06"}}'
      : '{"verdict":"true","reason":"still so"}';
  };

  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-stale-check-"));
    botsDir = await testTempDir(path.join(tmpdir(), "wiki-stale-check-bots-"));
    await mkdir(path.join(botsDir, "checkbot"), { recursive: true });
    await writeFile(path.join(botsDir, "checkbot", "CLAUDE.md"), "# checkbot\n");
    await writeFile(path.join(botsDir, "checkbot", "config.json"), JSON.stringify({ connector: "claude-cli" }));
    const write = async (rel: string, text: string) => {
      await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
      await writeFile(path.join(root, rel), text);
    };
    await git(root, "init", "-q", "-b", "main");
    await write("plans/p.md", page("P", "Body.", "plan_status: shipped\n"));
    await write("notes/old.md", page("Old", "The pin in [[hub]] landed on 23.05."));
    for (let i = 0; i < EXTRA_LINKERS; i++) await write(`notes/n${i}.md`, page(`N${i}`, `See [[hub]], updated 2${i % 9}.04.`));
    await write("hub.md", page("Hub", "- [[p]] is in-flight"));
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", "2026-05-01T10:00:00Z", "-m", "seed");
    await write("hub.md", page("Hub", "- [[p]] is in-flight\n\nMore."));
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", "2026-06-18T10:00:00Z", "-m", "hub: the pin moves to 18.06");
    prevExtra = process.env.WIKI_EXTRA;
    prevBots = process.env.MUNINN_BOTS_DIR;
    process.env.WIKI_EXTRA = `checkwiki=${root}=checkwiki=checkbot`;
    process.env.MUNINN_BOTS_DIR = botsDir;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
    __setStaleModelForTest(model);
  }, 30_000);

  afterAll(async () => {
    __setStaleModelForTest(null);
    __setStaleVerdictStoreForTest(null);
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    if (prevBots === undefined) delete process.env.MUNINN_BOTS_DIR;
    else process.env.MUNINN_BOTS_DIR = prevBots;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
    await rm(botsDir, { recursive: true, force: true });
  });

  afterEach(() => {
    __setWikiReadonlyForTest();
    __setReadonlyWikiRootsForTest();
  });

  const fresh = () => {
    store = memoryStaleVerdictStore();
    __setStaleVerdictStoreForTest(store);
    prompts.length = 0;
  };
  const get = async (query: string) => (await (await app.request(`/api/wiki/stale?${query}`)).json()) as Record<string, any>;
  const post = (route: string, body: unknown, contentType = "application/json") =>
    app.request(`/api/wiki/stale/${route}`, { method: "POST", headers: { "content-type": contentType }, body: JSON.stringify(body) });

  test("Check streams start, one verdict per page to check, done — at most 10 calls, the rest left", async () => {
    fresh();
    const res = await post("check", { wiki: "checkwiki", page: "hub.md", asOf: "2026-06-20" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = sseEvents(await res.text());
    const toCheck = EXTRA_LINKERS + 1;
    expect(events[0]).toEqual(["start", { type: "start", changed: "hub.md", toCheck, cached: 0, toCall: CHECK_MAX_CALLS, left: toCheck - CHECK_MAX_CALLS }]);
    const verdicts = events.filter(([e]) => e === "verdict").map(([, d]) => d);
    expect(verdicts).toHaveLength(CHECK_MAX_CALLS);
    expect(prompts).toHaveLength(CHECK_MAX_CALLS);
    expect(events.at(-1)).toEqual(["done", { type: "done", calls: CHECK_MAX_CALLS, verdicts: CHECK_MAX_CALLS, errors: 0, left: toCheck - CHECK_MAX_CALLS }]);
    expect(store.rows.size).toBe(CHECK_MAX_CALLS);
    expect([...new Set([...store.rows.values()].map((r) => `${r.kind} ${r.checkedBy}`))]).toEqual(["passage model:checkbot"]);
    // The prompt carries the changed page's commit subjects up to asOf.
    expect(prompts.some((p) => p.includes("hub: the pin moves to 18.06"))).toBe(true);

    // A second Check reuses the 10 and calls only the rest.
    const again = sseEvents(await (await post("check", { wiki: "checkwiki", page: "hub.md", asOf: "2026-06-20" })).text());
    expect(again[0]![1]).toMatchObject({ cached: CHECK_MAX_CALLS, toCall: toCheck - CHECK_MAX_CALLS, left: 0 });
    expect(again.filter(([e, d]) => e === "verdict" && d.cached)).toHaveLength(CHECK_MAX_CALLS);
    expect(prompts).toHaveLength(toCheck);
  });

  // A2: asOf cuts the commit subjects the call reads, so a verdict judged
  // under one asOf is not reused under another.
  test("A2: a Check under another asOf calls again, and the GET reads the verdicts of its own asOf", async () => {
    fresh();
    await (await post("check", { wiki: "checkwiki", page: "hub.md", asOf: "2026-06-20" })).text();
    expect(prompts).toHaveLength(CHECK_MAX_CALLS);
    const later = sseEvents(await (await post("check", { wiki: "checkwiki", page: "hub.md", asOf: "2026-06-25" })).text());
    expect(later[0]![1]).toMatchObject({ cached: 0, toCall: CHECK_MAX_CALLS });
    expect(prompts).toHaveLength(2 * CHECK_MAX_CALLS);
    const at20 = await get("wiki=checkwiki&page=hub.md&asOf=2026-06-20");
    const at25 = await get("wiki=checkwiki&page=hub.md&asOf=2026-06-25");
    const n = (b: Record<string, any>) => b.buckets.linking.filter((l: any) => l.verdict).length;
    expect([n(at20), n(at25)]).toEqual([CHECK_MAX_CALLS, CHECK_MAX_CALLS]);
    // The reader's verdict is keyed under the request's asOf too.
    fresh();
    expect((await post("verdict", { wiki: "checkwiki", page: "hub.md", kind: "passage", linking: "notes/n3.md", verdict: "true", asOf: "2026-06-25" })).status).toBe(200);
    expect(n(await get("wiki=checkwiki&page=hub.md&asOf=2026-06-25"))).toBe(1);
    expect(n(await get("wiki=checkwiki&page=hub.md&asOf=2026-06-20"))).toBe(0);
  });

  // A4: an answer that cannot be read is a failed call on the stream, never a cached unsure.
  test("A4: an unreadable answer streams an error and caches nothing; the next Check asks again", async () => {
    fresh();
    __setStaleModelForTest(async (prompt) => (prompts.push(prompt), "I would say stale, mostly."));
    try {
      const events = sseEvents(await (await post("check", { wiki: "checkwiki", page: "hub.md", asOf: "2026-06-20" })).text());
      expect(events.filter(([e]) => e === "verdict")).toHaveLength(0);
      const errs = events.filter(([e]) => e === "error").map(([, d]) => d.message);
      expect(errs).toHaveLength(CHECK_MAX_CALLS);
      expect(errs[0]).toContain("could not be read");
      expect(events.at(-1)![1]).toMatchObject({ verdicts: 0, errors: CHECK_MAX_CALLS });
      expect(store.rows.size).toBe(0);
      const again = sseEvents(await (await post("check", { wiki: "checkwiki", page: "hub.md", asOf: "2026-06-20" })).text());
      expect(again[0]![1]).toMatchObject({ cached: 0, toCall: CHECK_MAX_CALLS });
    } finally {
      __setStaleModelForTest(model);
    }
  });

  // A5: a reader's Still true that lands while the call runs is the verdict the stream reports.
  test("A5: a model answer on a key a reader decided keeps and streams the reader's verdict", async () => {
    fresh();
    for (let i = 0; i < 2; i++) await (await post("check", { wiki: "checkwiki", page: "hub.md", asOf: "2026-06-20" })).text();
    expect((await post("verdict", { wiki: "checkwiki", page: "hub.md", kind: "passage", linking: "notes/old.md", verdict: "true", asOf: "2026-06-20" })).status).toBe(200);
    // The Check reads the cache before the reader's click lands: it sees every row but the reader's.
    const racing = {
      ...store,
      get: async (...a: Parameters<typeof store.get>) => new Map([...(await store.get(...a))].filter(([, r]) => r.checkedBy !== "reader")),
    };
    __setStaleVerdictStoreForTest(racing);
    prompts.length = 0;
    const events = sseEvents(await (await post("check", { wiki: "checkwiki", page: "hub.md", asOf: "2026-06-20" })).text());
    __setStaleVerdictStoreForTest(store);
    expect(prompts).toHaveLength(1);
    const old = events.filter(([e, d]) => e === "verdict" && !d.cached).map(([, d]) => d);
    expect(old).toEqual([expect.objectContaining({ relPath: "notes/old.md", verdict: "true", edit: null })]);
    const row = [...store.rows.values()].find((r) => r.page === "notes/old.md")!;
    expect(row).toMatchObject({ verdict: "true", checkedBy: "reader" });
  });

  test("GET carries each To-check page's cached verdict and each hit's confirmation", async () => {
    fresh();
    let body = await get("wiki=checkwiki&page=hub.md&asOf=2026-06-20");
    expect(body.hits.map((h: any) => h.confirmation)).toEqual(["unconfirmed"]);
    expect(body.staleLines).toBe(0);
    expect(body.buckets.linking.some((l: any) => l.verdict)).toBe(false);
    // Two Checks: 13 pages to check, 10 calls a request.
    for (let i = 0; i < 2; i++) await (await post("check", { wiki: "checkwiki", page: "hub.md", asOf: "2026-06-20" })).text();
    body = await get("wiki=checkwiki&page=hub.md&asOf=2026-06-20");
    const old = body.buckets.linking.find((l: any) => l.relPath === "notes/old.md");
    expect(old.verdict).toMatchObject({ verdict: "stale", reason: "the pin moved", edit: { old: "landed on 23.05", new: "landed on 18.06" } });
  });

  test("a confirmed stale hit counts on the page and in the summary; Still true takes it back out", async () => {
    fresh();
    const hub = await get("wiki=checkwiki&page=hub.md&asOf=2026-06-20");
    const hit = hub.hits[0];
    // Confirm it the way the loop does: a stale row on the hit's key.
    const { statusLineKeyHash } = await import("../../wiki/stale-confirm.ts");
    await store.upsert({ wiki: "checkwiki", kind: "status-line", page: "hub.md", keyHash: statusLineKeyHash("hub.md", hit, { relPath: "plans/p.md", title: "P", planStatus: "shipped" }), verdict: "stale", reason: "shipped", edit: null, checkedBy: "model:checkbot" });
    expect((await get("wiki=checkwiki&page=hub.md&asOf=2026-06-20")).staleLines).toBe(1);
    const summary = await get("wiki=checkwiki&asOf=2026-06-20");
    expect(summary.totals).toMatchObject({ staleLines: 1, hits: 1 });
    expect(summary.pages.find((r: any) => r.relPath === "hub.md")).toMatchObject({ staleLines: 1, hits: 1 });

    const res = await post("verdict", { wiki: "checkwiki", page: "hub.md", kind: "status-line", line: hit.line, target: hit.target, verdict: "true" });
    expect(res.status).toBe(200);
    const after = await get("wiki=checkwiki&page=hub.md&asOf=2026-06-20");
    expect(after.hits[0].confirmation).toMatchObject({ verdict: "true", checkedBy: "reader" });
    expect(after.staleLines).toBe(0);
    expect((await get("wiki=checkwiki&asOf=2026-06-20")).totals.staleLines).toBe(0);
  });

  test("Not a status on a passage writes a reader row the GET then carries", async () => {
    fresh();
    const res = await post("verdict", { wiki: "checkwiki", page: "hub.md", kind: "passage", linking: "notes/n3.md", verdict: "not-status", asOf: "2026-06-20" });
    expect(res.status).toBe(200);
    const body = await get("wiki=checkwiki&page=hub.md&asOf=2026-06-20");
    expect(body.buckets.linking.find((l: any) => l.relPath === "notes/n3.md").verdict).toMatchObject({ verdict: "not-status", checkedBy: "reader" });
    expect(store.rows.size).toBe(1);
  });

  test("the verdict route takes only true / not-status, a known kind, and a real hit or page to check", async () => {
    fresh();
    expect((await post("verdict", { wiki: "checkwiki", page: "hub.md", kind: "status-line", line: 5, verdict: "stale" })).status).toBe(400);
    expect((await post("verdict", { wiki: "checkwiki", page: "hub.md", kind: "other", verdict: "true" })).status).toBe(400);
    expect((await post("verdict", { wiki: "checkwiki", page: "hub.md", kind: "status-line", line: 99, verdict: "true" })).status).toBe(404);
    expect((await post("verdict", { wiki: "checkwiki", page: "hub.md", kind: "passage", linking: "plans/p.md", verdict: "true", asOf: "2026-06-20" })).status).toBe(404);
    expect(store.rows.size).toBe(0);
  });

  test("both POSTs refuse: not JSON, readonly instance, readonly root (egress), unknown wiki, no page — before any call", async () => {
    fresh();
    const body = { wiki: "checkwiki", page: "hub.md", asOf: "2026-06-20" };
    for (const route of ["check", "verdict"]) {
      expect((await post(route, body, "text/plain")).status).toBe(415);
      __setWikiReadonlyForTest(true);
      const ro = await post(route, body);
      expect(ro.status).toBe(403);
      expect(((await ro.json()) as any).readonly).toBe(true);
      __setWikiReadonlyForTest();
      __setReadonlyWikiRootsForTest([root]);
      const rr = await post(route, body);
      expect(rr.status).toBe(403);
      expect(((await rr.json()) as any).error).toContain("WIKI_READONLY_ROOTS");
      __setReadonlyWikiRootsForTest();
      expect((await post(route, { ...body, wiki: "nope" })).status).toBe(404);
      expect((await post(route, { wiki: "checkwiki" })).status).toBe(400);
      expect((await post(route, { ...body, asOf: "yesterday" })).status).toBe(400);
    }
    expect(prompts).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });

  test("Check on a page that is not changed answers app_error on the stream and calls nothing", async () => {
    fresh();
    const events = sseEvents(await (await post("check", { wiki: "checkwiki", page: "hub.md", asOf: "2026-09-01" })).text());
    expect(events.map(([e]) => e)).toEqual(["app_error"]);
    expect(events[0]![1].message).toContain("not a changed page");
    expect(prompts).toHaveLength(0);
  });

  test("a verdict store that fails leaves the GET answering, every hit unconfirmed", async () => {
    __setStaleVerdictStoreForTest({ get: async () => Promise.reject(new Error("db down")), upsert: async () => Promise.reject(new Error("db down")) });
    const body = await get("wiki=checkwiki&page=hub.md&asOf=2026-06-20");
    expect(body.verdicts).toBe("unavailable");
    expect(body.hits[0].confirmation).toBe("unconfirmed");
    const summary = await get("wiki=checkwiki&asOf=2026-06-20");
    expect(summary).toMatchObject({ verdicts: "unavailable", totals: { staleLines: 0, hits: 1 } });
  });

  test("both POSTs are tool-half routes, so MUNINN_PROFILE=nais drops them", () => {
    for (const p of ["/api/wiki/stale/check", "/api/wiki/stale/verdict"]) {
      expect(wikiRouteTable("tools").some((r) => r.method === "POST" && r.path === p)).toBe(true);
      expect(wikiRouteTable("read").some((r) => r.path === p)).toBe(false);
    }
  });
});
