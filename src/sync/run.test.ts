/**
 * Fixture-repo tests for the sync state machine — real git in temp dirs against
 * a local BARE remote with two clones, following `commit.test.ts`'s `makeRepo`
 * pattern. Nothing here is mocked at the git layer on purpose: every rule this
 * PR encodes (what makes a rebase refuse, what a conflict leaves behind, what a
 * non-fast-forward rejection looks like) is a fact about git, and a fake would
 * only pin our belief about it.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, utimes, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetForTest } from "../wiki/commit.ts";
import { __resetWikiWriteQueueForTest } from "../wiki/queue.ts";
import {
  INDEX_LOCK_STALE_MS,
  remoteMovedUnderUs,
  syncRepo,
  __resetSyncStateForTest,
  type SyncDeps,
} from "./run.ts";
import { SYNC_QUIET_MS } from "./decide.ts";
import type { SyncRepo } from "./config.ts";

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  const code = await proc.exited;
  return { code, out };
}

/** Age a file past the quiet window without waiting 5 minutes for it. */
async function ageFile(abs: string): Promise<void> {
  const when = new Date(Date.now() - SYNC_QUIET_MS - 60_000);
  await utimes(abs, when, when);
}

interface Fixture {
  base: string;
  bare: string;
  /** Clone A — the machine under test. Its wiki lives at `A/wiki`, i.e. NESTED
   *  below the toplevel, so the repo-relative path translation is exercised. */
  A: string;
  wikiA: string;
  /** Clone B — the "other machine". */
  B: string;
  wikiB: string;
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

  return { base, bare, A, wikiA: path.join(A, "wiki"), B, wikiB: path.join(B, "wiki") };
}

function wikiRepo(f: Fixture): SyncRepo {
  return { name: "fixture", path: f.wikiA, mode: "wiki", wikiName: "fixture", wikiRoot: f.wikiA };
}

/** Deps with both post-sync side effects stubbed — the cache refresh and the
 *  huginn kick are seams precisely so these tests need neither. */
function deps(over: Partial<SyncDeps> = {}): SyncDeps {
  return {
    refreshWikiIndex: async () => {},
    reindexCollections: async () => {},
    now: () => Date.now(),
    ...over,
  };
}

