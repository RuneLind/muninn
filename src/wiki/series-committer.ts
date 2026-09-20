/**
 * Who commits a series edit — and the wikis where the answer is NOBODY.
 *
 * `POST /api/wiki/series` writes in `writeWikiPage`'s no-log mode and passes no
 * committer, the `/plans` board's discipline: mimir is in `SYNC_REPOS`, and the
 * repo-sync loop is its committer. That reasoning does not carry to every wiki
 * the route serves, and the two gaps are different:
 *
 *   - **A BOT wiki** is swept by the daily `wiki-committer` watcher
 *     (`src/watchers/`), so its edit is committed — but up to ~24 h later, under
 *     a `[sweep]` subject, and bypassing the bot's own `wikiAutoCommit` policy.
 *     Late and differently-labelled, not lost.
 *   - **A standalone `WIKI_EXTRA` wiki that no `SYNC_REPOS` entry covers** has
 *     neither: the sweeper is bot-keyed and the loop never looks at that repo.
 *     The edit sits in the working tree until a human notices it. That is the
 *     one case worth a log line at write time, because nothing else on the
 *     machine will ever mention it.
 *
 * The match is LEXICAL (the same normalisation `parseSyncRepos` falls back to),
 * so an exotic symlink could produce a warning for a wiki that really is
 * covered. A spurious log line is the right direction for a check whose whole
 * output is a log line.
 */

import path from "node:path";
import type { SyncRepo } from "../sync/config.ts";

/** Just the registry fields this needs — so a test needs no registry. */
export interface SeriesCommitterWiki {
  name: string;
  root: string;
  source: "bot" | "extra";
}

function norm(p: string): string {
  return path.resolve(p).replace(/\/+$/, "");
}

/** Is `root` inside (or equal to) `dir`? */
function contains(dir: string, root: string): boolean {
  const d = norm(dir);
  const r = norm(root);
  return r === d || r.startsWith(`${d}/`);
}

/**
 * The line to log for this write, or `null` when the wiki has a committer.
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
      (r.wikiRoot && contains(r.wikiRoot, entry.root)) ||
      (r.containedWikiRoots ?? []).some((w) => contains(w, entry.root)) ||
      contains(r.path, entry.root),
  );
  if (covered) return null;
  return (
    `wiki "${entry.name}" is a standalone wiki outside SYNC_REPOS: this series edit has NO ` +
    `committer (the daily wiki-committer sweeper covers bot wikis only) and stays uncommitted ` +
    `in ${entry.root} until someone commits it`
  );
}
