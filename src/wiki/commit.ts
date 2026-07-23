/**
 * Commit seam for muninn's programmatic wiki writers.
 *
 * muninn writes into a bot's knowledge wiki (`wikiDir`) from several paths — the
 * gardener apply step (gardener concepts/entities + auto-drafted source pages),
 * the fact-check appender, and offline scripts — but historically never committed
 * those writes. A wiki repo therefore accumulated uncommitted pages, and a sibling
 * tool running `git clean` in that repo silently deleted them (the 2026-07-23
 * huginn-jarvis incident: 128 pages lost). This PR wires the gardener-apply seam:
 * every gardener concept/entity apply and every source-drafter page now commits the
 * files it touched. The fact-check appender and the offline scripts follow in PR 2.
 *
 * Design constraints (enforced by construction):
 *  - Callers hold the wiki DIRECTORY (e.g. `…/huginn-jarvis/data/wiki`), not the
 *    git repo root. We derive the toplevel via `rev-parse` and translate every
 *    wiki-relative path to repo-relative before staging.
 *  - We stage ONLY the explicit paths given (`git add -- <path>…`) — never
 *    `git add -A` — AND commit with the same explicit pathspec
 *    (`git commit -m <msg> -- <paths>`), so neither an unrelated dirty file NOR a
 *    foreign pre-staged index entry is ever swept into a wiki-attributed commit.
 *  - This helper NEVER runs a destructive git verb. The only git subcommands it
 *    ever spawns are `rev-parse`, `symbolic-ref`, `branch`, `remote`, `status`,
 *    `diff`, `add -- <paths>`, `commit -- <paths>`, and `push`. No clean/checkout/
 *    restore/stash/reset, ever.
 *  - Commit only on the repo's DEFAULT branch — a feature-branch checkout is left
 *    for the later sweeper to pick up.
 *  - The COMMIT is awaited (local + fast — after this resolves the tree is clean).
 *    The PUSH is a network op: it is dispatched onto the SAME per-toplevel queue
 *    (so it never interleaves a subsequent commit) but is NOT awaited by the
 *    caller, so an approve HTTP request never blocks on the network.
 *  - Every failure is non-fatal: it logs a warning and returns; it never throws
 *    out of the helper and never blocks the write that preceded it.
 *
 * Serialized by a per-repo (per-toplevel) in-memory queue so two writes into the
 * same wiki can't interleave their stage/commit — and a dispatched push chains
 * onto that same queue.
 */

import path from "node:path";
import { realpath } from "node:fs/promises";
import { getLog } from "../logging.ts";

const log = getLog("wiki", "commit");

export interface CommitWikiOpts {
  /**
   * Push the commit to its upstream after committing. Default `true` — but only
   * for a repo that actually has a remote AND a configured upstream; otherwise
   * the push is skipped with a warning (we never create an upstream). Set `false`
   * (per-bot `wikiAutoCommit.push`) to commit locally without pushing.
   *
   * The push is dispatched asynchronously (not awaited by the caller) — see the
   * module doc. It is serialized behind any subsequent commit on the same repo.
   */
  push?: boolean;
  /**
   * Test/observability seam — invoked once the dispatched push settles (success
   * OR failure), OR immediately when no push is attempted (nothing committed,
   * `push:false`, no remote/upstream). Lets a test await push completion
   * deterministically instead of sleeping. Never receives the push error (a push
   * failure is a warn, not a caller-visible error).
   */
  onPushSettled?: () => void;
}

/**
 * Truthful outcome of a `commitWikiChange` call. `committed` is `true` only when a
 * commit actually landed on the default branch; every skip path reports `false`
 * with a `reason` so callers can log an honest message instead of assuming success.
 * Additive — callers that ignore the return keep working unchanged.
 */
export interface CommitWikiResult {
  committed: boolean;
  reason?: "not-a-repo" | "not-default-branch" | "nothing-to-commit" | "error";
}

/** Result of one git invocation. */
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn `git -C <cwd> <args…>` and collect its output. Never throws.
 *
 * `GIT_TERMINAL_PROMPT=0` (merged over the process env) makes any git op that
 * would otherwise prompt for credentials — e.g. a `push` to an https remote with
 * no credential helper — fail fast instead of hanging waiting on stdin. */
