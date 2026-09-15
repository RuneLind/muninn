/**
 * The sync loop against the CROSS-PROCESS wiki write lock (fix round 1).
 *
 * `withLocks` took the commit queue and the per-wiki in-process write queue.
 * Neither says anything about claude-usage's `wiki-stamp`, which is a different
 * PROCESS — and `git rebase` is the one operation in `src/sync/run.ts` that
 * rewrites a working tree wholesale. A stamper that read a page before the
 * rebase and renamed its replacement over it afterwards reverts whatever the
 * rebase pulled in, and the NEXT tick commits and pushes that revert as if a
 * human had made it.
 *
 * Real git in temp dirs and a real lockfile, for `run.test.ts`'s reason: every
 * rule here is a fact about git or about `O_EXCL`, and a fake would only pin our
 * belief about it.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetForTest } from "../wiki/commit.ts";
import { runWikiWriteExclusive, __resetWikiWriteQueueForTest } from "../wiki/queue.ts";
import { WIKI_LOCK_BASENAME, WIKI_LOCK_STALE_MS } from "../wiki/lockfile.ts";
import { writeWikiPage, type PageWriteNoLogOptions } from "../wiki/page-write.ts";
import { sha256 } from "../gardener/util.ts";
import { syncRepo, syncSubsumesSweeper, __resetSyncStateForTest, type SyncDeps } from "./run.ts";
import { SYNC_QUIET_MS } from "./decide.ts";
import type { SyncRepo } from "./config.ts";

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  const code = await proc.exited;
  return { code, out };
}

async function ageFile(abs: string): Promise<void> {
  const when = new Date(Date.now() - SYNC_QUIET_MS - 60_000);
  await utimes(abs, when, when);
}

interface Fixture {
  bare: string;
  A: string;
  wikiA: string;
  B: string;
  wikiB: string;
  lock: string;
}

async function makeFixture(base: string): Promise<Fixture> {
  const bare = path.join(base, "remote.git");
  await git(base, ["init", "--bare", "-b", "main", bare]);

  const A = path.join(base, "A");
  await mkdir(path.join(A, "wiki", "concepts"), { recursive: true });
  await git(A, ["init", "-b", "main"]);
  await git(A, ["config", "user.email", "a@b.c"]);
  await git(A, ["config", "user.name", "A"]);
  await writeFile(path.join(A, "README.md"), "root\n");
  await writeFile(path.join(A, "wiki", "concepts", "Seed.md"), "# Seed\n");
  await git(A, ["add", "-A"]);
  await git(A, ["commit", "-q", "-m", "init"]);
  await git(A, ["remote", "add", "origin", bare]);
  await git(A, ["push", "-q", "-u", "origin", "main"]);

  const B = path.join(base, "B");
  await git(base, ["clone", "-q", bare, B]);
  await git(B, ["config", "user.email", "b@b.c"]);
  await git(B, ["config", "user.name", "B"]);

  return {
    bare,
    A,
    wikiA: path.join(A, "wiki"),
    B,
    wikiB: path.join(B, "wiki"),
    lock: path.join(A, "wiki", WIKI_LOCK_BASENAME),
  };
}

function wikiRepo(f: Fixture): SyncRepo {
  return { name: "fixture", path: f.wikiA, mode: "wiki", wikiRoot: f.wikiA };
}

function deps(over: Partial<SyncDeps> = {}): SyncDeps {
  return {
    refreshWikiIndex: async () => {},
    reindexCollections: async () => {},
    now: () => Date.now(),
    ...over,
  };
}

describe("the sync loop and the wiki write lock", () => {
  let base: string;

  beforeEach(async () => {
    __resetForTest();
    __resetWikiWriteQueueForTest();
    __resetSyncStateForTest();
    base = await mkdtemp(path.join(tmpdir(), "sync-lock-"));
  });
  afterEach(async () => {
    __resetSyncStateForTest();
    await rm(base, { recursive: true, force: true });
  });

  test("a HELD lock defers the tick — nothing is committed, nothing is rebased", async () => {
    const f = await makeFixture(base);
    // Work the tick would otherwise do: a settled local page, and a commit on
    // the remote to rebase onto.
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);
    await writeFile(path.join(f.wikiB, "concepts", "FromB.md"), "# FromB\n");
    await git(f.B, ["add", "-A"]);
    await git(f.B, ["commit", "-q", "-m", "B page"]);
    await git(f.B, ["push", "-q"]);

    // Another PROCESS is mid-write on this wiki.
    await writeFile(f.lock, '{"pid":999999,"host":"other","op":"wiki-stamp","at":"now"}\n');

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("deferred");
    expect(r.committed).toEqual([]);
    expect(r.rebased).toBe(false);
    // The rebase is the dangerous one: the other machine's page must NOT have
    // been written into a tree somebody else is mid-write on.
    expect(existsSync(path.join(f.wikiA, "concepts", "FromB.md"))).toBe(false);
    // And the local edit is still sitting there for the next tick.
    expect((await git(f.A, ["status", "--porcelain"])).out).toContain("Settled.md");
  });

  test("the lock is RELEASED after the tick, so the next one proceeds", async () => {
    const f = await makeFixture(base);
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("ok");
    expect(r.committed).toEqual(["wiki/concepts/Settled.md"]);
    // The loop's own lockfile is gone, and — separately — it was never staged:
    // the file is there for the whole of the loop's own `git status`.
    expect(existsSync(f.lock)).toBe(false);
    const names = await git(f.A, ["show", "--name-only", "--format=", "HEAD"]);
    expect(names.out).toBe("wiki/concepts/Settled.md");
    expect((await git(f.A, ["status", "--porcelain"])).out).toBe("");
  });

  test("a STALE lock is taken over rather than deferring forever", async () => {
    const f = await makeFixture(base);
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);
    await writeFile(f.lock, "");
    const old = new Date(Date.now() - WIKI_LOCK_STALE_MS - 5_000);
    await utimes(f.lock, old, old);

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("ok");
    expect(r.committed).toEqual(["wiki/concepts/Settled.md"]);
  });

  test("a lock-held deferral stamps NO sweeper evidence — the section never ran", async () => {
    const f = await makeFixture(base);
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);
    await writeFile(f.lock, '{"pid":999999,"host":"other","op":"wiki-stamp","at":"now"}\n');

    const r = await syncRepo(wikiRepo(f), deps());
    expect(r.state).toBe("deferred");

    // An ordinary hard `deferred` IS evidence: status, add/commit and the rebase
    // gate all ran and the loop chose to wait. This one refused before the first
    // `git status`, so standing the daily `wiki-committer` sweeper down off it
    // would renew 26 h of silence for a tick that did strictly less than one
    // which errored at the fetch.
    //
    // `repos` is passed EXPLICITLY: without it the lookup reads the process's
    // own `SYNC_REPOS` (empty under test), finds no covering repo and answers
    // `false` for a reason that has nothing to do with this tick — a vacuous
    // assertion that passes whatever the loop did.
    const cover = { repos: [wikiRepo(f)], now: Date.now() };
    expect((await syncSubsumesSweeper(f.A, cover)).name).toBe("fixture");
    expect((await syncSubsumesSweeper(f.A, cover)).subsumed).toBe(false);
  });

  test("…while an ordinary tick DOES stamp it — so the check above is about the lock", async () => {
    const f = await makeFixture(base);
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);

    expect((await syncRepo(wikiRepo(f), deps())).state).toBe("ok");
    const cover = { repos: [wikiRepo(f)], now: Date.now() };
    expect((await syncSubsumesSweeper(f.A, cover)).subsumed).toBe(true);
  });

  // ── The lockfile is taken INSIDE the in-process queue, never instead of it ──
  //
  // Fix round 2. Round 1 replaced `runWikiWriteExclusive(root, inner)` with the
  // lockfile call in `withLocks`, leaving the queue imported and never called.
  // The two answer different questions and neither substitutes for the other:
  // the queue serializes this loop against muninn's OWN writers, and it is the
  // one of the two that always holds — `takeWikiWriteLock` degrades to
  // `{ ok: true, lock: null }` on every errno but EEXIST, so on that path the
  // local section ran with no exclusion at all.

  test(
    "the local section QUEUES behind an in-process wiki write — the queue is not replaced",
    async () => {
      const f = await makeFixture(base);
      const page = path.join(f.wikiA, "concepts", "Settled.md");
      await writeFile(page, "# Settled\n");
      await ageFile(page);

      // A muninn writer already inside its write section — a gardener apply, a
      // factcheck write, a plan queue append. It holds the QUEUE and no
      // lockfile, which is exactly the holder the lockfile cannot see.
      const HOLD_MS = 1_500;
      let releasedAt = 0;
      const holder = runWikiWriteExclusive(f.wikiA, async () => {
        await Bun.sleep(HOLD_MS);
        releasedAt = Date.now();
      });
      await Bun.sleep(50); // let it enter the section before the tick starts

      const startedAt = Date.now();
      const r = await syncRepo(wikiRepo(f), deps());
      const finishedAt = Date.now();
      await holder;

      expect(r.state).toBe("ok");
      expect(r.committed).toEqual(["wiki/concepts/Settled.md"]);
      // The ordering IS the property: the tick cannot have finished before the
      // holder let go of the chain.
      expect(releasedAt).toBeGreaterThan(0);
      expect(finishedAt).toBeGreaterThanOrEqual(releasedAt);
      // …and it really waited, rather than the holder having finished early.
      expect(finishedAt - startedAt).toBeGreaterThanOrEqual(HOLD_MS - 150);
    },
    30_000,
  );

  test(
    "a page write DURING the local section queues and is WRITTEN — muninn does not 409 against itself",
    async () => {
      const f = await makeFixture(base);
      const page = path.join(f.wikiA, "concepts", "Settled.md");
      await writeFile(page, "# Settled\n");
      await ageFile(page);
      const target = path.join(f.wikiA, "concepts", "Seed.md");
      const before = await Bun.file(target).text();

      // A slow `pre-commit` hook holds the local section open for longer than
      // `WIKI_LOCK_WAIT_MS` (2 s), which is what makes the two outcomes
      // distinguishable: a writer that only waits on the LOCKFILE gives up and
      // answers `locked`, while a writer that is queued waits as long as the
      // section takes and then writes.
      const hook = path.join(f.A, ".git", "hooks", "pre-commit");
      await writeFile(hook, "#!/bin/sh\nsleep 4\n", { mode: 0o755 });

      const tick = syncRepo(wikiRepo(f), deps());
      await Bun.sleep(800); // inside the section, mid-commit

      const pageWrite: PageWriteNoLogOptions = {
        wikiDir: f.wikiA,
        relPath: "concepts/Seed.md",
        baseHash: sha256(before),
        transform: (current: string) => `${current}appended\n`,
        collections: [],
        logKind: null,
        now: () => Date.UTC(2026, 8, 15, 12, 0, 0),
        readFile: async (p: string) => (existsSync(p) ? await Bun.file(p).text() : null),
        writeFile: async (p: string, content: string) => {
          await Bun.write(p, content);
        },
        refreshIndex: async () => {},
        reindex: async () => {},
      };
      const write = writeWikiPage(pageWrite);

      const [r, w] = await Promise.all([tick, write]);
      expect(r.state).toBe("ok");
      expect(w.outcome).toBe("written");
      expect(await Bun.file(target).text()).toContain("appended");
    },
    30_000,
  );

  test("a lockfile in the tree never reaches the report or the commit", async () => {
    const f = await makeFixture(base);
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);
    // A STALE lockfile: the loop takes it over and then holds its own across its
    // OWN `git status`, so the file is dirty by construction on every tick.
    // Reported as `denied` it turns up on an `ok` card as work somebody should
    // look at; staged, it commits a live lock.
    await writeFile(f.lock, "");
    const old = new Date(Date.now() - WIKI_LOCK_STALE_MS - 5_000);
    await utimes(f.lock, old, old);

    const r = await syncRepo(wikiRepo(f), deps());
    expect(r.committed).toEqual(["wiki/concepts/Settled.md"]);

    expect(r.denied).toEqual([]);
    expect(r.deferredFiles.map((d) => d.path)).not.toContain(`wiki/${WIKI_LOCK_BASENAME}`);
  });
});
