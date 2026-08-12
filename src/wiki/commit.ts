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
import { createQueue } from "./queue.ts";
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

/** Options for one {@link runGit} invocation. */
export interface GitRunOptions {
  /** Skip the stdout trim (see {@link runGit}). */
  raw?: boolean;
  /**
   * Kill the child after this many ms and report a synthetic failure.
   *
   * **Only ever pass this for a NETWORK verb** (`push`, `fetch`). Local verbs
   * (`add`/`commit`/`status`/`rev-parse`/…) stay untimed DELIBERATELY: `git()`
   * serves hot dashboard paths where a spurious kill would be a new failure
   * mode, and a killed `add`/`commit` leaves `.git/index.lock` behind — which
   * the repo-sync pre-flight escalates to a human, i.e. a timeout on a local
   * verb would WEDGE the repo it was meant to protect.
   */
  timeoutMs?: number;
}

/** The network-verb budget shared by the auto-commit push and the repo-sync
 *  loop's fetch/push. Sized to be generous for a real remote over ssh while
 *  still bounding a hung child: an un-awaited untimed push is what could pin
 *  the per-repo commit queue forever. */
export const GIT_NETWORK_TIMEOUT_MS = 60_000;

/** Spawn `git -C <cwd> <args…>` and collect its output. Never throws.
 *
 * `GIT_TERMINAL_PROMPT=0` (merged over the process env) makes any git op that
 * would otherwise prompt for credentials — e.g. a `push` to an https remote with
 * no credential helper — fail fast instead of hanging waiting on stdin. That env
 * var is exactly what makes a credential-less push fail fast, which is why every
 * caller goes through this helper instead of spawning git itself.
 *
 * `opts.raw` skips the trim — REQUIRED for `status --porcelain -z`, whose
 * first status column is a leading space that `.trim()` would strip, corrupting
 * the first entry's 2-char `XY` prefix. Every other caller wants the trimmed
 * form (e.g. `rev-parse` toplevel), so trim stays the default.
 *
 * Exported so the repo-sync loop (`src/sync/`) reuses this one spawn seam. */