async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** True when `abs` exists on disk (a file). Never throws. */
async function pathExists(abs: string): Promise<boolean> {
  try {
    return await Bun.file(abs).exists();
  } catch {
    return false;
  }
}

// ── Per-repo (per-toplevel) serialization queue ──────────────────────────────
//
// Unlike the gardener mutex (which SKIPS when busy), a second wiki commit must
// not be dropped — it queues behind the first. Same Map<key, Promise> shape,
// released in `.finally()`, but callers await the previous run before starting.

const commitChains = new Map<string, Promise<unknown>>();

function runExclusiveQueued<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = commitChains.get(key) ?? Promise.resolve();
  const run = prev.then(
    () => work(),
    () => work(),
  );
  commitChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** Test-only: clear the per-repo commit queue between cases. */
export function __resetForTest(): void {
  commitChains.clear();
}

/**
 * Resolve the git toplevel that contains `wikiDir`, or null when `wikiDir` is
 * outside any git repo (a non-fatal skip condition).
 */
async function gitToplevel(wikiDir: string): Promise<string | null> {
  const r = await git(wikiDir, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0 || !r.stdout) return null;
  return r.stdout;
}

/**
 * The repo's default branch name (`main`, `master`, …). Read from
 * `origin/HEAD`; when that's absent (e.g. a local repo with no remote) returns
 * null and the caller falls back to treating `main`/`master` as default.
 */
