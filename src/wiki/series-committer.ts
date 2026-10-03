/**
 * Who commits a series edit — and the wikis where nothing else does.
 *
 * `POST /api/wiki/series` writes in `writeWikiPage`'s no-log mode. On mimir it
 * passes no committer: where `SYNC_REPOS` lists mimir, the repo-sync loop is its
 * committer, and elsewhere mimir has a remote, so {@link seriesCanSelfCommit}
 * refuses it. That reasoning does not carry to every wiki the route serves, and
 * the two gaps are different:
 *
 *   - **A BOT wiki** is swept by the daily `wiki-committer` watcher
 *     (`src/watchers/`), so its edit is committed — but up to ~24 h later, under
 *     a `[sweep]` subject, and bypassing the bot's own `wikiAutoCommit` policy.
 *     Late and differently-labelled, not lost.
 *   - **A standalone `WIKI_EXTRA` wiki that no `SYNC_REPOS` entry covers** has
 *     neither: the sweeper is bot-keyed and the loop never looks at that repo.
 *     The route commits the page itself when {@link seriesCanSelfCommit}
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

/**
 * The line to log when this write stays uncommitted, or `null` when the wiki
 * has a committer of its own. Only a `wiki`-mode entry is one: `plain` and
 * `status-only` never commit (`src/sync/config.ts`).
 *
 * `entry === null` is the bare `WIKI_DIR` override — the bot-owned default wiki
 * under another name, so it takes the bot-wiki branch (no warning).
 */
export function seriesCommitterWarning(
  entry: SeriesCommitterWiki | null,
  repos: readonly SyncRepo[],
): string | null {
  if (!entry || entry.source !== "extra") return null;
  const covered = repos.some(
    (r) =>
      r.mode === "wiki" &&
      ((r.wikiRoot && contains(r.wikiRoot, entry.root)) || contains(r.path, entry.root)),
  );
  if (covered) return null;
  return (
    `wiki "${entry.name}" is a standalone wiki outside SYNC_REPOS: this series edit has NO ` +
    `committer (the daily wiki-committer sweeper covers bot wikis only) and stays uncommitted ` +
    `in ${entry.root} until someone commits it`
  );
}

/**
 * May the route commit this wiki itself? Only when the wiki root IS its repo's
 * toplevel and that repo has no remote. A remote means history another machine
 * pulls (mimir on a laptop with no `SYNC_REPOS` entry), where an unpushed local
 * commit forks it; a larger repo (a code repo's `docs/wiki`) never opted into
 * auto-commit. Both keep the pre-commit behaviour: the warn line.
 */
export async function seriesCanSelfCommit(root: string): Promise<boolean> {
  const top = await gitToplevel(root);
  if (!top || norm(top) !== norm(root)) return false;
  const remotes = await runGit(top, ["remote"]);
  return remotes.code === 0 && remotes.stdout === "";
}

/**
 * Why a series edit on a wiki with no committer stayed uncommitted, or `null`
 * when it did not: the route's own commit landed, or found nothing to commit
 * (the edit put the page back to its committed bytes).
 */
export function seriesUncommittedReason(
  selfCommit: boolean,
  commit: CommitWikiResult | undefined,
): string | null {
  if (!selfCommit) return "the repo has a remote or holds more than this wiki";
  if (commit?.committed || commit?.reason === "nothing-to-commit") return null;
  return commit?.reason ?? "commit failed";
}
