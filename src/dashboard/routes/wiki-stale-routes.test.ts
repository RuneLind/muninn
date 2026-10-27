/**
 * `GET /api/wiki/stale` — the Stale check's free half — and the `movedWith`
 * rows `GET /api/wiki/page` ships, driven through the real routes over a temp,
 * git-backed wiki. The rules themselves are `src/wiki/stale.test.ts`'s; this
 * pins the route's shapes, its refusals and the tool-half placement.
 */

import { test, expect, describe, beforeAll, afterAll, setSystemTime } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { __resetWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { testTempDir } from "../../test/temp-dir.ts";
import { wikiRouteTable } from "../../test/wiki-route-table.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import { __setReadonlyWikiRootsForTest, __setWikiReadonlyForTest } from "../../wiki/readonly.ts";
import { __resetWorkSessionsForTest, refreshWorkSessions, workSessionsDepsFromEnv, workSessionsFor } from "../../wiki/work-sessions.ts";

const page = (title: string, body: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, "-c", "user.email=f@example.com", "-c", "user.name=f", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

describe("GET /api/wiki/stale", () => {
  let root = "";
  let app: Hono;
  let prevExtra: string | undefined;

  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-stale-route-"));
    const write = async (rel: string, text: string) => {
      await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
      await writeFile(path.join(root, rel), text);
    };
    await git(root, "init", "-q", "-b", "main");
    await write("plans/p.md", page("P", "Body.", "plan_status: shipped\n"));
    await write("notes/old.md", page("Old", "The pin in [[hub]] landed on 23.05."));
    await write("hub.md", page("Hub", "- [[p]] is in-flight"));
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", "2026-05-01T10:00:00Z", "-m", "seed");
    await write("hub.md", page("Hub", "- [[p]] is in-flight\n\nMore."));
    await write("plans/p.md", page("P", "Body two.", "plan_status: shipped\n"));
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", "2026-06-18T10:00:00Z", "-m", "hub and p");
    // A recent commit for the page route, whose «now» is the real clock.
    await write("hub.md", page("Hub", "- [[p]] is in-flight\n\nMore, again."));
    await write("notes/side.md", page("Side", "x"));
    await write("log.md", "# Log\n\n- hub and side\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", new Date(Date.now() - 86_400_000).toISOString(), "-m", "hub and side");
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `stalewiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  }, 30_000);

  afterAll(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  const get = async (query: string) => {
    const res = await app.request(`/api/wiki/stale?${query}`);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  test("with a page: hits, buckets for a changed page, Moved with", async () => {
    const { status, body } = await get("wiki=stalewiki&page=hub.md&asOf=2026-06-20");
    expect(status).toBe(200);
    expect(body.wiki).toBe("stalewiki");
    expect(body.readonly).toBe(false);
    expect(body.changed).toBe(true);
    expect(body.hits.map((h: any) => [h.line, h.target, h.now])).toEqual([[5, "plans/p.md", "shipped"]]);
    expect(body.buckets.counts.toCheck).toBe(1);
    expect(body.buckets.linking.map((l: any) => [l.relPath, l.bucket])).toEqual([["notes/old.md", "toCheck"]]);
    expect(body.movedWith.map((m: any) => [m.relPath, m.n])).toEqual([["plans/p.md", 1]]);
  });

  test("a page that is not changed as of asOf answers its hits and no buckets", async () => {
    const { body } = await get("wiki=stalewiki&page=hub&asOf=2026-08-01");
    expect(body.changed).toBe(false);
    expect(body.buckets).toBeNull();
    expect(body.hits).toHaveLength(1);
  });

  test("without a page: the wiki-wide summary with both counts", async () => {
    const { status, body } = await get("wiki=stalewiki&asOf=2026-06-20");
    expect(status).toBe(200);
    expect(body.totals).toEqual({ staleLines: 1, toCheck: 1, changedPages: 2 });
    expect(body.pages[0]).toMatchObject({ relPath: "hub.md", staleLines: 1, toCheck: 1, changed: true, dirty: false });
  });

  test("readonly names its cause: the instance, else this wiki's root (B4-3)", async () => {
    try {
      __setReadonlyWikiRootsForTest([root]);
      expect((await get("wiki=stalewiki&page=hub.md")).body.readonly).toBe("root");
      __setWikiReadonlyForTest(true);
      expect((await get("wiki=stalewiki&page=hub.md")).body.readonly).toBe("instance");
      __setReadonlyWikiRootsForTest();
      expect((await get("wiki=stalewiki")).body.readonly).toBe("instance");
    } finally {
      __setWikiReadonlyForTest();
      __setReadonlyWikiRootsForTest();
    }
    expect((await get("wiki=stalewiki")).body.readonly).toBe(false);
  });

  test("refusals: an unknown wiki, a bad asOf, an unknown page", async () => {
    expect((await get("wiki=nope")).status).toBe(404);
    expect((await get("wiki=stalewiki&asOf=yesterday")).status).toBe(400);
    expect((await get("wiki=stalewiki&page=missing.md")).status).toBe(404);
  });

  test("a session with no warm work memo answers found: false, not an error status", async () => {
    const { status, body } = await get("wiki=stalewiki&session=claude-code:abc");
    expect(status).toBe(200);
    expect(body.session).toMatchObject({ id: "claude-code:abc", found: false, pages: [] });
  });

  describe("with a claude-usage that answers", () => {
    let server: ReturnType<typeof Bun.serve>;
    let sessions: unknown[] = [];
    // While set, a sessions call answers what `sessions` held when it ARRIVED,
    // once the gate opens: a refresh in flight across a new write.
    let gate: Promise<void> | null = null;
    let calls = 0;
    let prevUrl: string | undefined;
    const sessionRow = (id: string, files: string[], provider = "claude") => ({
      id,
      provider,
      title: "t",
      first: Date.now() - 60_000,
      last: Date.now() - 1_000,
      bulk: false,
      text: { from: "title", paths: [], links: [], files: [] },
      files: files.map((p) => ({ p, edits: 1, firstMs: Date.now() - 60_000, lastMs: Date.now() - 1_000 })),
    });

    beforeAll(() => {
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          const q = new URL(req.url).searchParams;
          if (q.get("sessions") === "1") {
            calls++;
            const snap = sessions;
            if (gate) await gate;
            return Response.json({ form: "sessions", truncated: false, sessions: snap });
          }
          return Response.json({ pages: [], ...(q.has("until") ? { until: Number(q.get("until")) } : {}) });
        },
      });
      prevUrl = process.env.CLAUDE_USAGE_URL;
      process.env.CLAUDE_USAGE_URL = `http://127.0.0.1:${server.port}`;
    });

    afterAll(() => {
      server.stop(true);
      if (prevUrl === undefined) delete process.env.CLAUDE_USAGE_URL;
      else process.env.CLAUDE_USAGE_URL = prevUrl;
      __resetWorkSessionsForTest();
    });

    test("a session that wrote after the warm memo was taken is found, reserved pages dropped, with the memo's as-of", async () => {
      const index = await getWikiIndex({ root });
      // A memo taken before the session wrote anything: the idle-muninn case.
      sessions = [];
      await refreshWorkSessions(index!.root, workSessionsDepsFromEnv());
      expect(workSessionsFor(index!.root)?.sessions).toEqual([]);
      sessions = [sessionRow("abc", ["hub.md", "log.md", "notes/side.md", "gone.md"])];
      const { status, body } = await get("wiki=stalewiki&session=claude-code:abc");
      expect(status).toBe(200);
      expect(body.session).toMatchObject({ id: "claude-code:abc", found: true, truncated: false });
      expect(body.session.pages).toEqual(["hub.md", "notes/side.md"]);
      expect(typeof body.session.asOfMs).toBe("number");
      expect(Date.now() - body.session.asOfMs).toBeLessThan(10_000);
    });

    test("a write after a fresh memo that already holds the session is in the answer (R2-3)", async () => {
      __resetWorkSessionsForTest();
      const index = await getWikiIndex({ root });
      // The session wrote hub.md; a memo is taken (an index-build kick, or an
      // earlier session request); then it writes notes/side.md, and the
      // handoff asks within 30 s.
      sessions = [sessionRow("abc", ["hub.md"])];
      await refreshWorkSessions(index!.root, workSessionsDepsFromEnv());
      expect(workSessionsFor(index!.root)?.sessions.map((s) => s.id)).toEqual(["abc"]);
      sessions = [sessionRow("abc", ["hub.md", "notes/side.md"])];
      const { body } = await get("wiki=stalewiki&session=claude-code:abc");
      expect(body.session.pages).toEqual(["hub.md", "notes/side.md"]);
      expect(body.session.refreshTimedOut).toBeUndefined();
    });

    test("a refresh in flight from before the request is not joined: a new one answers (R2-3)", async () => {
      __resetWorkSessionsForTest();
      const index = await getWikiIndex({ root });
      sessions = [sessionRow("abc", ["hub.md"])];
      let open!: () => void;
      gate = new Promise<void>((r) => (open = r));
      const before = calls;
      const old = refreshWorkSessions(index!.root, workSessionsDepsFromEnv());
      while (calls === before) await Bun.sleep(5);
      sessions = [sessionRow("abc", ["hub.md", "notes/side.md"])];
      const asked = get("wiki=stalewiki&session=claude-code:abc");
      await Bun.sleep(50);
      gate = null;
      open();
      await old;
      const { body } = await asked;
      expect(body.session.pages).toEqual(["hub.md", "notes/side.md"]);
    });

    test("a session whose ledger provider is empty matches on its bare id (R2-3)", async () => {
      __resetWorkSessionsForTest();
      sessions = [sessionRow("abc", ["hub.md"], "")];
      for (const ref of ["abc", "claude-code:abc"]) {
        const { body } = await get(`wiki=stalewiki&session=${ref}`);
        expect([ref, body.session.found, body.session.pages]).toEqual([ref, true, ["hub.md"]]);
      }
    });
  });

  test("the page payload carries movedWith rows", async () => {
    const res = await app.request("/api/wiki/page?wiki=stalewiki&relPath=hub.md");
    const body = (await res.json()) as Record<string, any>;
    // «Now» is the index's build time, so only the recent commit counts.
    expect(body.movedWith.map((m: any) => [m.relPath, m.movedN, m.title])).toEqual([["notes/side.md", 1, "Side"]]);
  });

  test("the page payload's Moved with answers as of the index's build, as the stale route does (F9b)", async () => {
    await getWikiIndex({ root });
    // A clock that moved after the build (here: back 30 days) does not move «now».
    setSystemTime(new Date(Date.now() - 30 * 86_400_000));
    try {
      const page = (await (await app.request("/api/wiki/page?wiki=stalewiki&relPath=hub.md")).json()) as Record<string, any>;
      const { body: stale } = await get("wiki=stalewiki&page=hub.md");
      expect(page.movedWith.map((m: any) => m.relPath)).toEqual(["notes/side.md"]);
      expect(page.movedWith.map((m: any) => [m.relPath, m.movedN])).toEqual(stale.movedWith.map((m: any) => [m.relPath, m.n]));
    } finally {
      setSystemTime();
    }
  });

  test("it is a tool-half route, so MUNINN_PROFILE=nais drops it", () => {
    expect(wikiRouteTable("tools").some((r) => r.method === "GET" && r.path === "/api/wiki/stale")).toBe(true);
    expect(wikiRouteTable("read").some((r) => r.path === "/api/wiki/stale")).toBe(false);
  });
});
