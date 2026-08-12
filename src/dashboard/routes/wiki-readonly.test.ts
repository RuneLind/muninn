import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { registerWikiGardenerRoutes } from "./wiki-gardener-routes.ts";
import { __resetWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { __resetWikiWriteQueueForTest } from "../../wiki/queue.ts";
import { __setWikiReadonlyForTest, isWikiReadonly, WIKI_READONLY_REASON } from "../../wiki/readonly.ts";
import { writeWikiPage } from "../../wiki/page-write.ts";
import { applyWikiProposal } from "../../gardener/apply.ts";
import { commitWikiChange, __resetForTest as __resetCommitForTest } from "../../wiki/commit.ts";
import { sha256 } from "../../gardener/util.ts";
import type { WikiProposal } from "../../db/wiki-proposals.ts";
import {
  isBlockedByReadonly,
  wikiReadonlyFlag,
  WIKI_READONLY_BLOCKED_SELECTOR,
} from "../views/components/wiki-readonly-client.ts";

/**
 * `MUNINN_WIKI_READONLY` — the wiki write-owner switch, tested at the three
 * levels it exists on:
 *
 *   1. The ROUTE guards — a gardener mutation route 403s before any DB/model work.
 *   2. The write SEAMS — `writeWikiPage` / `applyWikiProposal` return `forbidden`
 *      and touch nothing, and the fact-check append route maps that to a 403 with
 *      the file on disk byte-unchanged.
 *   3. The deliberate EXEMPTION — `commitWikiChange` still commits, because the
 *      readonly instance's repo-sync loop runs through it. A guard that also
 *      closed git would break the very thing the flag exists to enable.
 *
 * The flag is driven through `__setWikiReadonlyForTest` (never the process env),
 * so a crashing test can't leave the whole suite readonly.
 */

/** Run `git -C <cwd> <args…>`, returning trimmed stdout + exit code. */
async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  const code = await proc.exited;
  return { code, out };
}

/** A fixture repo with the wiki nested at repo/data/wiki (the real jarvis
 *  layout), one initial commit so HEAD + `main` exist. Mirrors commit.test.ts. */
async function makeRepo(base: string): Promise<{ repo: string; wikiDir: string }> {
  const repo = await mkdtemp(path.join(base, "repo-"));
  const wikiDir = path.join(repo, "data", "wiki");
  await mkdir(wikiDir, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "a@b.c"]);
  await git(repo, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(repo, "README.md"), "root\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  return { repo, wikiDir };
}

