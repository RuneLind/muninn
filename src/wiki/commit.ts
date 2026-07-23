/**
 * Commit seam for muninn's programmatic wiki writers.
 *
 * muninn writes into a bot's knowledge wiki (`wikiDir`) from three paths — the
 * gardener apply step, the source drafter, and the fact-check appender — but
 * historically never committed those writes. A wiki repo therefore accumulated
 * uncommitted pages, and a sibling tool running `git clean` in that repo silently
 * deleted them (the 2026-07-23 huginn-jarvis incident: 128 pages lost). This
 * helper closes that gap: after a write, the caller stages exactly the files it
 * touched and commits them.
 *
 * Design constraints (enforced by construction):
 *  - Callers hold the wiki DIRECTORY (e.g. `…/huginn-jarvis/data/wiki`), not the
 *    git repo root. We derive the toplevel via `rev-parse` and translate every
 *    wiki-relative path to repo-relative before staging.
 *  - We stage ONLY the explicit paths given (`git add -- <path>…`) — never
 *    `git add -A`, so an unrelated dirty file in the repo is left untouched.
 *  - This helper NEVER runs a destructive git verb. The only git subcommands it
 *    ever spawns are `rev-parse`, `symbolic-ref`, `branch`, `remote`, `status`,
 *    `diff`, `add -- <paths>`, `commit`, and `push`. No clean/checkout/restore/
 *    stash/reset, ever.
 *  - Commit only on the repo's DEFAULT branch — a feature-branch checkout is left
 *    for the later sweeper to pick up.
 *  - Every failure is non-fatal: it logs a warning and returns; it never throws
 *    out of the helper and never blocks the write that preceded it.
 *
 * Serialized by a per-repo (per-toplevel) in-memory queue so two writes into the
 * same wiki can't interleave their stage/commit.
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
   */
  push?: boolean;
}

/** Result of one git invocation. */
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn `git -C <cwd> <args…>` and collect its output. Never throws. */
async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
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
): Promise<void> {
  try {
    const top = await gitToplevel(wikiDir);
    if (!top) {
      log.warn("Wiki commit skipped — {dir} is not inside a git repo", { dir: wikiDir });
      return;
    }
    const staged = paths.filter((p) => p && p.length > 0);
    if (staged.length === 0) return;

    await runExclusiveQueued(top, () => commitInner(top, wikiDir, staged, message, opts));
  } catch (err) {
    // Belt-and-suspenders: commitInner already swallows its own errors.
    log.warn("Wiki commit failed for {dir}: {error}", {
      dir: wikiDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function commitInner(
  top: string,
  wikiDir: string,
  paths: string[],
  message: string,
  opts: CommitWikiOpts,
): Promise<void> {
  if (!(await onDefaultBranch(top))) {
    log.warn(
      "Wiki commit skipped — {top} is not on its default branch (a sweeper will pick up the write)",
      { top },
    );
    return;
  }

  // Translate wiki-relative → repo-relative for staging. `git rev-parse` returns
  // a canonicalized toplevel (symlinks resolved — e.g. macOS /tmp → /private/tmp),
  // so canonicalize wikiDir the same way before diffing, else `path.relative`
  // produces a bogus `../../…` escape when the two disagree on symlinked prefixes.
  const canonicalWiki = await realpath(wikiDir).catch(() => wikiDir);
  const repoRel = paths.map((p) => path.relative(top, path.join(canonicalWiki, p)));

  const added = await git(top, ["add", "--", ...repoRel]);
  if (added.code !== 0) {
    log.warn("Wiki commit: git add failed in {top}: {error}", { top, error: added.stderr });
    return;
  }

  // Nothing staged (paths unchanged since the last commit) → skip quietly.
  // `diff --cached --quiet` exits 0 when there is NO staged diff, 1 when there is.
  const diff = await git(top, ["diff", "--cached", "--quiet"]);
  if (diff.code === 0) return;

  const committed = await git(top, ["commit", "-m", message]);
  if (committed.code !== 0) {
    log.warn("Wiki commit: git commit failed in {top}: {error}", { top, error: committed.stderr });
    return;
  }
  log.info("Wiki commit: {message} in {top}", { message, top });

  if (opts.push === false) return;

  // Push only when a remote exists AND an upstream is configured; never create
  // an upstream. A push failure is non-fatal.
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