async function defaultBranch(top: string): Promise<string | null> {
  const r = await git(top, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (r.code === 0 && r.stdout) {
    const m = r.stdout.match(/refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1] ?? null;
  }
  return null;
}

/** True when the repo is currently checked out on its default branch. */
async function onDefaultBranch(top: string): Promise<boolean> {
  const current = (await git(top, ["branch", "--show-current"])).stdout;
  if (!current) return false; // detached HEAD — never our default
  const def = await defaultBranch(top);
  return def ? current === def : current === "main" || current === "master";
}

/**
 * Stage the given wiki-relative paths and commit them under `message`, on the
 * default branch of the repo containing `wikiDir`, then optionally push. All
 * failures degrade to a warning — this never throws and never blocks the write.
 *
 * @param wikiDir absolute wiki root the caller wrote into
 * @param paths   wiki-relative paths to stage (e.g. `concepts/X.md`, `log.md`)
 * @param message full commit message (`[<writer>] <verb>: <page>`) — the caller
 *                owns the convention; this helper does not invent it
 */
export async function commitWikiChange(
  wikiDir: string,
  paths: string[],
  message: string,
  opts: CommitWikiOpts = {},
): Promise<CommitWikiResult> {
  const settlePush = () => {
    try {
      opts.onPushSettled?.();
    } catch {
      /* seam callback must never break the commit */
    }
  };
  try {
    const top = await gitToplevel(wikiDir);
    if (!top) {
      log.warn("Wiki commit skipped — {dir} is not inside a git repo", { dir: wikiDir });
      settlePush();
      return { committed: false, reason: "not-a-repo" };
    }
    const staged = paths.filter((p) => p && p.length > 0);
    if (staged.length === 0) {
      settlePush();
      return { committed: false, reason: "nothing-to-commit" };
    }

    // Commit is awaited — after this resolves the working tree is clean.
    const result = await runExclusiveQueued(top, () =>
      commitInner(top, wikiDir, staged, message),
    );

    // The push is a network op — it must NOT block the caller (an approve HTTP
    // request). Dispatch it onto the SAME per-toplevel queue so it can't
    // interleave a subsequent commit, but do not await that queue entry here.
    if (result.committed && opts.push !== false) {
      const pushDone = runExclusiveQueued(top, () => pushInner(top));
      pushDone.then(settlePush, settlePush);
    } else {
      settlePush();
    }
    return result;
  } catch (err) {
    // Belt-and-suspenders: commitInner already swallows its own errors.
    log.warn("Wiki commit failed for {dir}: {error}", {
      dir: wikiDir,
      error: err instanceof Error ? err.message : String(err),
    });
    settlePush();
    return { committed: false, reason: "error" };
  }
}

/**
 * Stage + commit the given wiki-relative paths on the default branch. Returns
 * `{ committed: true }` when a commit landed (so the caller can decide whether to
 * dispatch a push), otherwise `{ committed: false, reason }` for the specific skip
 * or failure. Never throws.
 */
async function commitInner(
  top: string,
  wikiDir: string,
  paths: string[],
  message: string,
): Promise<CommitWikiResult> {
  if (!(await onDefaultBranch(top))) {
    log.warn(
      "Wiki commit skipped — {top} is not on its default branch (a sweeper will pick up the write)",
      { top },
    );
    return { committed: false, reason: "not-default-branch" };
  }

  // Translate wiki-relative → repo-relative for staging. `git rev-parse` returns
  // a canonicalized toplevel (symlinks resolved — e.g. macOS /tmp → /private/tmp),
  // so canonicalize wikiDir the same way before diffing, else `path.relative`
  // produces a bogus `../../…` escape when the two disagree on symlinked prefixes.
  const canonicalWiki = await realpath(wikiDir).catch(() => wikiDir);

  // Filter to paths that actually exist on disk. A best-effort write (e.g. the
  // log.md append) may have failed — a missing path must not abort the whole
  // batch (git add/commit would error on it), so drop it and commit the rest.
  const repoRel: string[] = [];
  const dropped: string[] = [];
  for (const p of paths) {
    const abs = path.join(canonicalWiki, p);
    if (await pathExists(abs)) {
      repoRel.push(path.relative(top, abs));
    } else {
      dropped.push(p);
    }
  }
  if (dropped.length > 0) {
    log.warn("Wiki commit: dropping missing path(s) in {top}: {paths}", {
      top,
      paths: dropped.join(", "),
    });
  }
  if (repoRel.length === 0) {
    log.warn("Wiki commit: no existing paths to commit in {top} — skipping", { top });
    return { committed: false, reason: "nothing-to-commit" };
  }

  const added = await git(top, ["add", "--", ...repoRel]);
  if (added.code !== 0) {
    log.warn("Wiki commit: git add failed in {top}: {error}", { top, error: added.stderr });
    return { committed: false, reason: "error" };
  }

  // Nothing staged for OUR paths (unchanged since the last commit) → skip quietly.
  // Scope the diff to the pathspec so a foreign pre-staged index entry can't make
  // this read as "there's something to commit". `--quiet` exits 0 when there is NO
  // staged diff for these paths, 1 when there is.
  const diff = await git(top, ["diff", "--cached", "--quiet", "--", ...repoRel]);
  if (diff.code === 0) return { committed: false, reason: "nothing-to-commit" };

  // Commit with the explicit pathspec so ONLY our paths are recorded — a foreign
  // file someone else pre-staged in the repo's index is never swept into this
  // wiki-attributed commit. `git commit -- <paths>` records the working-tree state
  // of those paths (they were just `git add`ed, so new files are known to git).
  const committed = await git(top, ["commit", "-m", message, "--", ...repoRel]);
  if (committed.code !== 0) {
    log.warn("Wiki commit: git commit failed in {top}: {error}", { top, error: committed.stderr });
    return { committed: false, reason: "error" };
  }
  log.info("Wiki commit: {message} in {top}", { message, top });
  return { committed: true };
}

/**
 * Push the current branch to its upstream. Runs asynchronously (dispatched, not
 * awaited by the caller) and serialized behind any other commit on the same repo.
 * Push only when a remote exists AND an upstream is configured; never create an
 * upstream. Every failure is a non-fatal warning.
 */
async function pushInner(top: string): Promise<void> {
  const remotes = await git(top, ["remote"]);
  if (remotes.code !== 0 || !remotes.stdout) return; // no remote — local-only repo
  const upstream = await git(top, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream.code !== 0) {
    log.warn("Wiki commit: no upstream for the current branch in {top} — skipping push", { top });
    return;
  }
  const pushed = await git(top, ["push"]);
  if (pushed.code !== 0) {
    log.warn("Wiki commit: git push failed in {top}: {error}", { top, error: pushed.stderr });
  }
}