describe("MUNINN_WIKI_READONLY — routes", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;
  const PAGE = "# Widgets\n\nThe device ships 4M units.\n";

  const post = (path_: string, body?: unknown) =>
    app.request(path_, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const pageOnDisk = () => Bun.file(path.join(root, "Widgets.md")).text();
  const hashOf = async (rel: string) =>
    createHash("sha256").update(await Bun.file(path.join(root, rel)).text()).digest("hex");

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-readonly-route-"));
    await Bun.write(path.join(root, "Widgets.md"), PAGE);
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `rowiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetWikiWriteQueueForTest();
    app = new Hono();
    // Own error handler: the unguarded routes reach a DB call this suite has no
    // DB for, and Hono's default handler dumps that stack into the test output —
    // which reads like a failure. A 500 here is the "no guard ran" signal.
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
    registerWikiGardenerRoutes(app);
  });

  afterEach(async () => {
    __setWikiReadonlyForTest(); // release before anything else can observe it
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("a gardener mutation route 403s — before any bot/DB resolution", async () => {
    __setWikiReadonlyForTest(true);
    // `?wiki=rowiki` names a STANDALONE wiki, which `resolveBacklogBot` refuses
    // with its own 4xx — so a 403 here proves the guard ran FIRST.
    const res = await post("/api/wiki/gardener/backlog-run?wiki=rowiki");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; readonly: boolean };
    expect(body.readonly).toBe(true);
    expect(body.error).toBe(WIKI_READONLY_REASON);
  });

  test("every guarded gardener/atlas mutation route 403s", async () => {
    __setWikiReadonlyForTest(true);
    const routes: [string, unknown?][] = [
      ["/api/wiki/gardener/backlog-run?wiki=rowiki"],
      ["/api/wiki/gardener/source-draft-run?wiki=rowiki"],
      ["/api/wiki/gardener/source-draft-backlog?wiki=rowiki"],
      ["/api/wiki/gardener/source-draft-doc?wiki=rowiki", { collection: "youtube-summaries", id: "x" }],
      ["/api/wiki/proposals/00000000-0000-0000-0000-000000000000/approve"],
      ["/api/wiki/atlas/draft-synthesis?wiki=rowiki", { members: ["Widgets"], label: "Widgets" }],
      // The backlog state verbs: they mutate the write-owner's shared watcher
      // snapshots (offered / dismissed / the interrupted-run journal) and huginn
      // docs, so a readonly mini must not corrupt an in-flight drain it can't see.
      ["/api/wiki/gardener/backlog-reset?wiki=rowiki"],
      ["/api/wiki/gardener/backlog-cancel?wiki=rowiki"],
      ["/api/wiki/gardener/backlog-recover?wiki=rowiki"],
      ["/api/wiki/gardener/backlog-dismiss?wiki=rowiki"],
      ["/api/wiki/gardener/backlog-docs-dismiss?wiki=rowiki", { keys: ["youtube-summaries/x"] }],
      ["/api/wiki/gardener/backlog-docs-undismiss?wiki=rowiki", { keys: ["youtube-summaries/x"] }],
      ["/api/wiki/gardener/backlog-docs-dismiss-reset?wiki=rowiki"],
      ["/api/wiki/gardener/backlog-doc-delete?wiki=rowiki", { collection: "youtube-summaries", id: "x" }],
    ];
    for (const [url, body] of routes) {
      const res = await post(url, body);
      expect(`${url} → ${res.status}`).toBe(`${url} → 403`);
    }
  });

  test("a route refusal is logged — the seams warn, the routes were silent", async () => {
    // The two write SEAMS log their refusal, but a route guard answers BEFORE the
    // seam is reached, so every refused drafting/backlog POST left no trace at
    // all: "why did the mini do nothing?" was unanswerable from the logs.
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      __setWikiReadonlyForTest(true);
      const res = await post("/api/wiki/gardener/backlog-reset?wiki=rowiki");
      expect(res.status).toBe(403);
      const infos = records.filter((r) => r.level === "info");
      const hit = infos.find((r) => r.message.join("").includes("readonly"));
      expect(hit).toBeDefined();
      // The refusal must name WHICH route refused — one line per surface is the
      // only way to tell a guarded drafting POST from a guarded prune POST.
      expect(JSON.stringify(hit!.properties)).toContain("/api/wiki/gardener/backlog-reset");
    } finally {
      await reset();
    }
  });

  test("the fact-check integrate PROPOSE route 403s — before the ~90s one-shot", async () => {
    __setWikiReadonlyForTest(true);
    // Propose-only (it writes nothing), but its only consumer is the /apply route
    // this instance already 403s — so the one-shot could only ever be burnt for a
    // preview nothing can commit. Same rationale as the guarded drafting routes.
    // A stale baseHash is what this body would otherwise answer with (409), so a
    // 403 proves the guard ran first.
    const res = await post("/api/wiki/factcheck/integrate?wiki=rowiki", {
      page: "Widgets",
      answer: "### ❌ Claim 1/1 — Wrong\n\nNope.",
      baseHash: "deadbeef",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { readonly: boolean }).readonly).toBe(true);
    expect(await pageOnDisk()).toBe(PAGE);
  });

  test("without the flag the same route is NOT 403", async () => {
    __setWikiReadonlyForTest(false);
    const res = await post("/api/wiki/gardener/backlog-run?wiki=rowiki");
    // It fails for its OWN reason — `resolveBacklogBot` refuses a standalone
    // wiki. Asserting that concrete status (rather than "not 403") is what makes
    // this a control: a route that started answering 404, or 500 on a thrown DB
    // call, would also satisfy `not.toBe(403)` while proving nothing.
    expect(res.status).toBe(400);
  });

  test("reject is deliberately NOT guarded — it mutates no wiki", async () => {
    __setWikiReadonlyForTest(true);
    // No DB in this suite, so the route throws past its guard-free head; a 403
    // would mean a guard was added where the plan says there must not be one.
    const res = await post("/api/wiki/proposals/00000000-0000-0000-0000-000000000000/reject");
    // It runs past its (deliberately absent) guard into a DB call, which answers
    // 404 (no such proposal) when the local Postgres is up and 500 through the
    // fixture's onError when it is not — so the STATUS is a property of the
    // runner, not of this route. The stable, non-tautological assertion is on the
    // BODY: a readonly refusal is identified by `readonly: true` +
    // WIKI_READONLY_REASON, and neither may appear here. ("not 403" would also be
    // satisfied by a route that had stopped existing.)
    const body = (await res.json()) as { error?: string; readonly?: boolean };
    expect(body.readonly).toBeUndefined();
    expect(body.error).not.toBe(WIKI_READONLY_REASON);
    expect([404, 500]).toContain(res.status);
  });

  test("the fact-check append route 403s and the page is byte-unchanged", async () => {
    __setWikiReadonlyForTest(true);
    const res = await post("/api/wiki/factcheck/append?wiki=rowiki", {
      page: "Widgets",
      answer: "### ✅ Claim 1/1 — Right\n\nAll good.",
      baseHash: await hashOf("Widgets.md"),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { readonly: boolean }).readonly).toBe(true);
    expect(await pageOnDisk()).toBe(PAGE);
    // No log.md was created either — the seam refuses before it reads anything.
    expect(await Bun.file(path.join(root, "log.md")).exists()).toBe(false);
  });

  test("the integrate/apply route 403s and the page is byte-unchanged", async () => {
    __setWikiReadonlyForTest(true);
    const res = await post("/api/wiki/factcheck/integrate/apply?wiki=rowiki", {
      page: "Widgets",
      baseHash: await hashOf("Widgets.md"),
      edits: [{ claimIndex: 1, verdict: "❌", old: "ships 4M units", new: "ships 2.1M units", reason: "filing" }],
    });
    expect(res.status).toBe(403);
    expect(await pageOnDisk()).toBe(PAGE);
  });

  test("with the flag off the same append writes (the guard is the only difference)", async () => {
    __setWikiReadonlyForTest(false);
    const res = await post("/api/wiki/factcheck/append?wiki=rowiki", {
      page: "Widgets",
      answer: "### ✅ Claim 1/1 — Right\n\nAll good.",
      baseHash: await hashOf("Widgets.md"),
    });
    expect(res.status).toBe(200);
    expect(await pageOnDisk()).not.toBe(PAGE);
  });
});

describe("MUNINN_WIKI_READONLY — write seams", () => {
  afterEach(() => __setWikiReadonlyForTest());

  test("writeWikiPage returns `forbidden` and reads/writes nothing", async () => {
    __resetWikiWriteQueueForTest();
    const files: Record<string, string> = { "/wiki/page.md": "body\n" };
    const touched: string[] = [];
    const res = await writeWikiPage({
      wikiDir: "/wiki",
      relPath: "page.md",
      baseHash: sha256(files["/wiki/page.md"]!),
      transform: (c) => `${c}more\n`,
      collections: ["wiki"],
      logKind: "factcheck",
      logTitle: "Page",
      logLine: "line",
      commitMessage: "[fact-check] annotate: page.md",
      now: () => 0,
      readFile: async (p) => {
        touched.push(`read ${p}`);
        return files[p] ?? null;
      },
      writeFile: async (p, c) => {
        touched.push(`write ${p}`);
        files[p] = c;
      },
      refreshIndex: async () => {},
      reindex: async () => {},
      isReadonly: () => true,
    });
    expect(res.outcome).toBe("forbidden");
    expect(res.outcome === "forbidden" && res.reason).toBe(WIKI_READONLY_REASON);
    expect(touched).toEqual([]);
    expect(files["/wiki/page.md"]).toBe("body\n");
  });

  test("applyWikiProposal returns `forbidden` and never enters the write queue", async () => {
    __resetWikiWriteQueueForTest();
    const proposal = {
      id: "p1",
      botName: "jarvis",
      topicKey: "widgets",
      kind: "concept",
      mode: "create",
      targetPath: "concepts/Widgets.md",
      draft: "---\ntitle: Widgets\n---\n\nBody.\n",
      status: "approved",
    } as unknown as WikiProposal;
    let read = 0;
    const res = await applyWikiProposal(proposal, {
      wikiDir: "/wiki",
      now: () => 0,
      readFile: async () => {
        read++;
        return null;
      },
      writeFile: async () => {
        throw new Error("must not write");
      },
      getWikiIndex: async () => {
        read++;
        return null;
      },
      refreshIndex: async () => {},
      reindex: async () => {},
      isReadonly: () => true,
    });
    expect(res.outcome).toBe("forbidden");
    expect(read).toBe(0);
  });

  test("the seams default to the shared flag — a caller that passes nothing is still guarded", async () => {
    __resetWikiWriteQueueForTest();
    __setWikiReadonlyForTest(true);
    expect(isWikiReadonly()).toBe(true);
    const res = await writeWikiPage({
      wikiDir: "/wiki",
      relPath: "page.md",
      baseHash: "x",
      transform: (c) => c,
      collections: [],
      logKind: "k",
      logTitle: "t",
      logLine: "l",
      commitMessage: "m",
      now: () => 0,
      readFile: async () => "body\n",
      writeFile: async () => {
        throw new Error("must not write");
      },
      refreshIndex: async () => {},
      reindex: async () => {},
    });
    expect(res.outcome).toBe("forbidden");
  });
});

describe("MUNINN_WIKI_READONLY — git is deliberately NOT guarded", () => {
  let base: string;

  beforeEach(async () => {
    __resetCommitForTest();
    base = await mkdtemp(path.join(tmpdir(), "wiki-readonly-commit-"));
  });
  afterEach(async () => {
    __setWikiReadonlyForTest();
    __resetCommitForTest();
    await rm(base, { recursive: true, force: true });
  });

  test("commitWikiChange still commits on a readonly instance", async () => {
    // This is the whole point of the flag's narrow scope: the mini makes no page
    // writes but MUST still be able to commit/push the wiki repo (the sync loop).
    __setWikiReadonlyForTest(true);
    const { repo, wikiDir } = await makeRepo(base);
    await writeFile(path.join(wikiDir, "Synced.md"), "# Synced\n");

    const result = await commitWikiChange(wikiDir, ["Synced.md"], "[sync] pull: Synced.md", {
      push: false,
    });
    expect(result.committed).toBe(true);
    expect((await git(repo, ["log", "-1", "--pretty=%s"])).out).toBe("[sync] pull: Synced.md");
    // Working tree clean ⇒ the file really is in the commit.
    expect((await git(repo, ["status", "--porcelain"])).out).toBe("");
  });
});

describe("MUNINN_WIKI_READONLY — client guard", () => {
  test("the blocked selector covers every write control and nothing read-only", () => {
    for (const sel of [
      '[data-action="approve"]',
      '[data-backlog-action="run"]',
      "#wikiFactcheckAppendBtn",
      // The propose half of Integrate — guarded server-side too (its only
      // consumer is the /apply this instance refuses).
      "#wikiFactcheckIntegrateBtn",
      "#wikiFcIntAccept",
      ".wiki-atlas-cdraft",
      // Every control behind a route the readonly guard now 403s.
      '[data-backlog-action="confirm"]',
      '[data-backlog-action="cancel-run"]',
      '[data-backlog-action="reset"]',
      '[data-backlog-action="reset-dismissed"]',
      '[data-backlog-action="recover"]',
      '[data-backlog-action="dismiss"]',
      '[data-backlog-action="run-watcher"]',
      '[data-doc-action="dismiss"]',
      '[data-doc-action="undismiss"]',
      '[data-doc-action="delete"]',
      '[data-inspect-action="bulk-dismiss"]',
    ]) {
      expect(WIKI_READONLY_BLOCKED_SELECTOR).toContain(sel);
    }
    // Reject flips a DB status and writes no wiki — it must stay clickable.
    expect(WIKI_READONLY_BLOCKED_SELECTOR).not.toContain('data-action="reject"');
    // The inspector's filters/pagination are reads; so are its close/more
    // controls — only its `bulk-dismiss` verb writes.
    expect(WIKI_READONLY_BLOCKED_SELECTOR).not.toContain("data-inspect-bucket");
    expect(WIKI_READONLY_BLOCKED_SELECTOR).not.toContain('data-inspect-action="close"');
    expect(WIKI_READONLY_BLOCKED_SELECTOR).not.toContain('data-inspect-action="more"');
    // The confirm panel's own close button is a panel toggle, not a POST —
    // blocking it would strand the panel open with no way to dismiss it.
    expect(WIKI_READONLY_BLOCKED_SELECTOR).not.toContain('data-backlog-action="cancel"]');
  });

  test("the flag is read off the injected global, and a null target is not blocked", () => {
    expect(wikiReadonlyFlag({})).toBe(false);
    expect(wikiReadonlyFlag({ __WIKI_READONLY__: "true" })).toBe(false); // strict true only
    expect(wikiReadonlyFlag({ __WIKI_READONLY__: true })).toBe(true);
    expect(isBlockedByReadonly(null)).toBe(false);
  });

  test("a non-Element target fails SOFT — never throws, and nothing blockable is lost", () => {
    // `e.target` is not always an Element: a click dispatched at `document`, a
    // synthetic/programmatic event, or a text node target all reach the guard.
    // `target.closest(...)` throws TypeError there — and a capture-phase listener
    // that THROWS never reaches preventDefault, so EVERY blocked control on the
    // page starts letting its click through. Returning false costs nothing: a
    // non-Element cannot match a selector, so it was never a mutation control.
    for (const target of [{}, { closest: "not a function" }, "text"] as unknown as (Element | null)[]) {
      expect(() => isBlockedByReadonly(target)).not.toThrow();
      expect(isBlockedByReadonly(target)).toBe(false);
    }
  });
});
