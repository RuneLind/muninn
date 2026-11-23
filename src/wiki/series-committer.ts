/**
 * Who commits a series edit — and the wikis where nothing else does.
 *
 * `POST /api/wiki/series` writes in `writeWikiPage`'s no-log mode. On mimir it
 * passes no committer: where `SYNC_REPOS` lists mimir, the repo-sync loop is its
 * committer, and elsewhere mimir has a remote, so {@link seriesSelfCommitBlocker}
 * refuses it. That reasoning does not carry to every wiki the route serves, and
 * the two gaps are different:
 *
 *   - **A wiki inside a swept bot `wikiDir`** (an enabled `wiki-committer`
 *     watcher row, {@link sweeperCommits}) is committed by the daily sweep — but
 *     up to ~24 h later, under a `[sweep]` subject, and bypassing the bot's own
 *     `wikiAutoCommit` policy. Late and differently-labelled, not lost.
 *   - **A wiki neither covers** (a `WIKI_EXTRA` wiki outside every swept dir, or
 *     a bot wiki with no sweeper row) has no committer. The route commits the
 *     page itself when {@link seriesSelfCommitBlocker}
 *     allows it, and logs the line only when the edit stays uncommitted
 *     ({@link seriesUncommittedReason}), because then nothing else will ever
 *     mention it.
 *
 * Both sides are compared with symlinks resolved, the normalisation
 * `parseSyncRepos` stores `SyncRepo.path` in: a non-null answer is now a commit,
 * and a lexical miss (macOS `/tmp` → `/private/tmp`) would commit a repo the
 * sync loop already owns.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import type { SyncRepo } from "../sync/config.ts";
import { gitToplevel, runGit, type CommitWikiResult } from "./commit.ts";

/** Just the registry fields this needs — so a test needs no registry. */
export interface SeriesCommitterWiki {
  name: string;
  root: string;
  source: "bot" | "extra";
}

function norm(p: string): string {
  const resolved = path.resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved.replace(/\/+$/, "");
  }
}

/** Is `root` inside (or equal to) `dir`? */
function contains(dir: string, root: string): boolean {
  const d = norm(dir);
  const r = norm(root);
  return d === "/" || r === d || r.startsWith(`${d}/`);
}

/** Does a `wiki`-mode `SYNC_REPOS` entry cover this wiki root, i.e. does the
 *  repo-sync loop commit it? Only `wiki` mode commits: `plain` and `status-only`
 *  never do (`src/sync/config.ts`). Also read by Done's refusal of a pending
 *  plans-board write (`src/plans/board-dirt.ts`). */
export function syncLoopCommits(root: string, repos: readonly SyncRepo[]): boolean {
  return syncRepoCovering(root, repos) !== undefined;
}

/** The `wiki`-mode entry {@link syncLoopCommits} matches, so a caller can read
 *  that repo's sync ledger by its name. */
export function syncRepoCovering(root: string, repos: readonly SyncRepo[]): SyncRepo | undefined {
  return repos.find(
    (r) => r.mode === "wiki" && ((r.wikiRoot && contains(r.wikiRoot, root)) || contains(r.path, root)),
  );
}

/** Does the daily `wiki-committer` sweeper commit this wiki root? `sweptDirs`
 *  is `sweptWikiDirs` (`src/watchers/wiki-committer.ts`): the `wikiDir` of each
 *  bot with an enabled sweeper row. The registry names a bot wiki after its bot
 *  and de-duplicates by name only, so a wiki's `source` says nothing about
 *  this: a `WIKI_EXTRA` wiki at a swept bot's root is swept, and a bot wiki
 *  with no sweeper row is not.
 *
 *  True exactly when the sweeper's staging would commit a new page written
 *  under the root. It stages what `listWikiSubtreeDirty` lists: porcelain
 *  status of the dir, in the dir's own repo, without `--ignored`. So the root
 *  must (1) lie under a swept dir (symlinks resolved), (2) share that dir's git
 *  toplevel (a nested repo, or a separate worktree, is only a gitlink or
 *  nothing there; a dir outside git or a bare repo has no toplevel), and
 *  (3) not be ignored there: a page under a root git ignores (`.gitignore` at
 *  any level, `.git/info/exclude`, `core.excludesFile`) is never listed. (3)
 *  is asked of a probe path under the root (`git check-ignore`), so a root
 *  whose pages git tracks despite an ignore rule answers false: those tracked
 *  pages ARE swept, but a new page there is not, and the callers word the
 *  "nobody commits this" case. */
