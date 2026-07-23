import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitWikiChange, __resetForTest } from "./commit.ts";

/**
 * A barrier over the async-push seam: `onPushSettled` resolves `done`, so a test
 * can await push completion (or the immediate no-push settle) deterministically
 * instead of sleeping.
 */
function pushBarrier(): { done: Promise<void>; onPushSettled: () => void } {
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  return { done, onPushSettled: () => resolve() };
}

/** Run `git -C <cwd> <args…>` in a fixture repo, returning trimmed stdout. */
async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  const code = await proc.exited;
  return { code, out };
}

/**
 * Build a fixture repo with the wiki nested two levels down (repo/data/wiki),
 * mirroring the real `huginn-jarvis/data/wiki` layout, with one initial commit
 * so HEAD + a default `main` branch exist. Returns { repo, wikiDir }.
 */
async function makeRepo(base: string): Promise<{ repo: string; wikiDir: string }> {
  const repo = await mkdtemp(path.join(base, "repo-"));
  const wikiDir = path.join(repo, "data", "wiki");
  await mkdir(path.join(wikiDir, "concepts"), { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "a@b.c"]);
  await git(repo, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(repo, "README.md"), "root\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  return { repo, wikiDir };
}

describe("commitWikiChange", () => {
  let base: string;

  beforeEach(async () => {
    __resetForTest();
    base = await mkdtemp(path.join(tmpdir(), "wiki-commit-"));
  });
  afterEach(async () => {
    __resetForTest();
    await rm(base, { recursive: true, force: true });
  });

  test("derives the toplevel from a nested wikiDir and stages repo-relative", async () => {
    const { repo, wikiDir } = await makeRepo(base);
    await writeFile(path.join(wikiDir, "concepts", "Agent Loops.md"), "# Agent Loops\n");

    await commitWikiChange(wikiDir, ["concepts/Agent Loops.md"], "[gardener] apply: concepts/Agent Loops.md");

    // Exactly one new commit with the given message.
    const log = await git(repo, ["log", "--format=%s"]);
    expect(log.out.split("\n")).toEqual([
      "[gardener] apply: concepts/Agent Loops.md",
      "init",
    ]);
    // The staged path was translated to repo-relative (data/wiki/…).
    const names = await git(repo, ["show", "--name-only", "--format=", "HEAD"]);
    expect(names.out).toBe("data/wiki/concepts/Agent Loops.md");
    // Tree clean afterward.
    const status = await git(repo, ["status", "--porcelain"]);
    expect(status.out).toBe("");
  });

  test("stages ONLY the given paths — a second dirty file stays uncommitted", async () => {
    const { repo, wikiDir } = await makeRepo(base);
    await writeFile(path.join(wikiDir, "concepts", "X.md"), "# X\n");
    // An unrelated dirty file elsewhere in the repo.
    await writeFile(path.join(repo, "README.md"), "root changed\n");

    await commitWikiChange(wikiDir, ["concepts/X.md"], "[gardener] apply: concepts/X.md");

    const names = await git(repo, ["show", "--name-only", "--format=", "HEAD"]);
    expect(names.out).toBe("data/wiki/concepts/X.md");
    // README.md still shows as modified — never staged by us (leading porcelain
    // space is trimmed by the test git helper; presence is what matters).
    const status = await git(repo, ["status", "--porcelain"]);
    expect(status.out).toContain("M README.md");
  });

  test("passes the caller's message through verbatim", async () => {
    const { repo, wikiDir } = await makeRepo(base);
    await mkdir(path.join(wikiDir, "sources"), { recursive: true });
    await writeFile(path.join(wikiDir, "sources", "S.md"), "# S\n");

    await commitWikiChange(wikiDir, ["sources/S.md"], "[source-drafter] draft: sources/S.md");

    const subject = await git(repo, ["log", "-1", "--format=%s"]);
    expect(subject.out).toBe("[source-drafter] draft: sources/S.md");
  });

  test("wikiDir outside any git repo → skip, non-fatal", async () => {
    const nonRepo = await mkdtemp(path.join(base, "loose-"));
    await writeFile(path.join(nonRepo, "note.md"), "# note\n");
    // Must not throw.
    await commitWikiChange(nonRepo, ["note.md"], "[gardener] apply: note.md");
    // No .git created.
    const status = await git(nonRepo, ["status"]);
    expect(status.code).not.toBe(0);
  });

  test("non-default branch → write survives, commit skipped", async () => {
    const { repo, wikiDir } = await makeRepo(base);
    await git(repo, ["checkout", "-q", "-b", "feature/x"]);
    const file = path.join(wikiDir, "concepts", "Y.md");
    await writeFile(file, "# Y\n");

    const result = await commitWikiChange(wikiDir, ["concepts/Y.md"], "[gardener] apply: concepts/Y.md");

    // The skip is reported honestly to the caller.
    expect(result).toEqual({ committed: false, reason: "not-default-branch" });
    // No new commit — still just "init".
    const log = await git(repo, ["log", "--format=%s"]);
    expect(log.out).toBe("init");
    // The written file survives on disk, uncommitted.
    expect(await Bun.file(file).text()).toBe("# Y\n");
    expect((await git(repo, ["status", "--porcelain"])).out).toContain("data/");
  });

  test("returns a truthful result — committed on success, reasoned skips", async () => {
    const { wikiDir } = await makeRepo(base);
    await writeFile(path.join(wikiDir, "concepts", "H.md"), "# H\n");

    // Happy path → committed: true.
    const ok = await commitWikiChange(wikiDir, ["concepts/H.md"], "[gardener] apply: concepts/H.md");
    expect(ok).toEqual({ committed: true });

    // Re-commit the unchanged file → nothing staged.
    const noop = await commitWikiChange(wikiDir, ["concepts/H.md"], "[gardener] apply: concepts/H.md");
    expect(noop).toEqual({ committed: false, reason: "nothing-to-commit" });

    // Empty pathspec → nothing-to-commit.
    const empty = await commitWikiChange(wikiDir, [], "noop");
    expect(empty).toEqual({ committed: false, reason: "nothing-to-commit" });
  });

  test("wikiDir outside any git repo → { committed:false, reason:'not-a-repo' }", async () => {
    const nonRepo = await mkdtemp(path.join(base, "loose2-"));
    await writeFile(path.join(nonRepo, "note.md"), "# note\n");
    const result = await commitWikiChange(nonRepo, ["note.md"], "[gardener] apply: note.md");
    expect(result).toEqual({ committed: false, reason: "not-a-repo" });
  });

  test("nothing changed → no commit", async () => {
    const { repo, wikiDir } = await makeRepo(base);
    const file = path.join(wikiDir, "concepts", "Z.md");
    await writeFile(file, "# Z\n");
    await commitWikiChange(wikiDir, ["concepts/Z.md"], "[gardener] apply: concepts/Z.md");
    const before = await git(repo, ["rev-parse", "HEAD"]);

    // Re-commit the SAME unchanged file — stages an empty diff, must skip.
    await commitWikiChange(wikiDir, ["concepts/Z.md"], "[gardener] apply: concepts/Z.md");
    const after = await git(repo, ["rev-parse", "HEAD"]);

    expect(after.out).toBe(before.out);
    const count = await git(repo, ["rev-list", "--count", "HEAD"]);
    expect(count.out).toBe("2"); // init + the single real commit
  });

  test("serializes concurrent commits — both land as distinct commits, neither dropped", async () => {
    const { repo, wikiDir } = await makeRepo(base);
    await writeFile(path.join(wikiDir, "concepts", "A.md"), "# A\n");
    await writeFile(path.join(wikiDir, "concepts", "B.md"), "# B\n");

    // Fire both without awaiting between — the per-repo queue must serialize them
    // (a plain `git add`/`commit` race would drop or corrupt one). Ordering between
    // two truly-simultaneous calls is not guaranteed (each resolves its toplevel
    // first), but BOTH must produce their own commit and the tree must end clean.
    await Promise.all([
      commitWikiChange(wikiDir, ["concepts/A.md"], "first"),
      commitWikiChange(wikiDir, ["concepts/B.md"], "second"),
    ]);

    const subjects = (await git(repo, ["log", "--format=%s"])).out.split("\n");
    expect(subjects).toContain("first");
    expect(subjects).toContain("second");
    // Exactly two new commits on top of init (no double-commit, no drop).
    expect((await git(repo, ["rev-list", "--count", "HEAD"])).out).toBe("3");
    // Each commit carries exactly its own file.
    expect((await git(repo, ["status", "--porcelain"])).out).toBe("");
  });

  test("push skipped when the repo has no remote (no throw)", async () => {
    const { repo, wikiDir } = await makeRepo(base);
    await writeFile(path.join(wikiDir, "concepts", "P.md"), "# P\n");
    // Default push:true — but no remote, so the push is a no-op, and the commit lands.
    const b = pushBarrier();
    await commitWikiChange(wikiDir, ["concepts/P.md"], "[gardener] apply: concepts/P.md", {
      onPushSettled: b.onPushSettled,
    });
    await b.done; // the dispatched push settled (no-remote no-op)
    const subject = await git(repo, ["log", "-1", "--format=%s"]);
    expect(subject.out).toBe("[gardener] apply: concepts/P.md");
  });

  test("push skipped when a remote exists but no upstream is set (no throw)", async () => {
    const { repo, wikiDir } = await makeRepo(base);
    await git(repo, ["remote", "add", "origin", path.join(base, "does-not-exist.git")]);
    await writeFile(path.join(wikiDir, "concepts", "Q.md"), "# Q\n");
    // Remote present, no tracking branch → upstream lookup fails → push skipped, commit lands.
    const b = pushBarrier();
    await commitWikiChange(wikiDir, ["concepts/Q.md"], "[gardener] apply: concepts/Q.md", {
      onPushSettled: b.onPushSettled,
    });
    await b.done;
    const subject = await git(repo, ["log", "-1", "--format=%s"]);
    expect(subject.out).toBe("[gardener] apply: concepts/Q.md");
  });

  test("push:false commits locally without attempting a push", async () => {
    const { repo, wikiDir } = await makeRepo(base);
    await writeFile(path.join(wikiDir, "concepts", "R.md"), "# R\n");
    const b = pushBarrier();
    await commitWikiChange(wikiDir, ["concepts/R.md"], "[gardener] apply: concepts/R.md", {
      push: false,
      onPushSettled: b.onPushSettled,
    });
    await b.done; // settles immediately — no push attempted
    const subject = await git(repo, ["log", "-1", "--format=%s"]);
    expect(subject.out).toBe("[gardener] apply: concepts/R.md");
  });

  test("commit is awaited but the push is dispatched async — the seam settles it", async () => {
    // A real bare remote with an upstream. commitWikiChange resolves as soon as the
    // COMMIT lands (local + fast); the push runs asynchronously and only after the
    // seam fires has the remote received it.
    const { repo, wikiDir } = await makeRepo(base);
    const bare = path.join(base, "remote.git");
    await git(base, ["init", "--bare", "-b", "main", bare]);
    await git(repo, ["remote", "add", "origin", bare]);
    await git(repo, ["push", "-u", "origin", "main"]);

    await writeFile(path.join(wikiDir, "concepts", "Pushed.md"), "# Pushed\n");
    const b = pushBarrier();
    await commitWikiChange(wikiDir, ["concepts/Pushed.md"], "[gardener] apply: concepts/Pushed.md", {
      onPushSettled: b.onPushSettled,
    });

    // The commit is present locally the moment commitWikiChange resolves.
    const localSubject = await git(repo, ["log", "-1", "--format=%s"]);
    expect(localSubject.out).toBe("[gardener] apply: concepts/Pushed.md");

    // Await the dispatched push, then the bare remote carries the commit.
    await b.done;
    const remoteSubject = await git(bare, ["log", "-1", "--format=%s"]);
    expect(remoteSubject.out).toBe("[gardener] apply: concepts/Pushed.md");
  });

  test("a foreign pre-staged file is NOT swept into the wiki commit", async () => {
    const { repo, wikiDir } = await makeRepo(base);
    await writeFile(path.join(wikiDir, "concepts", "F.md"), "# F\n");
    // Someone else pre-staged an unrelated change into the index before our commit.
    await writeFile(path.join(repo, "README.md"), "root changed by a foreign actor\n");
    await git(repo, ["add", "README.md"]);

    await commitWikiChange(wikiDir, ["concepts/F.md"], "[gardener] apply: concepts/F.md", {
      push: false,
    });

    // The commit carries ONLY our page — never the foreign pre-staged README.
    const names = await git(repo, ["show", "--name-only", "--format=", "HEAD"]);
    expect(names.out).toBe("data/wiki/concepts/F.md");
    // The foreign change is still staged, uncommitted (partial commit left it alone).
    const staged = await git(repo, ["diff", "--cached", "--name-only"]);
    expect(staged.out).toContain("README.md");
  });

  test("a missing path (failed log.md write) is dropped — the page still commits", async () => {
    const { repo, wikiDir } = await makeRepo(base);
    await writeFile(path.join(wikiDir, "concepts", "G.md"), "# G\n");
    // log.md was never written (best-effort write failed) — it must not abort the batch.
    await commitWikiChange(
      wikiDir,
      ["concepts/G.md", "log.md"],
      "[gardener] apply: concepts/G.md",
      { push: false },
    );

    const subject = await git(repo, ["log", "-1", "--format=%s"]);
    expect(subject.out).toBe("[gardener] apply: concepts/G.md");
    const names = await git(repo, ["show", "--name-only", "--format=", "HEAD"]);
    expect(names.out).toBe("data/wiki/concepts/G.md"); // only the page — log.md dropped
    expect((await git(repo, ["status", "--porcelain"])).out).toBe("");
  });
});