export async function runGit(
  cwd: string,
  args: string[],
  opts: GitRunOptions = {},
): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const collect = (async (): Promise<GitResult> => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      return { code, stdout: opts.raw ? stdout : stdout.trim(), stderr: stderr.trim() };
    })();
    if (!opts.timeoutMs || opts.timeoutMs <= 0) return await collect;

    // The timeout RACES the output collection instead of awaiting it after the
    // kill, because git's own children (ssh, a credential helper) inherit the
    // pipes: killing git does not necessarily close them, so a reader awaited
    // after the kill can hang exactly in the case the timeout exists for.
    collect.catch(() => {}); // the losing branch must never surface as unhandled
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        try {
          proc.kill(9);
        } catch {
          /* already exited */
        }
        resolve(null);
      }, opts.timeoutMs);
    });
    const winner = await Promise.race([collect, expiry]);
    if (timer) clearTimeout(timer);
    if (winner === null) {
      return {
        code: -1,
        stdout: "",
        stderr: `git ${args[0] ?? "?"} timed out after ${opts.timeoutMs}ms`,
      };
    }
    return winner;
  } catch (err) {
    return { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** Local alias — every in-module call site is a LOCAL verb unless it passes a
 *  timeout explicitly (only `pushInner` does). */
const git = runGit;

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
// not be dropped — it queues behind the first. The primitive itself lives in
// `queue.ts` (the wiki-WRITE path needs the same shape); this is its OWN chain
// map, deliberately not shared — a write critical section awaiting a commit on a
// shared map would self-deadlock when a wiki root equals its git toplevel.

const commitQueue = createQueue();

/**
 * Serialize `work` on the per-git-toplevel COMMIT chain.
 *
 * Exported for the repo-sync loop (`src/sync/run.ts`), whose local section
 * (status → add/commit → rebase) must hold this lock for its WHOLE span.
 * Routing that through `commitWikiChange` is NOT equivalent: that helper
 * acquires and releases around its own commit, leaving the rebase unprotected
 * against the gardener/page-write commit tails (which run OUTSIDE the wiki-write
 * section by design), and it dispatches an immediate push that would be
 * non-fast-forward before the rebase has run.
 *
 * `key` MUST be a git toplevel from {@link gitToplevel} — this map is keyed on a
 * plain string with NO realpath normalization of its own, and `rev-parse
 * --show-toplevel` is what supplies the canonical spelling. Deriving the key by
 * string manipulation would open a second, independent chain on one repo.
 */
export function runExclusiveQueued<T>(key: string, work: () => Promise<T>): Promise<T> {
  return commitQueue.run(key, work);
}

/** Test-only: clear the per-repo commit queue between cases. */
export function __resetForTest(): void {
  commitQueue.reset();
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
  // The ONE network verb on this path — timed, because it is dispatched
  // un-awaited onto the per-repo commit queue and a hung push would otherwise
  // park every later commit on that repo for the process's lifetime.
  const pushed = await git(top, ["push"], { timeoutMs: GIT_NETWORK_TIMEOUT_MS });
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
 * One STATUS-CARRYING entry from `git status --porcelain -z -uall`.
 *
 * The sweeper's {@link listWikiSubtreeDirty} deliberately discards `XY` — it
 * only ever needs "which paths are dirty" and derives deletions from absence on
 * disk. The repo-sync loop cannot: an ordinary unstaged `mv` shows as `D old`
 * plus a fresh `?? new` (verified against real git — an UNSTAGED rename is never
 * paired, only a staged `git mv` produces an `R` record), so a rule that staged
 * deletions unconditionally would push a bare page deletion while the
 * quiet-period filter still held back the new half, and the other machine would
 * pull a 404. Deciding that needs the status letters and the rename pairing.
 */
export interface PorcelainStatusEntry {
  /** repo-relative path (posix separators, as git emits). For a rename/copy
   *  record this is the NEW path. */
  path: string;
  /** The 2-char `XY` status field, verbatim (`" M"`, `"??"`, `"R "`, `"UU"`…). */
  xy: string;
  /** For a rename/copy record (`X` or `Y` = `R`/`C`): the ORIGINAL path. */
  origPath?: string;
}

/**
 * Parse `git status --porcelain -z` output, KEEPING the status field and pairing
 * renames. NUL-separated (no path quoting), so paths with spaces/unicode are
 * safe — which is load-bearing: plain `--porcelain` C-quotes the em-dash
 * filenames both wikis contain, and `git add` exits 128 on the quoted string.
 *
 * A rename/copy record (`X`/`Y` = R/C) is followed by a second NUL field
 * carrying the ORIGINAL path; it is attached to the same entry rather than
 * emitted as a sibling, so a caller can treat the pair as one unit.
 */
export function parsePorcelainZWithStatus(out: string): PorcelainStatusEntry[] {
  const tokens = out.split("\0");
  const entries: PorcelainStatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok || tok.length < 4) continue; // "XY p" is the minimum
    const xy = tok.slice(0, 2);
    const entry: PorcelainStatusEntry = { path: tok.slice(3), xy };
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      const orig = tokens[++i];
      if (orig) entry.origPath = orig;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Parse `git status --porcelain -z` into the FLAT path list the sweeper wants —
 * a rename's original path becomes its own entry right after the new path (the
 * original is a deletion the caller will stage), so a pre-staged rename commits
 * as delete + add rather than a half-recorded rename. Derived from
 * {@link parsePorcelainZWithStatus} so there is one parser, not two.
 */
function parsePorcelainZ(out: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  for (const e of parsePorcelainZWithStatus(out)) {
    entries.push({ path: e.path });
    if (e.origPath) entries.push({ path: e.origPath });
  }
  return entries;
}

/**
 * Status-carrying sibling of {@link listWikiSubtreeDirty}: enumerate the dirty
 * entries of a repo (optionally scoped to a subtree) as REPO-relative paths with
 * their `XY` status and rename pairing intact. Best-effort — a failed
 * `git status` degrades to an empty list, never throws.
 *
 * `-uall` is load-bearing exactly as it is for the sweeper: git's default
 * (`-unormal`) collapses a wholly-untracked directory into ONE `dir/` entry
 * whose mtime does not move when a child is edited — which would make the
 * quiet-period filter judge a live edit by a stale directory timestamp.
 *
 * @param top       the repo toplevel (from {@link gitToplevel})
 * @param scopeAbs  optional absolute pathspec to scope to (e.g. a wiki root
 *                  nested inside a bigger repo); omitted ⇒ the whole repo
 */
export async function listDirtyEntries(
  top: string,
  scopeAbs?: string,
): Promise<PorcelainStatusEntry[]> {
  const scope = scopeAbs ? await realpath(scopeAbs).catch(() => scopeAbs) : undefined;
  const args = ["status", "--porcelain", "-z", "-uall"];
  if (scope) args.push("--", scope);
  const r = await git(top, args, { raw: true });
  if (r.code !== 0) {
    log.warn("Dirty listing: git status failed in {top}: {error}", { top, error: r.stderr });
    return [];
  }
  return parsePorcelainZWithStatus(r.stdout);
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
  //
  // `-uall` is load-bearing, not verbosity. git's DEFAULT (`-unormal`) collapses a
  // wholly-untracked directory into ONE entry naming the directory — `?? wiki/newdir/`
  // — never its files. Every consumer here wants files: `wikiDirtyStat`'s badge would
  // count a 30-page drop as "uncommitted changes: 1", and `buildWikiGitDates` looks
  // the set up by page relPath, so those 30 pages would come back neither
  // git-dated NOR dirty and trip the index build's coverage warn. The sweeper
  // stages either spelling equally well, so this only ever makes callers more precise.
  const r = await git(top, ["status", "--porcelain", "-z", "-uall", "--", canonicalWiki], {
    raw: true,
  });
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
