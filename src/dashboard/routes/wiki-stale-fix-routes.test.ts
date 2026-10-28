/**
 * The Stale check's fix paths through the real routes (PR 3): `POST
 * /api/wiki/stale/apply` (one page write through the queue, a `fixed`
 * verdict), `POST /api/wiki/stale/send` (a Stale check card, D20) and what
 * `GET /api/wiki/stale` says afterwards (the counts drop, the ⧗ fixes in
 * review), over a temp git wiki of synthetic pages with an in-memory verdict
 * store and proposal store. Verdict rows are seeded under keys the server's
 * own key functions derive; no model is called.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { __resetWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest, getWikiIndex } from "../../wiki/store.ts";
import { __resetWikiWriteQueueForTest } from "../../wiki/queue.ts";
import { __setReadonlyWikiRootsForTest, __setWikiReadonlyForTest } from "../../wiki/readonly.ts";
import { linkingBuckets } from "../../wiki/stale.ts";
import {
  __setStaleVerdictStoreForTest,
  changedHashOf,
  memoryStaleVerdictStore,
  passageVerdictKey,
  statusLineVerdictKey,
} from "../../wiki/stale-confirm.ts";
import { __setStaleProposalStoreForTest } from "../../gardener/stale-proposals.ts";
import { memoryStaleProposalStore } from "../../test/stale-proposal-store.ts";
import { STALE_FIX_CUTS_LINK, STALE_FIX_NOT_IN_PASSAGE } from "../../wiki/stale-fix.ts";
import { decideZone } from "../../auth/zones.ts";
import { wikiRouteTable } from "../../test/wiki-route-table.ts";
import { testTempDir } from "../../test/temp-dir.ts";

const DAY = 86_400_000;
const page = (title: string, body: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`;
const HUB_LINE = "- [[p]] is in-flight, two PRs open";
const A_TEXT = page("A", "The pin in [[hub]] landed on 23.05.");
const B_TEXT = page("B", "Since [[hub]] moved on 2.06 the pin is draft.");
const C_TEXT = page("C", "The lock in [[hub]] was set on 3.05, see [[p]] for it.");

async function git(cwd: string, atMs: number, ...args: string[]): Promise<void> {
  const date = new Date(atMs).toISOString();
  const proc = Bun.spawn(["git", "-C", cwd, "-c", "user.email=f@example.com", "-c", "user.name=f", "-c", "commit.gpgsign=false", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

describe("the Stale check's fix routes", () => {
  let root = "";
  let plainRoot = "";
  let app: Hono;
  let prevExtra: string | undefined;
  let verdicts = memoryStaleVerdictStore();
  let proposals = memoryStaleProposalStore();
  const write = async (rel: string, text: string, at = root) => {
    await mkdir(path.join(at, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(at, rel), text);
  };
  const read = (rel: string) => readFile(path.join(root, rel), "utf8");

  /** A fresh wiki: hub.md changed a day ago (a status-line hit), three older
   *  linking pages To check. Re-made per test, so writes never leak. */
  async function seedWiki(): Promise<void> {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    const now = Date.now();
    await git(root, now, "init", "-q", "-b", "main");
    // A repo-local identity: the Apply's commit tail runs plain `git commit`,
    // and a runner has no global one (commit.test.ts does the same).
    await git(root, now, "config", "user.email", "f@example.com");
    await git(root, now, "config", "user.name", "f");
    await git(root, now, "config", "commit.gpgsign", "false");
    await write("plans/p.md", page("P", "The plan.", "plan_status: shipped\n"));
    await write("hub.md", page("Hub", "First."));
    await write("notes/a.md", A_TEXT);
    await write("notes/b.md", B_TEXT);
    await write("notes/c.md", C_TEXT);
    await git(root, now - 30 * DAY, "add", "-A");
    await git(root, now - 30 * DAY, "commit", "-q", "-m", "seed");
    await write("hub.md", page("Hub", `${HUB_LINE}\n\nThe pin moved to 18.06.`));
    await git(root, now - DAY, "add", "-A");
    await git(root, now - DAY, "commit", "-q", "-m", "hub: the pin moves");
    __resetWikiCacheForTest();
    __resetWikiWriteQueueForTest();
    verdicts = memoryStaleVerdictStore();
    proposals = memoryStaleProposalStore();
    __setStaleVerdictStoreForTest(verdicts);
    __setStaleProposalStoreForTest(proposals);
  }

  /** Seed a model `stale` verdict with `edit` for a passage on hub.md, under the server's key. */
  async function seedPassage(linking: string, edit: { old: string; new: string; home?: string }): Promise<void> {
    const index = (await getWikiIndex({ root }))!;
    const buckets = (await linkingBuckets(index, "hub.md"))!;
    const l = buckets.linking.find((x) => x.relPath === linking)!;
    const hash = (await changedHashOf(index, "hub.md"))!;
    await verdicts.upsert({ wiki: "fixwiki", kind: "passage", page: linking, keyHash: passageVerdictKey(index, "hub.md", hash, l), verdict: "stale", reason: `${linking} is out of date`, edit, checkedBy: "model:e2e" });
  }

  async function seedHit(edit: { old: string; new: string; home?: string }): Promise<void> {
    const index = (await getWikiIndex({ root }))!;
    const hit = index.statusLineHits!.get("hub.md")![0]!;
    await verdicts.upsert({ wiki: "fixwiki", kind: "status-line", page: "hub.md", keyHash: statusLineVerdictKey(index, "hub.md", hit), verdict: "stale", reason: "the plan shipped", edit, checkedBy: "model:e2e" });
  }

  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-stale-fix-"));
    plainRoot = await testTempDir(path.join(tmpdir(), "wiki-stale-fix-plain-"));
    await write("hub.md", page("Hub", "First."), plainRoot);
    prevExtra = process.env.WIKI_EXTRA;
    // `fixwiki` has a search collection, so the Gardener lists its cards;
    // `plainwiki` has none, so Send refuses there.
    process.env.WIKI_EXTRA = `fixwiki=${root}=fixwiki,plainwiki=${plainRoot}`;
    __resetWikiRegistryForTest();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, { knowledgeApiUrl: "http://127.0.0.1:1" } as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterAll(async () => {
    __setStaleVerdictStoreForTest(null);
    __setStaleProposalStoreForTest(null);
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
    await rm(plainRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    __setWikiReadonlyForTest();
    __setReadonlyWikiRootsForTest();
  });

  const get = async (query: string) => (await (await app.request(`/api/wiki/stale?${query}`)).json()) as Record<string, any>;
  const post = (route: "apply" | "send", body: Record<string, unknown>) =>
    app.request(`/api/wiki/stale/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wiki: "fixwiki", page: "hub.md", variant: "new", ...body }) });
  const hubRow = (s: Record<string, any>) => (s.pages as Record<string, any>[]).find((r) => r.relPath === "hub.md")!;

  test("Apply on a status line writes the page and its log.md line, and the counts drop on the next read", async () => {
    await seedWiki();
    await seedHit({ old: "is in-flight, two PRs open", new: "is shipped" });
    expect((await get("wiki=fixwiki&page=hub.md")).staleLines).toBe(1);
    expect(hubRow(await get("wiki=fixwiki")).staleLines).toBe(1);
    const res = await post("apply", { kind: "status-line", target: "plans/p.md", line: 5, old: "is in-flight, two PRs open" });
    expect(res.status).toBe(200);
    // The commit tail ran (the temp wiki is a git repo), after the section.
    expect(await res.json()).toMatchObject({ ok: true, page: "hub.md", line: 5, committed: true });
    expect(await read("hub.md")).toBe(page("Hub", "- [[p]] is shipped\n\nThe pin moved to 18.06."));
    const log = await read("log.md");
    expect(log).toContain("stale-check | Hub");
    expect(log).toContain("line 5, stale after [[plans/p]], fixed via the wiki reader's Stale check");
    // The write refreshed the index: no hit, so no stale line, page or summary.
    expect((await get("wiki=fixwiki&page=hub.md")).staleLines).toBe(0);
    expect(hubRow(await get("wiki=fixwiki")).staleLines).toBe(0);
  });

  test("Apply on a passage writes the linking page, drops To check, and writes a `fixed` verdict on the new passage", async () => {
    await seedWiki();
    await seedPassage("notes/a.md", { old: "landed on 23.05", new: "landed on 18.06" });
    expect((await get("wiki=fixwiki&page=hub.md")).buckets.counts.toCheck).toBe(3);
    const res = await post("apply", { kind: "passage", linking: "notes/a.md", old: "landed on 23.05" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, page: "notes/a.md", fixed: 1 });
    expect(await read("notes/a.md")).toBe(A_TEXT.replace("landed on 23.05", "landed on 18.06"));
    const report = await get("wiki=fixwiki&page=hub.md");
    expect(report.buckets.counts.toCheck).toBe(2);
    expect(hubRow(await get("wiki=fixwiki")).toCheck).toBe(2);
    expect([...verdicts.rows.values()].filter((r) => r.kind === "fixed").map((r) => [r.page, r.verdict, r.checkedBy])).toEqual([["notes/a.md", "fixed", "reader"]]);
  });

  test("D29: a page whose date a later commit hides stays out of To check through its `fixed` verdict", async () => {
    await seedWiki();
    await seedPassage("notes/a.md", { old: "landed on 23.05", new: "landed on 18.06" });
    expect((await post("apply", { kind: "passage", linking: "notes/a.md", old: "landed on 23.05" })).status).toBe(200);
    // The Apply's own commit is re-dated a month back: the page reads as
    // older than hub.md again, which would put it back in To check.
    await git(root, Date.now() - 30 * DAY, "commit", "-q", "--amend", "--no-edit", "--reset-author");
    __resetWikiCacheForTest();
    const report = await get("wiki=fixwiki&page=hub.md");
    const a = report.buckets.linking.find((l: Record<string, any>) => l.relPath === "notes/a.md");
    expect(a).toMatchObject({ bucket: "changedSince", verdict: { verdict: "fixed" } });
    expect(report.buckets.counts.toCheck).toBe(2);
    expect(hubRow(await get("wiki=fixwiki")).toCheck).toBe(2);
    // Without the verdict the same page is To check again: the row is what holds it.
    verdicts.rows.forEach((r, k) => r.kind === "fixed" && verdicts.rows.delete(k));
    __resetWikiCacheForTest();
    expect((await get("wiki=fixwiki&page=hub.md")).buckets.counts.toCheck).toBe(3);
  });

  test("a line shift between the draft and the apply still lands on the right line", async () => {
    await seedWiki();
    await seedPassage("notes/a.md", { old: "landed on 23.05", new: "landed on 18.06" });
    await write("notes/a.md", A_TEXT.replace("The pin", "A new first line.\n\nThe pin"));
    const res = await post("apply", { kind: "passage", linking: "notes/a.md", old: "landed on 23.05" });
    expect(res.status).toBe(200);
    expect((await res.json()).line).toBe(7);
    expect(await read("notes/a.md")).toBe(page("A", "A new first line.\n\nThe pin in [[hub]] landed on 18.06."));
  });

  test("Apply refuses an edit that cuts a link, and one whose old is not once in the passage — the page untouched", async () => {
    await seedWiki();
    // Stored verdicts that skipped the parse rule: Apply re-validates on the live file.
    await seedPassage("notes/c.md", { old: "p]] for it", new: "it" });
    let res = await post("apply", { kind: "passage", linking: "notes/c.md", old: "p]] for it" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: STALE_FIX_CUTS_LINK, refused: true });
    await seedPassage("notes/c.md", { old: "e", new: "E" });
    res = await post("apply", { kind: "passage", linking: "notes/c.md", old: "e" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(STALE_FIX_NOT_IN_PASSAGE);
    expect(await read("notes/c.md")).toBe(C_TEXT);
    await expect(read("log.md")).rejects.toThrow();
  });

  test("Apply refuses: a fix that changed since the tab loaded, no drafted fix, a page a Gardener card holds, a readonly instance or root", async () => {
    await seedWiki();
    await seedPassage("notes/a.md", { old: "landed on 23.05", new: "landed on 18.06" });
    expect((await post("apply", { kind: "passage", linking: "notes/a.md", old: "something else" })).status).toBe(409);
    expect((await post("apply", { kind: "passage", linking: "notes/b.md", old: "x" })).status).toBe(404);
    expect((await post("apply", { kind: "passage", linking: "notes/a.md", old: "landed on 23.05", variant: "home" })).status).toBe(409);
    proposals.rows.push({ id: "l1", botName: "fixwiki", wikiName: "fixwiki", topicKey: "lint:x:1:notes/a.md", groupKey: "lint:x:1", lintMeta: null, kind: "lint", mode: "update", targetPath: "notes/a.md", baseHash: "h", draft: "", sourceDocs: [], rationale: null, containedLinks: null, relatedPages: null, status: "draft", createdAt: 0, resolvedAt: null });
    const held = await post("apply", { kind: "passage", linking: "notes/a.md", old: "landed on 23.05" });
    expect(held.status).toBe(409);
    expect((await held.json()).error).toContain("held by another Gardener card");
    proposals.rows.length = 0;
    __setWikiReadonlyForTest(true);
    expect((await post("apply", { kind: "passage", linking: "notes/a.md", old: "landed on 23.05" })).status).toBe(403);
    expect((await post("send", { kind: "passage", linking: "notes/a.md", old: "landed on 23.05" })).status).toBe(403);
    __setWikiReadonlyForTest();
    __setReadonlyWikiRootsForTest([root]);
    expect((await post("apply", { kind: "passage", linking: "notes/a.md", old: "landed on 23.05" })).status).toBe(403);
    expect((await post("send", { kind: "passage", linking: "notes/a.md", old: "landed on 23.05" })).status).toBe(403);
    __setReadonlyWikiRootsForTest();
    expect(await read("notes/a.md")).toBe(A_TEXT);
    // Not JSON: the 415 gate.
    const plain = await app.request("/api/wiki/stale/apply", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(plain.status).toBe(415);
  });

  test("Send on two linking pages leaves ONE live card holding both; the page and summary show ⧗ 2 in review", async () => {
    await seedWiki();
    await seedPassage("notes/a.md", { old: "landed on 23.05", new: "landed on 18.06" });
    await seedPassage("notes/b.md", { old: "the pin is draft", new: "the pin is shipped" });
    const first = await post("send", { kind: "passage", linking: "notes/a.md", old: "landed on 23.05" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, groupKey: "stale-check:hub.md:1", supersedes: null, pages: ["notes/a.md"] });
    const second = await post("send", { kind: "passage", linking: "notes/b.md", old: "the pin is draft" });
    expect(await second.json()).toMatchObject({ ok: true, groupKey: "stale-check:hub.md:2", supersedes: "stale-check:hub.md:1", pages: ["notes/a.md", "notes/b.md"], fixes: 2 });
    const live = proposals.rows.filter((r) => r.status === "draft");
    expect(live.map((r) => [r.groupKey, r.targetPath])).toEqual([["stale-check:hub.md:2", "notes/a.md"], ["stale-check:hub.md:2", "notes/b.md"]]);
    // Nothing is written by a Send.
    expect(await read("notes/a.md")).toBe(A_TEXT);
    const report = await get("wiki=fixwiki&page=hub.md");
    expect(report.inReview).toMatchObject({ fixes: 2, groupKey: "stale-check:hub.md:2" });
    const summary = await get("wiki=fixwiki");
    expect(hubRow(summary).inReview).toBe(2);
    expect(summary.totals.inReview).toBe(2);
    // The same fix again is already in review.
    expect((await post("send", { kind: "passage", linking: "notes/b.md", old: "the pin is draft" })).status).toBe(409);
  });

  test("Send refuses on a wiki the Gardener does not list", async () => {
    await seedWiki();
    const res = await app.request("/api/wiki/stale/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki: "plainwiki", page: "hub.md", kind: "passage", linking: "notes/a.md", variant: "new" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("no Gardener review page");
  });

  test("both POSTs are tool-half routes, and role `user` is denied them by default", () => {
    for (const p of ["/api/wiki/stale/apply", "/api/wiki/stale/send"]) {
      expect(wikiRouteTable("tools").some((r) => r.method === "POST" && r.path === p)).toBe(true);
      expect(wikiRouteTable("read").some((r) => r.path === p)).toBe(false);
      expect(decideZone({ method: "POST", path: p, role: "user" }).allowed).toBe(false);
      expect(decideZone({ method: "POST", path: p, role: "admin" }).allowed).toBe(true);
    }
  });
});