export async function sweeperCommits(root: string, sweptDirs: readonly string[]): Promise<boolean> {
  const under = sweptDirs.filter((dir) => contains(dir, root));
  if (under.length === 0) return false;
  const rootTop = await gitToplevel(root);
  if (!rootTop) return false;
  for (const dir of under) {
    const dirTop = await gitToplevel(dir);
    if (dirTop && norm(dirTop) === norm(rootTop)) return !(await newPageIgnored(root));
  }
  return false;
}

/** Would git ignore a new `.md`/`.mdx` page written directly under `root`?
 *  `check-ignore` exits 0 for ignored and 1 for not; anything else (an error)
 *  counts as ignored, so the answer never promises a sweep it cannot see. */
async function newPageIgnored(root: string): Promise<boolean> {
  for (const probe of ["__sweeper_probe__.md", "__sweeper_probe__.mdx"]) {
    const r = await runGit(root, ["check-ignore", "-q", "--", path.join(norm(root), probe)]);
    if (r.code !== 1) return true;
  }
  return false;
}

/**
 * The line to log when this write stays uncommitted, or `null` when the wiki
 * has a committer of its own: a `wiki`-mode `SYNC_REPOS` entry (`plain` and
 * `status-only` never commit, `src/sync/config.ts`), or an enabled sweeper
 * whose bot `wikiDir` contains the root ({@link sweeperCommits}).
 *
 * `entry === null` is the bare `WIKI_DIR` override — the bot-owned default wiki
 * under another name, which is never warned about.
 */
export async function seriesCommitterWarning(
  entry: SeriesCommitterWiki | null,
  repos: readonly SyncRepo[],
  sweptDirs: readonly string[],
): Promise<string | null> {
  if (!entry) return null;
  if (syncLoopCommits(entry.root, repos) || (await sweeperCommits(entry.root, sweptDirs))) return null;
  return (
    `wiki "${entry.name}" has NO committer: no wiki-mode SYNC_REPOS entry covers it and no ` +
    `enabled wiki-committer sweeper's bot wikiDir contains it, so this series edit stays uncommitted ` +
    `in ${entry.root} until someone commits it`
  );
}

/**
 * Why the route may NOT commit this wiki itself, or `null` when it may: the
 * wiki root is its repo's toplevel and that repo has no remote. A remote means
 * history another machine pulls (mimir on a laptop with no `SYNC_REPOS` entry),
 * where an unpushed local commit forks it; a larger repo (a code repo's
 * `docs/wiki`) never opted into auto-commit. Each blocker keeps the pre-commit
 * behaviour, the warn line, and becomes its reason.
 */
export async function seriesSelfCommitBlocker(root: string): Promise<string | null> {
  const top = await gitToplevel(root);
  if (!top) return "not a git repo";
  if (norm(top) !== norm(root)) return `the wiki sits inside the larger repo ${top}`;
  const remotes = await runGit(top, ["remote"]);
  if (remotes.code !== 0) return "git remote failed";
  if (remotes.stdout !== "") return "the repo has a remote";
  return null;
}

/**
 * Why a series edit on a wiki with no committer stayed uncommitted, or `null`
 * when it did not: the route's own commit landed, or found nothing to commit
 * (the edit put the page back to its committed bytes). `blocker` is
 * {@link seriesSelfCommitBlocker}'s answer; non-null, the route never tried.
 */
export function seriesUncommittedReason(
  blocker: string | null,
  commit: CommitWikiResult | undefined,
): string | null {
  if (blocker) return blocker;
  if (commit?.committed || commit?.reason === "nothing-to-commit") return null;
  return commit?.reason ?? "commit failed";
}