describe("syncRepo", () => {
  let base: string;

  beforeEach(async () => {
    __resetForTest();
    __resetWikiWriteQueueForTest();
    __resetSyncStateForTest();
    base = await mkdtemp(path.join(tmpdir(), "sync-run-"));
  });
  afterEach(async () => {
    __resetSyncStateForTest();
    await rm(base, { recursive: true, force: true });
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  test("commits a settled edit, rebases and pushes — the other clone pulls it", async () => {
    const f = await makeFixture(base);
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("ok");
    expect(r.committed).toEqual(["wiki/concepts/Settled.md"]);
    expect(r.pushed).toBe(true);
    expect(r.tone).toBe("ok");
    // Repo-relative staging: the page lives under the NESTED wiki root and the
    // commit records the repo-relative path.
    const names = await git(f.A, ["show", "--name-only", "--format=", "HEAD"]);
    expect(names.out).toBe("wiki/concepts/Settled.md");
    expect((await git(f.A, ["status", "--porcelain"])).out).toBe("");

    // The other machine sees it.
    await git(f.B, ["pull", "-q"]);
    expect(await Bun.file(path.join(f.wikiB, "concepts", "Settled.md")).text()).toBe("# Settled\n");
  });

  test("pulls the other machine's commit and refreshes the reader cache", async () => {
    const f = await makeFixture(base);
    await writeFile(path.join(f.wikiB, "concepts", "FromB.md"), "# FromB\n");
    await git(f.B, ["add", "-A"]);
    await git(f.B, ["commit", "-q", "-m", "B page"]);
    await git(f.B, ["push", "-q"]);

    const refreshed: string[] = [];
    const r = await syncRepo(wikiRepo(f), deps({ refreshWikiIndex: async (root) => { refreshed.push(root); } }));

    expect(r.state).toBe("ok");
    expect(r.rebased).toBe(true);
    expect(await Bun.file(path.join(f.wikiA, "concepts", "FromB.md")).exists()).toBe(true);
    // The 5-minute page-index TTL would otherwise hide the pulled page.
    expect(refreshed).toEqual([f.wikiA]);
    expect(r.behind).toBe(0);
    expect(r.ahead).toBe(0);
  });

  test("a clean, already-synced repo is a quiet no-op and refreshes nothing", async () => {
    const f = await makeFixture(base);
    const refreshed: string[] = [];
    const r = await syncRepo(wikiRepo(f), deps({ refreshWikiIndex: async (x) => { refreshed.push(x); } }));
    expect(r.state).toBe("ok");
    expect(r.committed).toEqual([]);
    expect(r.pushed).toBe(false);
    expect(refreshed).toEqual([]);
    expect(r.dirtyCount).toBe(0);
  });

  // ── Deferral ──────────────────────────────────────────────────────────────

  test("a fresh edit defers with an honest count — and nothing is committed or pushed", async () => {
    const f = await makeFixture(base);
    // Something to pull, so a deferral is visibly costing us convergence.
    await writeFile(path.join(f.wikiB, "concepts", "FromB.md"), "# FromB\n");
    await git(f.B, ["add", "-A"]);
    await git(f.B, ["commit", "-q", "-m", "B page"]);
    await git(f.B, ["push", "-q"]);
    // A tracked page edited seconds ago.
    await writeFile(path.join(f.wikiA, "concepts", "Seed.md"), "# Seed edited right now\n");

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("deferred");
    expect(r.reason).toMatch(/^active edits \(1 file < 5 min\)$/);
    expect(r.committed).toEqual([]);
    expect(r.pushed).toBe(false);
    expect(r.rebased).toBe(false);
    // Still behind — the point of the honest state.
    expect(r.behind).toBe(1);
    expect((await git(f.A, ["log", "--format=%s"])).out).toBe("init");
  });

  test("untracked-only dirt does NOT defer — the repo still pulls", async () => {
    // Empirically verified against git: untracked files never make a rebase
    // refuse, so counting them would strand a repo that could have converged.
    const f = await makeFixture(base);
    await writeFile(path.join(f.wikiB, "concepts", "FromB.md"), "# FromB\n");
    await git(f.B, ["add", "-A"]);
    await git(f.B, ["commit", "-q", "-m", "B page"]);
    await git(f.B, ["push", "-q"]);
    // Untracked AND fresh, so the quiet filter holds it back from the commit —
    // but it must not hold back the rebase.
    await writeFile(path.join(f.wikiA, "concepts", "Draft.md"), "# Draft\n");

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("ok");
    expect(r.rebased).toBe(true);
    expect(r.committed).toEqual([]);
    expect(r.deferredFiles.map((d) => d.path)).toEqual(["wiki/concepts/Draft.md"]);
    expect(await Bun.file(path.join(f.wikiA, "concepts", "FromB.md")).exists()).toBe(true);
    // The draft is untouched on disk.
    expect(await Bun.file(path.join(f.wikiA, "concepts", "Draft.md")).text()).toBe("# Draft\n");
  });

  test("consecutive deferrals accrue and flip the card tone to warn", async () => {
    const f = await makeFixture(base);
    await writeFile(path.join(f.wikiA, "concepts", "Seed.md"), "# live edit\n");
    let last = await syncRepo(wikiRepo(f), deps());
    for (let i = 0; i < 4; i++) last = await syncRepo(wikiRepo(f), deps());
    expect(last.state).toBe("deferred");
    expect(last.consecutiveDeferrals).toBeGreaterThanOrEqual(4);
    expect(last.tone).toBe("warn");
  });

  // ── Conflict ──────────────────────────────────────────────────────────────

  test("a real conflict aborts the rebase, blocks, and pushes nothing", async () => {
    const f = await makeFixture(base);
    // B edits the seed page and pushes.
    await writeFile(path.join(f.wikiB, "concepts", "Seed.md"), "# Seed — B's version\n");
    await git(f.B, ["add", "-A"]);
    await git(f.B, ["commit", "-q", "-m", "B edits seed"]);
    await git(f.B, ["push", "-q"]);
    // A edits the same page, settled so it commits.
    const page = path.join(f.wikiA, "concepts", "Seed.md");
    await writeFile(page, "# Seed — A's version\n");
    await ageFile(page);

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("blocked");
    expect(r.reason).toContain("rebase conflict");
    expect(r.conflicts).toContain("wiki/concepts/Seed.md");
    expect(r.pushed).toBe(false);
    expect(r.tone).toBe("bad");
    // The abort restored the tree: no rebase in progress, no conflict markers.
    expect(await Bun.file(path.join(f.A, ".git", "rebase-merge", "done")).exists()).toBe(false);
    expect(await readFile(page, "utf8")).not.toContain("<<<<<<<");
    // A's commit survives locally, unpushed.
    expect((await git(f.A, ["log", "-1", "--format=%s"])).out).toContain("[sync]");
    const remoteSubjects = await git(f.bare, ["log", "--format=%s"]);
    expect(remoteSubjects.out).not.toContain("[sync]");
  });

  test("a failure BEFORE any rebase starts is reported verbatim, with no abort attempt", async () => {
    const f = await makeFixture(base);
    // Point origin at a directory that does not exist: the fetch fails, and the
    // tick must report git's own words rather than a confusing abort.
    await git(f.A, ["remote", "set-url", "origin", path.join(base, "gone.git")]);
    const r = await syncRepo(wikiRepo(f), deps());
    expect(r.state).toBe("error");
    expect(r.reason).toContain("git fetch failed");
    expect(r.rebased).toBe(false);
  });

  // ── Non-fast-forward ──────────────────────────────────────────────────────

  test("a non-fast-forward push re-fetches, re-rebases and pushes once — not an error", async () => {
    const f = await makeFixture(base);
    // B has a commit ready but unpushed.
    await writeFile(path.join(f.wikiB, "concepts", "FromB.md"), "# FromB\n");
    await git(f.B, ["add", "-A"]);
    await git(f.B, ["commit", "-q", "-m", "B page"]);
    // A pre-push hook in A pushes B's commit exactly ONCE, right between A's
    // fetch and A's push — reproducing the real race the retry exists for.
    // NB the hook runs AFTER the push has negotiated refs, so the remote refuses
    // at ref-lock time (`cannot lock ref … failed to update ref`) rather than the
    // client refusing locally (`fetch first`). Both spellings are the same race
    // and both are matched by `remoteMovedUnderUs`, which is unit-tested on the
    // verbatim text of each.
    const hookDir = path.join(f.A, ".git", "hooks");
    await mkdir(hookDir, { recursive: true });
    const hook = path.join(hookDir, "pre-push");
    await writeFile(
      hook,
      `#!/bin/sh\nif [ ! -f "$(git rev-parse --git-dir)/nff-fired" ]; then\n  touch "$(git rev-parse --git-dir)/nff-fired"\n  git -C ${JSON.stringify(f.B)} push -q\nfi\nexit 0\n`,
      { mode: 0o755 },
    );

    const page = path.join(f.wikiA, "concepts", "FromA.md");
    await writeFile(page, "# FromA\n");
    await ageFile(page);

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("ok");
    expect(r.pushed).toBe(true);
    expect(r.actions.join(" ")).toContain("the remote moved");
    // Both machines' work is on the remote, A's rebased on top of B's.
    const subjects = (await git(f.bare, ["log", "--format=%s"])).out.split("\n");
    expect(subjects[0]).toContain("[sync]");
    expect(subjects[1]).toBe("B page");
  });

  test("both real spellings of 'the remote moved' are recognised", () => {
    // Verbatim git output captured from the fixture race (server-side ref lock)
    // and the classic client-side refusal.
    expect(
      remoteMovedUnderUs(
        "remote: error: cannot lock ref 'refs/heads/main': is at 87acf3e but expected dcc0480\n" +
          "To /tmp/x/remote.git\n ! [remote rejected] main -> main (failed to update ref)\n" +
          "error: failed to push some refs to '/tmp/x/remote.git'",
      ),
    ).toBe(true);
    expect(
      remoteMovedUnderUs(
        "To github.com:me/mimir.git\n ! [rejected]        main -> main (fetch first)\n" +
          "error: failed to push some refs\nhint: Updates were rejected because the remote contains work",
      ),
    ).toBe(true);
    expect(
      remoteMovedUnderUs("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
    ).toBe(false);
    expect(remoteMovedUnderUs("git push timed out after 60000ms")).toBe(false);
  });

  // ── Branch gate ───────────────────────────────────────────────────────────

  test("off the default branch: paused, but the fetch-status display stays live", async () => {
    const f = await makeFixture(base);
    await writeFile(path.join(f.wikiB, "concepts", "FromB.md"), "# FromB\n");
    await git(f.B, ["add", "-A"]);
    await git(f.B, ["commit", "-q", "-m", "B page"]);
    await git(f.B, ["push", "-q"]);
    await git(f.A, ["checkout", "-q", "-b", "feature/x"]);
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("paused");
    expect(r.reason).toContain("off default branch (feature/x)");
    expect(r.branch).toBe("feature/x");
    expect(r.committed).toEqual([]);
    expect(r.pushed).toBe(false);
    // The card still knows where the remote is — that is the point of "display
    // stays live". No upstream on this branch ⇒ the labelled origin/main fallback.
    expect(r.upstreamFallback).toBe(true);
    expect(r.upstream).toBe("origin/main");
    expect(r.behind).toBe(1);
    expect(r.remoteCommitMs).toBeGreaterThan(0);
    expect((await git(f.A, ["log", "--format=%s"])).out).toBe("init");
  });

  // ── Pre-flight ────────────────────────────────────────────────────────────

  test("an in-progress rebase blocks the tick — the tree is not touched", async () => {
    const f = await makeFixture(base);
    await mkdir(path.join(f.A, ".git", "rebase-merge"), { recursive: true });
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("blocked");
    expect(r.reason).toContain("rebase-merge");
    expect(r.tone).toBe("bad");
    expect((await git(f.A, ["log", "--format=%s"])).out).toBe("init");
  });

  test("MERGE_HEAD and CHERRY_PICK_HEAD block it too", async () => {
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
      const f = await makeFixture(await mkdtemp(path.join(base, "m-")));
      await writeFile(path.join(f.A, ".git", marker), "deadbeef\n");
      const r = await syncRepo(wikiRepo(f), deps());
      expect(r.state).toBe("blocked");
      expect(r.reason).toContain(marker);
    }
  });

  test("a YOUNG index.lock is transient, a STALE one needs a human", async () => {
    const f = await makeFixture(base);
    const lock = path.join(f.A, ".git", "index.lock");

    await writeFile(lock, "");
    const young = await syncRepo(wikiRepo(f), deps());
    expect(young.state).toBe("transient");
    expect(young.reason).toContain("index.lock");
    // Transient must NOT read as "needs a human" on the card.
    expect(young.tone).toBe("ok");

    const past = new Date(Date.now() - INDEX_LOCK_STALE_MS - 60_000);
    await utimes(lock, past, past);
    const stale = await syncRepo(wikiRepo(f), deps());
    expect(stale.state).toBe("blocked");
    expect(stale.reason).toContain("remove it by hand");
    // Never removed automatically — two git processes on one index is worse.
    expect(await Bun.file(lock).exists()).toBe(true);
  });

  test("unmerged paths block before anything is staged", async () => {
    const f = await makeFixture(base);
    // Manufacture a genuine conflicted index with a merge that fails.
    await writeFile(path.join(f.wikiA, "concepts", "Seed.md"), "# A line\n");
    await git(f.A, ["commit", "-qam", "A edit"]);
    await git(f.A, ["checkout", "-q", "-b", "other", "HEAD~1"]);
    await writeFile(path.join(f.wikiA, "concepts", "Seed.md"), "# other line\n");
    await git(f.A, ["commit", "-qam", "other edit"]);
    await git(f.A, ["checkout", "-q", "main"]);
    await git(f.A, ["merge", "other"]); // conflicts, leaves UU + MERGE_HEAD

    const r = await syncRepo(wikiRepo(f), deps());
    expect(r.state).toBe("blocked");
    // MERGE_HEAD is found by the pre-flight first — either way it is blocked and
    // nothing was committed.
    expect((await git(f.A, ["log", "-1", "--format=%s"])).out).toBe("A edit");
  });

  // ── Modes ─────────────────────────────────────────────────────────────────

  test("status-only fetches and reports, but never pulls or commits", async () => {
    const f = await makeFixture(base);
    await writeFile(path.join(f.wikiB, "concepts", "FromB.md"), "# FromB\n");
    await git(f.B, ["add", "-A"]);
    await git(f.B, ["commit", "-q", "-m", "B page"]);
    await git(f.B, ["push", "-q"]);
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);

    const r = await syncRepo({ name: "code", path: f.A, mode: "status-only" }, deps());

    expect(r.state).toBe("status-only");
    expect(r.behind).toBe(1); // the fetch DID happen — that is the display
    expect(r.dirtyCount).toBe(1);
    expect(r.committed).toEqual([]);
    expect(r.rebased).toBe(false);
    expect((await git(f.A, ["log", "--format=%s"])).out).toBe("init");
    expect(await Bun.file(path.join(f.wikiA, "concepts", "FromB.md")).exists()).toBe(false);
  });

  test("plain mode pulls but never commits or pushes", async () => {
    const f = await makeFixture(base);
    await writeFile(path.join(f.wikiB, "concepts", "FromB.md"), "# FromB\n");
    await git(f.B, ["add", "-A"]);
    await git(f.B, ["commit", "-q", "-m", "B page"]);
    await git(f.B, ["push", "-q"]);
    const settled = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(settled, "# Settled\n");
    await ageFile(settled);

    const r = await syncRepo({ name: "skills", path: f.A, mode: "plain" }, deps());

    expect(r.state).toBe("ok");
    expect(r.rebased).toBe(true);
    expect(r.committed).toEqual([]);
    expect(r.pushed).toBe(false);
    expect(await Bun.file(path.join(f.wikiA, "concepts", "FromB.md")).exists()).toBe(true);
    // The settled local file is STILL uncommitted — plain mode never commits.
    expect((await git(f.A, ["status", "--porcelain"])).out).toContain("wiki/concepts/Settled.md");
  });

  test("plain mode defers on an unstaged TRACKED modification (git would refuse)", async () => {
    const f = await makeFixture(base);
    await writeFile(path.join(f.wikiA, "concepts", "Seed.md"), "# locally edited\n");
    const r = await syncRepo({ name: "skills", path: f.A, mode: "plain" }, deps());
    expect(r.state).toBe("deferred");
    expect(r.reason).toContain("local edits");
    expect(r.reason).toContain("wiki/concepts/Seed.md");
  });

  // ── Dry run ───────────────────────────────────────────────────────────────

  test("dry-run reports the same plan the real run executes, and changes nothing", async () => {
    const f = await makeFixture(base);
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);
    await writeFile(path.join(f.wikiB, "concepts", "FromB.md"), "# FromB\n");
    await git(f.B, ["add", "-A"]);
    await git(f.B, ["commit", "-q", "-m", "B page"]);
    await git(f.B, ["push", "-q"]);

    const dry = await syncRepo(wikiRepo(f), deps(), true);
    expect(dry.dryRun).toBe(true);
    expect(dry.committed).toEqual(["wiki/concepts/Settled.md"]);
    expect(dry.actions.join(" | ")).toContain("would commit 1 file(s)");
    expect(dry.actions.join(" | ")).toContain("would rebase onto");
    // Nothing moved.
    expect((await git(f.A, ["log", "--format=%s"])).out).toBe("init");
    expect((await git(f.A, ["status", "--porcelain"])).out).toContain("wiki/concepts/Settled.md");
    // …and the ledger was NOT written, so a dry-run poll can't reset a streak.
    expect(dry.lastRunMs).toBeNull();

    const real = await syncRepo(wikiRepo(f), deps());
    expect(real.committed).toEqual(dry.committed);
    expect(real.state).toBe("ok");
    expect(real.pushed).toBe(true);
    expect(real.lastRunMs).not.toBeNull();
  });

  // ── Denylist + quiet interaction, end to end ──────────────────────────────

  test("denied paths never commit, and never block a deletion", async () => {
    const f = await makeFixture(base);
    // A tracked page to delete + freshly-written Obsidian churn.
    const doomed = path.join(f.wikiA, "concepts", "Doomed.md");
    await writeFile(doomed, "# Doomed\n");
    await git(f.A, ["add", "-A"]);
    await git(f.A, ["commit", "-q", "-m", "seed doomed"]);
    await git(f.A, ["push", "-q"]);
    await mkdir(path.join(f.wikiA, ".obsidian"), { recursive: true });
    await writeFile(path.join(f.wikiA, ".obsidian", "workspace.json"), "{}\n");
    await rm(doomed);

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("ok");
    expect(r.committed).toEqual(["wiki/concepts/Doomed.md"]);
    expect(r.denied).toEqual(["wiki/.obsidian/workspace.json"]);
    const status = await git(f.A, ["show", "--name-status", "--format=", "HEAD"]);
    expect(status.out).toMatch(/D\s+wiki\/concepts\/Doomed\.md/);
    // The Obsidian file is still sitting there untracked.
    expect((await git(f.A, ["status", "--porcelain", "-uall"])).out).toContain(
      "wiki/.obsidian/workspace.json",
    );
  });

  test("an unstaged rename holds the deletion until the new half settles", async () => {
    const f = await makeFixture(base);
    const oldPath = path.join(f.wikiA, "concepts", "Old Name.md");
    await writeFile(oldPath, "# Old\n");
    await git(f.A, ["add", "-A"]);
    await git(f.A, ["commit", "-q", "-m", "seed old"]);
    await git(f.A, ["push", "-q"]);

    // The shape git actually reports for a plain `mv`: ` D old` + `?? new`.
    const newPath = path.join(f.wikiA, "concepts", "New Name.md");
    await writeFile(newPath, "# Old\n");
    await rm(oldPath);

    const held = await syncRepo(wikiRepo(f), deps());
    expect(held.state).toBe("deferred");
    expect(held.committed).toEqual([]);
    // The bare deletion was NOT pushed — the other machine would have 404'd.
    expect((await git(f.bare, ["log", "--format=%s"])).out).not.toContain("[sync]");

    await ageFile(newPath);
    const done = await syncRepo(wikiRepo(f), deps());
    expect(done.state).toBe("ok");
    expect(done.committed.sort()).toEqual(["wiki/concepts/New Name.md", "wiki/concepts/Old Name.md"]);
    // Both halves are in ONE commit — git renders it as a rename (`R100`), which
    // is exactly the outcome the hold exists to produce: the other machine never
    // sees a bare deletion.
    const names = (await git(f.A, ["show", "--name-status", "-M", "--format=", "HEAD"])).out;
    expect(names).toMatch(/R\d*\s+wiki\/concepts\/Old Name\.md\s+wiki\/concepts\/New Name\.md/);
    const noRenames = (await git(f.A, ["show", "--name-status", "--no-renames", "--format=", "HEAD"])).out;
    expect(noRenames).toMatch(/D\s+wiki\/concepts\/Old Name\.md/);
    expect(noRenames).toMatch(/A\s+wiki\/concepts\/New Name\.md/);
  });

  test("the log.md union attribute lets both machines' entries survive a rebase", async () => {
    // mimir declares `log.md merge=union` in .gitattributes; nothing is built for
    // it here, but the loop must not be the thing that breaks it.
    const f = await makeFixture(base);
    await writeFile(path.join(f.A, ".gitattributes"), "log.md merge=union\n");
    await writeFile(path.join(f.wikiA, "log.md"), "# Activity Log\n");
    await git(f.A, ["add", "-A"]);
    await git(f.A, ["commit", "-q", "-m", "seed log"]);
    await git(f.A, ["push", "-q"]);
    await git(f.B, ["pull", "-q"]);

    await writeFile(path.join(f.wikiB, "log.md"), "# Activity Log\n## [2026-08-12] B entry\n");
    await git(f.B, ["commit", "-qam", "B log"]);
    await git(f.B, ["push", "-q"]);

    const logA = path.join(f.wikiA, "log.md");
    await writeFile(logA, "# Activity Log\n## [2026-08-12] A entry\n");
    await ageFile(logA);

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("ok");
    const merged = await readFile(logA, "utf8");
    expect(merged).toContain("A entry");
    expect(merged).toContain("B entry");
    expect(merged).not.toContain("<<<<<<<");
  });

  // ── Guards ────────────────────────────────────────────────────────────────

  test("a non-repo path is an error, never a throw", async () => {
    const loose = await mkdtemp(path.join(base, "loose-"));
    const r = await syncRepo({ name: "nope", path: loose, mode: "plain" }, deps());
    expect(r.state).toBe("error");
    expect(r.reason).toContain("not a git repo");
  });

  test("two concurrent runs of one repo do not interleave — the second reports running", async () => {
    const f = await makeFixture(base);
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);
    const [a, b] = await Promise.all([
      syncRepo(wikiRepo(f), deps()),
      syncRepo(wikiRepo(f), deps()),
    ]);
    const states = [a.state, b.state].sort();
    expect(states).toEqual(["ok", "running"]);
    expect((await git(f.A, ["rev-list", "--count", "HEAD"])).out).toBe("2");
  });
});
