/**
 * Route-shape tests for the repo-sync endpoints. The state machine itself is
 * covered against real git in `src/sync/run.test.ts`; this file pins the HTTP
 * contract — the never-5xx rule, the `?repo=` selector, and the "not configured
 * on this instance" answer that keeps the card hidden rather than empty.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtemp, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerSyncRoutes } from "./sync-routes.ts";
import { __resetSyncReposForTest } from "../../sync/config.ts";
import { __resetSyncStateForTest } from "../../sync/run.ts";
import { SYNC_QUIET_MS } from "../../sync/decide.ts";
import { __resetForTest } from "../../wiki/commit.ts";
import { __resetWikiWriteQueueForTest } from "../../wiki/queue.ts";
import type { Config } from "../../config.ts";

const CONFIG = { knowledgeApiUrl: "http://127.0.0.1:1" } as Config;

async function git(cwd: string, args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  await p.exited;
}

function app(): Hono {
  const a = new Hono();
  registerSyncRoutes(a, CONFIG);
  return a;
}

const SAVED_SYNC = process.env.SYNC_REPOS;

describe("sync routes", () => {
  let base: string;

  beforeEach(async () => {
    __resetForTest();
    __resetWikiWriteQueueForTest();
    __resetSyncStateForTest();
    __resetSyncReposForTest();
    base = await mkdtemp(path.join(tmpdir(), "sync-routes-"));
  });
  afterEach(async () => {
    if (SAVED_SYNC === undefined) delete process.env.SYNC_REPOS;
    else process.env.SYNC_REPOS = SAVED_SYNC;
    __resetSyncReposForTest();
    __resetSyncStateForTest();
    await rm(base, { recursive: true, force: true });
  });

  /** A plain-mode repo with a real bare remote — enough for the route contract. */
  async function fixture(): Promise<string> {
    const bare = path.join(base, "remote.git");
    await git(base, ["init", "--bare", "-b", "main", bare]);
    const repo = path.join(base, "repo");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.email", "a@b.c"]);
    await git(repo, ["config", "user.name", "A"]);
    await writeFile(path.join(repo, "README.md"), "root\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "init"]);
    await git(repo, ["remote", "add", "origin", bare]);
    await git(repo, ["push", "-q", "-u", "origin", "main"]);
    return repo;
  }

  test("an unconfigured instance answers configured:false, never an error page", async () => {
    delete process.env.SYNC_REPOS;
    const status = await app().request("/api/sync/status");
    expect(status.status).toBe(200);
    const body = await status.json();
    expect(body).toEqual({ repos: [], warnings: [], configured: false });

    const run = await app().request("/api/sync/run", { method: "POST" });
    expect(run.status).toBe(200);
    expect((await run.json()).configured).toBe(false);
  });

  test("GET /api/sync/status reports each repo without fetching or writing", async () => {
    const repo = await fixture();
    process.env.SYNC_REPOS = `code=${repo}:status-only`;
    // An untracked file — visible in the count, never touched.
    await writeFile(path.join(repo, "scratch.md"), "x\n");

    const res = await app().request("/api/sync/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0]).toMatchObject({
      name: "code",
      mode: "status-only",
      branch: "main",
      onDefaultBranch: true,
      ahead: 0,
      behind: 0,
      dirtyCount: 1,
    });
    // No sync has run in this process yet, and the read must not invent one.
    expect(body.repos[0].lastRunMs).toBeNull();
  });

  test("POST /api/sync/run runs every configured repo and records the ledger", async () => {
    const repo = await fixture();
    process.env.SYNC_REPOS = `code=${repo}:status-only`;

    const res = await app().request("/api/sync/run", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dryRun).toBe(false);
    expect(body.repos[0].state).toBe("status-only");
    expect(body.repos[0].lastRunMs).toBeGreaterThan(0);

    // The card's later read sees the recorded run.
    const after = await (await app().request("/api/sync/status")).json();
    expect(after.repos[0].lastRunMs).toBeGreaterThan(0);
  });

  test("?repo= scopes the run; an unknown name is a 400 naming the entry", async () => {
    const repo = await fixture();
    process.env.SYNC_REPOS = `code=${repo}:status-only`;

    const ok = await app().request("/api/sync/run?repo=CODE", { method: "POST" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).repos).toHaveLength(1); // case-insensitive

    const bad = await app().request("/api/sync/run?repo=nope", { method: "POST" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('no SYNC_REPOS entry named "nope"');
  });

  test("?dry-run=1 reports a plan and leaves both the repo and the ledger untouched", async () => {
    const bare = path.join(base, "remote.git");
    await git(base, ["init", "--bare", "-b", "main", bare]);
    const repo = path.join(base, "wikirepo");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.email", "a@b.c"]);
    await git(repo, ["config", "user.name", "A"]);
    await writeFile(path.join(repo, "seed.md"), "seed\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "init"]);
    await git(repo, ["remote", "add", "origin", bare]);
    await git(repo, ["push", "-q", "-u", "origin", "main"]);
    const page = path.join(repo, "settled.md");
    await writeFile(page, "# settled\n");
    const when = new Date(Date.now() - SYNC_QUIET_MS - 60_000);
    await utimes(page, when, when);
    // Registered as a wiki via WIKI_EXTRA so `wiki` mode accepts it.
    process.env.WIKI_EXTRA = `fixture=${repo}`;
    process.env.SYNC_REPOS = `fixture=${repo}:wiki`;
    const { __resetWikiRegistryForTest } = await import("../../wiki/registry-memo.ts");
    __resetWikiRegistryForTest();

    try {
      const res = await app().request("/api/sync/run?dry-run=1", { method: "POST" });
      const body = await res.json();
      expect(body.dryRun).toBe(true);
      expect(body.repos[0].committed).toEqual(["settled.md"]);
      expect(body.repos[0].actions.join(" ")).toContain("would commit");
      // Nothing was written, and no ledger entry was recorded by a dry run.
      expect(body.repos[0].lastRunMs).toBeNull();
      const status = await (await app().request("/api/sync/status")).json();
      expect(status.repos[0].dirtyCount).toBe(1);
      expect(status.repos[0].lastRunMs).toBeNull();
    } finally {
      delete process.env.WIKI_EXTRA;
      __resetWikiRegistryForTest();
    }
  });

  test("a misconfigured entry is dropped and surfaced as a warning, not a failure", async () => {
    process.env.SYNC_REPOS = "broken=/tmp/definitely-not-a-wiki:wiki";
    const res = await app().request("/api/sync/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repos).toEqual([]);
    expect(body.warnings[0]).toContain("needs a REGISTERED wiki root");
  });
});
