/**
 * Fixture-repo tests for the sync state machine — real git in temp dirs against
 * a local BARE remote with two clones, following `commit.test.ts`'s `makeRepo`
 * pattern. Nothing here is mocked at the git layer on purpose: every rule this
 * PR encodes (what makes a rebase refuse, what a conflict leaves behind, what a
 * non-fast-forward rejection looks like) is a fact about git, and a fake would
 * only pin our belief about it.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, utimes, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetForTest } from "../wiki/commit.ts";
import { __resetWikiWriteQueueForTest } from "../wiki/queue.ts";
import {
  INDEX_LOCK_STALE_MS,
  getSyncLedgerEntry,
  readRepoStatus,
  remoteMovedUnderUs,
  sortedLockRoots,
  stagePaths,
  syncRepo,
  syncSubsumesSweeper,
  SYNC_SUBSUME_MAX_AGE_MS,
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
  return { name: "fixture", path: f.wikiA, mode: "wiki", wikiRoot: f.wikiA };
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
    // The reason NAMES the file and the actual cause (a quiet hold), rather than
    // the old hardcoded "active edits (N files < 5 min)" that every wiki-mode
    // deferral got whatever had really blocked it.
    expect(r.reason).toBe("holding 1 file edited in the last 5 min (wiki/concepts/Seed.md)");
    expect(r.committed).toEqual([]);
    expect(r.pushed).toBe(false);
    expect(r.rebased).toBe(false);
    // Still behind — the point of the honest state.
    expect(r.behind).toBe(1);
    expect((await git(f.A, ["log", "--format=%s"])).out).toBe("init");
  });

  test("untracked-only dirt still PULLS, but the held file is reported as deferred", async () => {
    // Empirically verified against git: untracked files never make a rebase
    // refuse, so counting them would strand a repo that could have converged.
    // But the held page is NOT committed, so the tick is not "in sync" either —
    // reporting `ok` with a green card is how a new page sits uncommitted
    // forever while the card says everything is fine.
    const f = await makeFixture(base);
    await writeFile(path.join(f.wikiB, "concepts", "FromB.md"), "# FromB\n");
    await git(f.B, ["add", "-A"]);
    await git(f.B, ["commit", "-q", "-m", "B page"]);
    await git(f.B, ["push", "-q"]);
    // Untracked AND fresh, so the quiet filter holds it back from the commit —
    // but it must not hold back the rebase.
    await writeFile(path.join(f.wikiA, "concepts", "Draft.md"), "# Draft\n");

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("deferred");
    expect(r.reason).toContain("wiki/concepts/Draft.md");
    expect(r.consecutiveDeferrals).toBe(1);
    // …and the pull still happened, which is the whole point of not blocking on
    // untracked dirt.
    expect(r.rebased).toBe(true);
    expect(r.committed).toEqual([]);
    expect(r.deferredFiles.map((d) => d.path)).toEqual(["wiki/concepts/Draft.md"]);
    expect(await Bun.file(path.join(f.wikiA, "concepts", "FromB.md")).exists()).toBe(true);
    // The draft is untouched on disk.
    expect(await Bun.file(path.join(f.wikiA, "concepts", "Draft.md")).text()).toBe("# Draft\n");
  });

  test("a quiet-held page escalates like any other deferral", async () => {
    // Reported `ok` with streak 0, a held page would never reach the warn tone
    // no matter how many ticks it sat there.
    const f = await makeFixture(base);
    await writeFile(path.join(f.wikiA, "concepts", "Draft.md"), "# Draft\n");
    let last = await syncRepo(wikiRepo(f), deps());
    for (let i = 0; i < 4; i++) last = await syncRepo(wikiRepo(f), deps());
    expect(last.state).toBe("deferred");
    expect(last.consecutiveDeferrals).toBeGreaterThanOrEqual(4);
    expect(last.tone).toBe("warn");
  });

  // ── Nested wiki: dirt OUTSIDE the wiki subtree ────────────────────────────

  test("tracked dirt OUTSIDE the wiki subtree does not stop the push when we are not behind", async () => {
    // huginn-jarvis's normal state: another process writes the rest of the repo
    // while the wiki subtree is ours. The rebase gate is whole-repo, so that
    // dirt refuses the rebase — but a rebase is only needed to integrate REMOTE
    // work, and there is none. Deferring here strands the wiki's own commits
    // forever while `ahead` grows.
    const f = await makeFixture(base);
    await writeFile(path.join(f.A, "README.md"), "the other process was here\n");
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.committed).toEqual(["wiki/concepts/Settled.md"]);
    expect(r.pushed).toBe(true);
    expect(r.state).toBe("ok");
    // The outside file was neither committed nor touched.
    expect((await git(f.A, ["status", "--porcelain"])).out).toContain("README.md");
    expect(await Bun.file(path.join(f.A, "README.md")).text()).toBe("the other process was here\n");
    // …and the narration says why no rebase ran.
    expect(r.actions.join(" | ")).toContain("outside the wiki subtree");
    // The outside path rides `deferredFiles`, so it must not read as something
    // this loop is holding back for a moment: it will NEVER commit it, and a
    // green `ok` card carrying it as an "uncommitted tracked change" invites
    // waiting for a tick that cannot help.
    const outside = r.deferredFiles.find((d) => d.path === "README.md");
    expect(outside?.reason).toContain("outside the sync scope");
  });

  test("outside-subtree dirt WHILE behind defers with an honest reason naming the real paths", async () => {
    const f = await makeFixture(base);
    await writeFile(path.join(f.wikiB, "concepts", "FromB.md"), "# FromB\n");
    await git(f.B, ["add", "-A"]);
    await git(f.B, ["commit", "-q", "-m", "B page"]);
    await git(f.B, ["push", "-q"]);
    await writeFile(path.join(f.A, "README.md"), "the other process was here\n");

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("deferred");
    expect(r.reason).toContain("outside the wiki subtree");
    expect(r.reason).toContain("README.md");
    // The old hardcoded reason blamed a wiki edit that was never happening.
    expect(r.reason).not.toContain("active edits");
    expect(r.behind).toBe(1);
  });

  test("a TRACKED denylisted file is committed rather than wedging the repo", async () => {
    // A committed `.obsidian/workspace.json` is routine in an Obsidian vault.
    // Dropped from staging it stays dirty, and tracked dirt refuses the rebase
    // on EVERY tick — the repo never converges again.
    const f = await makeFixture(base);
    await mkdir(path.join(f.wikiA, ".obsidian"), { recursive: true });
    const ws = path.join(f.wikiA, ".obsidian", "workspace.json");
    await writeFile(ws, "{}\n");
    await git(f.A, ["add", "-A"]);
    await git(f.A, ["commit", "-q", "-m", "track the vault workspace"]);
    await git(f.A, ["push", "-q"]);
    await writeFile(ws, '{"changed":true}\n');
    await ageFile(ws);

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("ok");
    expect(r.committed).toEqual(["wiki/.obsidian/workspace.json"]);
    expect(r.denied).toEqual([]);
    expect((await git(f.A, ["status", "--porcelain"])).out).toBe("");
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

  test("the RETRY's own commit and pull reach the report and the cache refresh", async () => {
    // The retry runs a second local section. Its results were thrown away: a
    // page it committed never appeared in `committed`, and — worse — the wiki
    // cache refresh was gated on the FIRST pass's headMoved, so pages pulled
    // during the retry rebase stayed invisible for the full 5-minute TTL.
    const f = await makeFixture(base);
    await writeFile(path.join(f.wikiB, "concepts", "FromB.md"), "# FromB\n");
    await git(f.B, ["add", "-A"]);
    await git(f.B, ["commit", "-q", "-m", "B page"]);

    const hookDir = path.join(f.A, ".git", "hooks");
    await mkdir(hookDir, { recursive: true });
    // Fires ONCE, between A's fetch and A's push: pushes B's commit (so A's push
    // is rejected) AND drops a settled page into A's wiki, which only the RETRY's
    // local section can pick up.
    const late = path.join(f.wikiA, "concepts", "Late.md");
    await writeFile(
      path.join(hookDir, "pre-push"),
      `#!/bin/sh\nif [ ! -f "$(git rev-parse --git-dir)/nff-fired" ]; then\n` +
        `  touch "$(git rev-parse --git-dir)/nff-fired"\n` +
        `  git -C ${JSON.stringify(f.B)} push -q\n` +
        `  printf '# Late\\n' > ${JSON.stringify(late)}\n` +
        `  touch -t 200001010000 ${JSON.stringify(late)}\n` +
        `fi\nexit 0\n`,
      { mode: 0o755 },
    );

    const page = path.join(f.wikiA, "concepts", "FromA.md");
    await writeFile(page, "# FromA\n");
    await ageFile(page);

    const refreshed: string[] = [];
    const r = await syncRepo(
      wikiRepo(f),
      deps({ refreshWikiIndex: async (root) => { refreshed.push(root); } }),
    );

    expect(r.state).toBe("ok");
    expect(r.pushed).toBe(true);
    expect(r.committed.sort()).toEqual(["wiki/concepts/FromA.md", "wiki/concepts/Late.md"]);
    // The retry's rebase pulled B's page — the reader must be told.
    expect(await Bun.file(path.join(f.wikiA, "concepts", "FromB.md")).exists()).toBe(true);
    expect(refreshed).toEqual([f.wikiA]);
    // Both machines' work is on the remote.
    expect((await git(f.A, ["status", "--porcelain"])).out).toBe("");
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

  test("plain mode defers on an unstaged TRACKED modification when there is something to pull", async () => {
    const f = await makeFixture(base);
    await writeFile(path.join(f.wikiB, "concepts", "FromB.md"), "# FromB\n");
    await git(f.B, ["add", "-A"]);
    await git(f.B, ["commit", "-q", "-m", "B page"]);
    await git(f.B, ["push", "-q"]);
    await writeFile(path.join(f.wikiA, "concepts", "Seed.md"), "# locally edited\n");
    const r = await syncRepo({ name: "skills", path: f.A, mode: "plain" }, deps());
    expect(r.state).toBe("deferred");
    expect(r.reason).toContain("uncommitted tracked change");
    expect(r.reason).toContain("wiki/concepts/Seed.md");
  });

  test("plain mode with local edits and NOTHING to pull is not a deferral", async () => {
    // A rebase exists to integrate remote work. With none, the refused rebase
    // costs nothing and the repo is genuinely up to date — deferring here just
    // accrued a streak that eventually turned the card amber for no reason.
    const f = await makeFixture(base);
    await writeFile(path.join(f.wikiA, "concepts", "Seed.md"), "# locally edited\n");
    const r = await syncRepo({ name: "skills", path: f.A, mode: "plain" }, deps());
    expect(r.state).toBe("ok");
    expect(r.actions.join(" | ")).toContain("rebase skipped");
    expect(r.dirtyCount).toBe(1);
  });

  // ── Dry run ───────────────────────────────────────────────────────────────

  test("dry-run reports the same plan the real run executes, and changes nothing", async () => {
    const f = await makeFixture(base);
    // A TRACKED modification, not a new untracked file: the untracked shape is
    // the ONE case that hid the projection bug, because untracked dirt does not
    // block a rebase. A tracked edit the dry run says it "would commit" is then
    // counted as rebase-blocking by the same dry run, so it reported a deferral
    // where the real run rebases and pushes — the two disagreed on the normal
    // case, which is the only case anyone dry-runs.
    const page = path.join(f.wikiA, "concepts", "Seed.md");
    await writeFile(page, "# Seed, edited and settled\n");
    await ageFile(page);
    await writeFile(path.join(f.wikiB, "concepts", "FromB.md"), "# FromB\n");
    await git(f.B, ["add", "-A"]);
    await git(f.B, ["commit", "-q", "-m", "B page"]);
    await git(f.B, ["push", "-q"]);

    const dry = await syncRepo(wikiRepo(f), deps(), true);
    expect(dry.dryRun).toBe(true);
    expect(dry.state).toBe("ok");
    expect(dry.committed).toEqual(["wiki/concepts/Seed.md"]);
    expect(dry.actions.join(" | ")).toContain("would commit 1 file(s)");
    expect(dry.actions.join(" | ")).toContain("would rebase onto");
    expect(dry.actions.join(" | ")).toContain("would push");
    // Nothing moved.
    expect((await git(f.A, ["log", "--format=%s"])).out).toBe("init");
    expect((await git(f.A, ["status", "--porcelain"])).out).toContain("wiki/concepts/Seed.md");
    // …and the ledger was NOT written, so a dry-run poll can't reset a streak.
    expect(dry.lastRunMs).toBeNull();

    const real = await syncRepo(wikiRepo(f), deps());
    expect(real.committed).toEqual(dry.committed);
    expect(real.state).toBe(dry.state);
    expect(real.pushed).toBe(true);
    expect(real.lastRunMs).not.toBeNull();
  });

  test("dry-run counts pre-existing commits honestly, not as work it would cause", async () => {
    const f = await makeFixture(base);
    // One commit already ahead of the remote, made by something else.
    await writeFile(path.join(f.wikiA, "concepts", "Earlier.md"), "# Earlier\n");
    await git(f.A, ["add", "-A"]);
    await git(f.A, ["commit", "-q", "-m", "an earlier commit"]);

    const dry = await syncRepo(wikiRepo(f), deps(), true);
    const narration = dry.actions.join(" | ");
    expect(narration).toContain("already ahead");
    expect(narration).not.toContain("would commit");
  });

  // ── Staging tolerance ─────────────────────────────────────────────────────

  test("a path that vanishes mid-tick is skipped, not turned into a whole-tick error", async () => {
    // An editor's atomic replace (write temp → rename over) lands between the
    // status listing and the `git add`. A batched add exits 128 for the whole
    // batch when ONE pathspec matches nothing.
    const f = await makeFixture(base);
    await writeFile(path.join(f.wikiA, "concepts", "Here.md"), "# Here\n");
    const res = await stagePaths(
      f.A,
      ["wiki/concepts/Here.md", "wiki/concepts/Vanished.md"],
      [],
    );
    expect(res.ok).toBe(true);
    expect(res.skipped).toEqual(["wiki/concepts/Vanished.md"]);
    const staged = await git(f.A, ["diff", "--cached", "--name-only"]);
    expect(staged.out).toBe("wiki/concepts/Here.md");
  });

  test("every staged path vanishing mid-tick commits NOTHING — least of all another process's staged work", async () => {
    // The C5 skip taken to its limit. `git commit -m … -m "" -- ` with an EMPTY
    // pathspec is a BARE `--`, which is no pathspec at all: git then commits
    // whatever happens to be in the index, i.e. the other process's staged work
    // (verified against real git before this test was written).
    //
    // The vanish is forced deterministically with a clean filter that removes
    // BOTH pages while git is staging the first: the batched add then exits 128
    // on the second, and each per-path retry finds its path gone ("did not match
    // any files") — exactly the editor-atomic-replace race `stagePaths`
    // tolerates, with nothing left over to commit.
    const f = await makeFixture(base);
    const goneA = path.join(f.wikiA, "concepts", "GoneA.md");
    const goneB = path.join(f.wikiA, "concepts", "GoneB.md");
    await writeFile(path.join(f.A, ".gitattributes"), "wiki/concepts/Gone*.md filter=vanish\n");
    await git(f.A, ["add", "-A"]);
    await git(f.A, ["commit", "-q", "-m", "attrs"]);
    await git(f.A, ["push", "-q"]);
    await git(f.A, ["config", "filter.vanish.clean", `rm -f "${goneA}" "${goneB}"; cat`]);
    await writeFile(goneA, "# A\n");
    await ageFile(goneA);
    await writeFile(goneB, "# B\n");
    await ageFile(goneB);
    // Another process's work, staged in the same repo and outside the wiki
    // subtree — the loop must never author a commit containing it.
    await writeFile(path.join(f.A, "README.md"), "the other process staged this\n");
    await git(f.A, ["add", "--", "README.md"]);

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.committed).toEqual([]);
    expect((await git(f.A, ["log", "--format=%s"])).out).not.toContain("[sync]");
    // Still staged, untouched, waiting for its own author to commit it.
    expect((await git(f.A, ["diff", "--cached", "--name-only"])).out).toBe("README.md");
    expect(r.actions.join(" | ")).toContain("nothing to commit — 2 path(s) vanished mid-tick");
    expect(r.pushed).toBe(false);
  });

  test("a real add failure is still an error", async () => {
    // A path that EXISTS and still cannot be staged — the tolerance is scoped to
    // "it vanished", never to "git refused".
    const f = await makeFixture(base);
    await writeFile(path.join(f.base, "outside-the-repo.md"), "x\n");
    const res = await stagePaths(f.A, ["../outside-the-repo.md"], []);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(res.skipped).toEqual([]);
  });

  test("the commit body is capped rather than listing every staged path", async () => {
    const f = await makeFixture(base);
    for (let i = 0; i < 25; i++) {
      const p = path.join(f.wikiA, "concepts", `P${String(i).padStart(2, "0")}.md`);
      await writeFile(p, `# P${i}\n`);
      await ageFile(p);
    }
    const r = await syncRepo(wikiRepo(f), deps());
    expect(r.state).toBe("ok");
    expect(r.committed).toHaveLength(25);
    const body = (await git(f.A, ["log", "-1", "--format=%b"])).out;
    expect(body.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(20);
    expect(body).toContain("and 5 more");
  });

  // ── Upstream fallback ─────────────────────────────────────────────────────

  test("a branch with no upstream is not pushed by guesswork — it says so instead", async () => {
    // `git push` with no argument and no upstream fails "no upstream" on EVERY
    // tick, which the card reported as a hard error forever.
    const f = await makeFixture(base);
    await git(f.A, ["branch", "--unset-upstream"]);
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.upstreamFallback).toBe(true);
    expect(r.committed).toEqual(["wiki/concepts/Settled.md"]); // the work is safe locally
    expect(r.pushed).toBe(false);
    expect(r.state).toBe("blocked");
    expect(r.reason).toContain("no upstream");
    expect(r.reason).toContain("git push -u");
    // Nothing was pushed under a guessed refspec.
    expect((await git(f.bare, ["log", "--format=%s"])).out).not.toContain("[sync]");
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

  test("a held deletion is not reported as a file someone edited in the last 5 min", async () => {
    // The quiet filter holds the fresh page, and pass 3 holds the deletion
    // BEHIND it (an unstaged `mv` is ` D old` + `?? new`). Both landed in the
    // same `quietHeld` list, so the card claimed two files were being edited —
    // one of which does not exist any more. The count sends you looking for an
    // editing session that is half imaginary.
    const f = await makeFixture(base);
    const doomed = path.join(f.wikiA, "concepts", "Doomed.md");
    await writeFile(doomed, "# Doomed\n");
    await git(f.A, ["add", "-A"]);
    await git(f.A, ["commit", "-q", "-m", "seed doomed"]);
    await git(f.A, ["push", "-q"]);
    await rm(doomed);
    await writeFile(path.join(f.wikiA, "concepts", "Fresh.md"), "# Fresh\n");

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("deferred");
    expect(r.reason).toContain("holding 1 file edited in the last 5 min");
    expect(r.reason).toContain("wiki/concepts/Fresh.md");
    // The deletion is still NAMED — it is genuinely held — but under its own
    // clause, never inflating the edit count.
    expect(r.reason).toContain("wiki/concepts/Doomed.md");
    expect(r.reason).toContain("deletion");
    expect(r.reason).not.toContain("2 files edited");
    expect(r.committed).toEqual([]);
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

  // ── Sweeper subsumption ───────────────────────────────────────────────────

  test("subsumption requires EVIDENCE the loop actually runs, not just configuration", async () => {
    // `SYNC_REPOS` being parseable made the daily sweeper stand down forever —
    // even on a machine where nothing ever curls the endpoint (a launchd job
    // that was never installed, a plist that silently failed to load). That
    // recreates the 2026-07-23 page-loss shape: nobody commits the wiki at all.
    const f = await makeFixture(base);
    const repos = [wikiRepo(f)];
    const top = (await git(f.A, ["rev-parse", "--show-toplevel"])).out;

    const cold = await syncSubsumesSweeper(top, { repos });
    expect(cold.subsumed).toBe(false);
    expect(cold.configuredButIdle).toBe(true);

    // One real tick, and the sweeper stands down.
    await syncRepo(wikiRepo(f), deps());
    const warm = await syncSubsumesSweeper(top, { repos });
    expect(warm.subsumed).toBe(true);
    expect(warm.configuredButIdle).toBe(false);

    // …but a run that is older than the sweeper's own daily cadence is no
    // longer evidence of anything.
    const stale = await syncSubsumesSweeper(top, {
      repos,
      now: Date.now() + SYNC_SUBSUME_MAX_AGE_MS + 60_000,
    });
    expect(stale.subsumed).toBe(false);
    expect(stale.configuredButIdle).toBe(true);
  });

  test("a tick that errors at FETCH is not evidence — the sweeper does not stand down", async () => {
    // The freshness clock used to be `lastRunMs`, which `recordLedger` stamps on
    // EVERY tick, including one that returned at the failed fetch — before any
    // local or commit section ran. So an unreachable origin (offline, VPN down,
    // an expired deploy key) left the loop erroring every 15 minutes while it
    // held the sweeper down forever: the 2026-07-23 page-loss shape reached
    // through "the loop runs but never commits".
    const f = await makeFixture(base);
    const repos = [wikiRepo(f)];
    const top = (await git(f.A, ["rev-parse", "--show-toplevel"])).out;

    await git(f.A, ["remote", "set-url", "origin", path.join(base, "gone.git")]);
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);

    const r = await syncRepo(wikiRepo(f), deps());
    expect(r.state).toBe("error");
    expect(r.reason).toContain("git fetch failed");
    expect(r.committed).toEqual([]);
    // The RUN is still recorded — the card has to show the failing tick.
    expect(getSyncLedgerEntry("fixture").lastRunMs).not.toBeNull();
    // …and the page is still sitting there uncommitted, which is exactly what
    // the sweeper exists to catch.
    expect((await git(f.A, ["status", "--porcelain"])).out).toContain("Settled.md");

    const res = await syncSubsumesSweeper(top, { repos });
    expect(res.subsumed).toBe(false);
    expect(res.configuredButIdle).toBe(true);
  });

  test("a local pass keeps subsuming while the remote is down — for one sweeper period, not forever", async () => {
    const f = await makeFixture(base);
    const repos = [wikiRepo(f)];
    const top = (await git(f.A, ["rev-parse", "--show-toplevel"])).out;

    const first = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(first, "# Settled\n");
    await ageFile(first);
    expect((await syncRepo(wikiRepo(f), deps())).state).toBe("ok");

    // The remote goes away AFTER a healthy pass.
    await git(f.A, ["remote", "set-url", "origin", path.join(base, "gone.git")]);
    const second = path.join(f.wikiA, "concepts", "Later.md");
    await writeFile(second, "# Later\n");
    await ageFile(second);
    expect((await syncRepo(wikiRepo(f), deps())).state).toBe("error");

    // A local pass minutes ago is still evidence — sweeping on top of a loop
    // that IS committing would fight it — so the grace window stays the same
    // ~26h the evidence rule has always used…
    const now = Date.now();
    expect((await syncSubsumesSweeper(top, { repos, now })).subsumed).toBe(true);
    // …and it EXPIRES, instead of being renewed by ticks that commit nothing.
    const stale = await syncSubsumesSweeper(top, {
      repos,
      now: now + SYNC_SUBSUME_MAX_AGE_MS + 60_000,
    });
    expect(stale.subsumed).toBe(false);
    expect(stale.configuredButIdle).toBe(true);
  });

  test("a BLOCKED tick still subsumes — the sweeper would commit the half-finished merge", async () => {
    // `blocked` is the unmerged-paths refusal, and the sweeper has no pre-flight
    // of its own (`listWikiSubtreeDirty` treats a `UU` entry as ordinary dirt),
    // so routing a blocked tick to it would stage and commit a human's conflict
    // markers. Only `error`-shaped ticks that never reached the local section
    // may fall through.
    const f = await makeFixture(base);
    const repos = [wikiRepo(f)];
    const top = (await git(f.A, ["rev-parse", "--show-toplevel"])).out;

    await writeFile(path.join(f.wikiA, "concepts", "Seed.md"), "# Seed\nA line\n");
    await git(f.A, ["commit", "-qam", "A edit"]);

    await git(f.B, ["pull", "-q"]);
    await writeFile(path.join(f.wikiB, "concepts", "Seed.md"), "# Seed\nB line\n");
    await git(f.B, ["commit", "-qam", "B edit"]);
    await git(f.B, ["push", "-q"]);

    await git(f.A, ["fetch", "-q"]);
    await git(f.A, ["merge", "origin/main"]);
    // Drop the in-progress markers: what a CRASHED merge leaves behind is
    // unmerged index entries with nothing for pre-flight to see, which is how a
    // tick reaches the post-fetch unmerged check at all.
    for (const marker of ["MERGE_HEAD", "MERGE_MSG", "AUTO_MERGE"]) {
      await rm(path.join(f.A, ".git", marker), { force: true, recursive: true });
    }
    expect((await git(f.A, ["status", "--porcelain"])).out).toContain("UU ");

    const r = await syncRepo(wikiRepo(f), deps());
    expect(r.state).toBe("blocked");
    expect(r.reason).toContain("unmerged paths");
    expect(r.committed).toEqual([]);

    const res = await syncSubsumesSweeper(top, { repos });
    expect(res.subsumed).toBe(true);
    expect(res.configuredButIdle).toBe(false);
  });

  test("an uncovered repo is not 'configured but idle' — it is simply not ours", async () => {
    const f = await makeFixture(base);
    const top = (await git(f.A, ["rev-parse", "--show-toplevel"])).out;
    const res = await syncSubsumesSweeper(top, { repos: [] });
    expect(res.subsumed).toBe(false);
    expect(res.configuredButIdle).toBe(false);
  });

  test("a non-repo path is an error, never a throw", async () => {
    const loose = await mkdtemp(path.join(base, "loose-"));
    const r = await syncRepo({ name: "nope", path: loose, mode: "plain" }, deps());
    expect(r.state).toBe("error");
    expect(r.reason).toContain("not a git repo");
  });

  test("the in-flight 'running' answer never touches the ledger", async () => {
    // `running` means "we did nothing" — recording it zeroed the deferral streak
    // and cleared the last error, so a card polled during a slow tick went green
    // and the escalation restarted from scratch.
    const f = await makeFixture(base);
    await writeFile(path.join(f.wikiA, "concepts", "Seed.md"), "# live edit\n");
    for (let i = 0; i < 4; i++) await syncRepo(wikiRepo(f), deps());
    expect(getSyncLedgerEntry("fixture").consecutiveDeferrals).toBe(4);

    const [a, b] = await Promise.all([
      syncRepo(wikiRepo(f), deps()),
      syncRepo(wikiRepo(f), deps()),
    ]);
    const running = [a, b].find((r) => r.state === "running")!;
    expect(running).toBeDefined();
    // The streak the card shows is the REAL one, both on the answer and after.
    expect(running.consecutiveDeferrals).toBe(4);
    expect(getSyncLedgerEntry("fixture").consecutiveDeferrals).toBe(5);
    expect(getSyncLedgerEntry("fixture").state).toBe("deferred");
  });

  test("a push failure lands on the card's lastError, not only in the reason", async () => {
    const f = await makeFixture(base);
    // A pre-push hook that refuses for a reason that is NOT "the remote moved".
    const hookDir = path.join(f.A, ".git", "hooks");
    await mkdir(hookDir, { recursive: true });
    await writeFile(
      path.join(hookDir, "pre-push"),
      "#!/bin/sh\necho 'refusing: pre-push policy said no' 1>&2\nexit 1\n",
      { mode: 0o755 },
    );
    const page = path.join(f.wikiA, "concepts", "Settled.md");
    await writeFile(page, "# Settled\n");
    await ageFile(page);

    const r = await syncRepo(wikiRepo(f), deps());

    expect(r.state).toBe("error");
    expect(r.reason).toContain("git push failed");
    expect(r.error).toContain("pre-push policy said no");
    // The card reads the LEDGER, which is where the error has to survive.
    expect(getSyncLedgerEntry("fixture").lastError).toContain("pre-push policy said no");
    const status = await readRepoStatus(wikiRepo(f), Date.now());
    expect(status.error).toContain("pre-push policy said no");
  });

  test("a repo that has never synced reads as 'not synced yet', not as 'in sync'", async () => {
    const f = await makeFixture(base);
    const status = await readRepoStatus(wikiRepo(f), Date.now());
    expect(status.lastRunMs).toBeNull();
    expect(status.label).toBe("not synced yet");
    expect(status.tone).toBe("neutral");
    // …and the machine-readable field agrees with the two human ones. The
    // ledger's default `ok` rode the payload while the label said otherwise, so
    // any consumer reading `state` (rather than `label`) saw a green lie.
    expect(status.state).toBe("unknown");
  });

  test("lock order is pinned on the QUEUE KEY, not the configured spelling", async () => {
    // The locks are realpath-keyed (`wikiWriteQueueKey`), so sorting the raw
    // configured strings is an incidental total order: two repos naming one wiki
    // through different paths would take the same two locks in OPPOSITE orders,
    // which is the deadlock the sort exists to prevent.
    const m1 = path.join(base, "m1");
    const m2 = path.join(base, "m2");
    await mkdir(m1);
    await mkdir(m2);
    const link = path.join(base, "z-link"); // spells m1, sorts after m2
    await symlink(m1, link);

    const repo: SyncRepo = { name: "multi", path: base, mode: "plain", containedWikiRoots: [link, m2] };
    expect([link, m2].slice().sort()).toEqual([m2, link]); // the raw order…
    expect(sortedLockRoots(repo)).toEqual([link, m2]); // …is not the key order

    // Two spellings of ONE wiki (the registry dedupes by name only, so aliases
    // reach here) must collapse to one lock take — the same chain key nested
    // inside itself never resolves.
    const aliased: SyncRepo = { name: "alias", path: base, mode: "plain", containedWikiRoots: [m1, link, m2] };
    expect(sortedLockRoots(aliased)).toHaveLength(2);
    expect(new Set(sortedLockRoots(aliased).map((r) => [m1, link].includes(r) ? "m1" : "m2")).size).toBe(2);
  });

  test("a five-line git failure is clamped to one card line, with the full text on lastError", async () => {
    const f = await makeFixture(base);
    await git(f.A, ["remote", "set-url", "origin", "ssh://127.0.0.1:1/nope.git"]);
    const r = await syncRepo(wikiRepo(f), deps());
    expect(r.state).toBe("error");
    expect(r.reason).not.toContain("\n");
    expect(r.reason!.length).toBeLessThanOrEqual(160);
    expect(r.label).not.toContain("\n");
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
