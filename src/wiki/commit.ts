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
import { realpath, stat } from "node:fs/promises";
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
   * Extra commit-body lines, appended to `message` as a second `-m` block (a
   * blank line then the joined lines). Additive: absent/empty ⇒ a subject-only
   * commit, byte-identical to today. Used by the daily sweeper to list the swept
   * files under the `[sweep] …` subject.
   */
  bodyLines?: string[];
  /**
   * Wiki-relative paths that are DELETIONS (tracked files removed from disk). The
   * normal exists-on-disk filter in `commitInner` would drop these before staging;
   * listing them here makes `commitInner` stage them anyway (`git add -- <path>`
   * stages a deletion), so a removed page is committed as a deletion instead of
   * being silently skipped. Additive: absent/empty ⇒ today's behavior.
   */
  deletions?: string[];
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
 * no credential helper — fail fast instead of hanging waiting on stdin.
 *
 * `rawStdout` skips the trim — REQUIRED for `status --porcelain -z`, whose
 * first status column is a leading space that `.trim()` would strip, corrupting
 * the first entry's 2-char `XY` prefix. Every other caller wants the trimmed
 * form (e.g. `rev-parse` toplevel), so trim stays the default. */
async function git(cwd: string, args: string[], rawStdout = false): Promise<GitResult> {
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
    return { code, stdout: rawStdout ? stdout : stdout.trim(), stderr: stderr.trim() };
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
 * outside any git repo (a non-fatal skip condition). Exported so the daily
 * wiki-committer sweeper reuses it instead of re-spawning `rev-parse`.
 */
export async function gitToplevel(wikiDir: string): Promise<string | null> {
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

/** True when the repo is currently checked out on its default branch. Exported
 *  so the sweeper can skip a feature-branch checkout (same rule the commit path
 *  applies — a non-default branch is left for a later sweep). */
export async function onDefaultBranch(top: string): Promise<boolean> {
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
      commitInner(top, wikiDir, staged, message, {
        bodyLines: opts.bodyLines,
        deletions: new Set(opts.deletions ?? []),
      }),
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
  opts: { bodyLines?: string[]; deletions: Set<string> } = { deletions: new Set() },
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
  // EXCEPTION: a path listed in `opts.deletions` is a tracked file removed from
  // disk — it's absent by design, and `git add -- <path>` stages the deletion, so
  // it must NOT be dropped. This is how the sweeper commits removed pages.
  const repoRel: string[] = [];
  const repoRelDeletions: string[] = [];
  const dropped: string[] = [];
  for (const p of paths) {
    const abs = path.join(canonicalWiki, p);
    const rel = path.relative(top, abs);
    if (await pathExists(abs)) {
      repoRel.push(rel);
    } else if (opts.deletions.has(p)) {
      // Absent-on-disk deletion — either an unstaged `rm` (present in HEAD, gone
      // from the worktree) OR a human's ALREADY-staged `git rm` / `git mv` origin.
      // Keep it in the commit pathspec, but stage it SEPARATELY below: a path
      // already staged as a deletion makes a batched `git add` exit 128
      // ("pathspec did not match any files"), which would abort the whole sweep.
      repoRel.push(rel);
      repoRelDeletions.push(rel);
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

  // Stage the present paths in ONE batch. A deletion is never in this set (see
  // above), so a staged rename/deletion in the wiki can't fail the pathspec and
  // abort the batch — the recurring-every-sweep bug this guards.
  const toAdd = repoRel.filter((r) => !repoRelDeletions.includes(r));
  if (toAdd.length > 0) {
    const added = await git(top, ["add", "--", ...toAdd]);
    if (added.code !== 0) {
      log.warn("Wiki commit: git add failed in {top}: {error}", { top, error: added.stderr });
      return { committed: false, reason: "error" };
    }
  }
  // Stage each deletion on its own, TOLERATING the exit-128 pathspec mismatch a
  // path already staged as a deletion (human `git rm`/`git mv`) produces — it's
  // already in the index, so it still lands in the commit. An UNSTAGED deletion
  // (in HEAD, gone from the worktree, never `git rm`'d) stages here exactly as
  // before, keeping that path byte-identical.
  for (const del of repoRelDeletions) {
    const addDel = await git(top, ["add", "--", del]);
    if (addDel.code !== 0) {
      log.debug("Wiki commit: '{path}' already staged as a deletion in {top} (tolerated)", {
        top,
        path: del,
      });
    }
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
  const bodyArgs =
    opts.bodyLines && opts.bodyLines.length > 0 ? ["-m", opts.bodyLines.join("\n")] : [];
  const committed = await git(top, ["commit", "-m", message, ...bodyArgs, "--", ...repoRel]);
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

// ── Sweeper support: enumerate the dirty state of a wiki subtree ──────────────
//
// The daily wiki-committer catches manual edits, crashed runs, and writes that
// were skipped while the repo was off its default branch. It needs to know
// exactly which files in the wiki subtree are dirty (tracked-modified, untracked,
// or deleted) so it can commit precisely those — never `git add -A`. This helper
// centralizes the git-status spawn + porcelain parse so the watcher stays free of
// raw git plumbing.

/** One entry from `git status --porcelain -z` (repo-relative, posix). */
interface PorcelainEntry {
  /** repo-relative path (posix separators, as git emits). */
  path: string;
}

/**
 * Parse `git status --porcelain -z` output. NUL-separated (no path quoting), so
 * paths with spaces/unicode are safe. A rename/copy record (`X`/`Y` = R/C) is
 * followed by a second NUL field carrying the ORIGINAL path — we surface BOTH the
 * new path and the original (the original is a deletion the caller will stage), so
 * a pre-staged rename commits as delete + add rather than a half-recorded rename.
 */
function parsePorcelainZ(out: string): PorcelainEntry[] {
  const tokens = out.split("\0");
  const entries: PorcelainEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok || tok.length < 4) continue; // "XY p" is the minimum
    const xy = tok.slice(0, 2);
    entries.push({ path: tok.slice(3) });
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      const orig = tokens[++i];
      if (orig) entries.push({ path: orig });
    }
  }
  return entries;
}

/**
 * Enumerate the dirty paths inside a wiki subtree (tracked-modified, untracked,
 * and deleted), as WIKI-relative paths ready to pass to `commitWikiChange`. The
 * status is scoped to the wiki directory pathspec, so unrelated dirt elsewhere in
 * the repo is never listed. Deletions (paths absent from disk) are returned
 * separately so the caller can pass them as `opts.deletions`. Best-effort: a
 * failed `git status` degrades to empty, never throws.
 *
 * @param top        the repo toplevel (from `gitToplevel`)
 * @param wikiDirAbs the absolute wiki root
 */
export async function listWikiSubtreeDirty(
  top: string,
  wikiDirAbs: string,
): Promise<{ dirty: string[]; deletions: string[] }> {
  const canonicalWiki = await realpath(wikiDirAbs).catch(() => wikiDirAbs);
  // Scope to the wiki subtree; `--porcelain -z` keeps parsing quote-free and
  // includes untracked files by default. Absolute pathspec ⇒ repo-relative output.
  const r = await git(top, ["status", "--porcelain", "-z", "--", canonicalWiki], true);
  if (r.code !== 0) {
    log.warn("Wiki sweep: git status failed in {top}: {error}", { top, error: r.stderr });
    return { dirty: [], deletions: [] };
  }
  const dirty: string[] = [];
  const deletions: string[] = [];
  for (const entry of parsePorcelainZ(r.stdout)) {
    const abs = path.join(top, entry.path);
    const rel = path.relative(canonicalWiki, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue; // outside the subtree
    const wikiRel = rel.split(path.sep).join("/");
    dirty.push(wikiRel);
    if (!(await pathExists(abs))) deletions.push(wikiRel);
  }
  return { dirty, deletions };
}

/** The dirty-state snapshot of a wiki's repo for the `/wiki` Index-card badge. */
export interface WikiDirtyStat {
  /** Count of dirty files (tracked-modified + untracked + deleted) in the wiki
   *  subtree. `0` when the wiki is not inside a git repo or the tree is clean. */
  dirtyCount: number;
  /** Oldest dirty file's mtime (epoch ms) — a proxy for "dirty for a while".
   *  `null` when nothing is dirty or every dirty path is a deletion (no mtime). */
  oldestDirtyMtimeMs: number | null;
}

/**
 * Cheap, non-blocking dirty-state probe for the Index card's "uncommitted
 * changes: N" badge. Counts the wiki subtree's dirty files and finds the oldest
 * dirty file's mtime (the staleness signal — red past 24h in the UI). Never
 * throws: a non-repo / status failure degrades to `{ dirtyCount: 0, ... }`.
 */
export async function wikiDirtyStat(wikiDir: string): Promise<WikiDirtyStat> {
  const top = await gitToplevel(wikiDir);
  if (!top) return { dirtyCount: 0, oldestDirtyMtimeMs: null };
  const canonicalWiki = await realpath(wikiDir).catch(() => wikiDir);
  const { dirty } = await listWikiSubtreeDirty(top, wikiDir);
  let oldest: number | null = null;
  for (const rel of dirty) {
    try {
      const st = await stat(path.join(canonicalWiki, rel));
      const mtime = st.mtimeMs;
      if (oldest === null || mtime < oldest) oldest = mtime;
    } catch {
      /* a deleted path has no mtime — skip it */
    }
  }
  return { dirtyCount: dirty.length, oldestDirtyMtimeMs: oldest };
}
