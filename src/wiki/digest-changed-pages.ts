/**
 * The pages one `log.md` entry's commit changed, for What's new's batch mode
 * (`digest.ts`). The commit is the one `git blame` names for most of the
 * entry's non-blank lines, not every commit of that day: huginn-nav logged
 * three `update` entries on 2026-10-31, each in its own commit of about 30
 * files. Blame reads the entry's own lines, so a header that is a prefix of an
 * older header, or two entries with the same header, still get their own
 * commit; the majority lets a later edit of the header (a page-rename sweep
 * over `log.md`) lose to the body lines the sync wrote. Blank lines are
 * skipped: a diff can align them with an older entry's. Sweep commits count
 * here, on purpose — the opposite of `git-dates.ts`.
 */

import { runWikiGit } from "./git-dates.ts";
import type { WikiPageMeta } from "./store.ts";

export interface ChangedPage {
  relPath: string;
  title: string;
}

/** Root files that are the log's own bookkeeping, not content pages. */
const META_FILES = new Set(["log.md", "index.md"]);

/** git blame's sha for a line not committed yet. */
const UNCOMMITTED = /^0+$/;

/**
 * The commit `git blame --porcelain` names for most of the non-blank lines in
 * its output; a tie goes to the oldest committer time. Null when no non-blank
 * line is committed.
 */
export function entryCommitFromBlame(porcelain: string): string | null {
  const counts = new Map<string, number>();
  const times = new Map<string, number>();
  let sha: string | null = null;
  for (const line of porcelain.split("\n")) {
    const head = line.match(/^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/);
    if (head) {
      sha = head[1]!;
      continue;
    }
    if (!sha) continue;
    const t = line.match(/^committer-time (\d+)$/);
    if (t) times.set(sha, Number(t[1]));
    else if (line.startsWith("\t")) {
      if (line.slice(1).trim() && !UNCOMMITTED.test(sha)) counts.set(sha, (counts.get(sha) ?? 0) + 1);
      sha = null;
    }
  }
  let best: string | null = null;
  for (const [s, n] of counts) {
    if (best === null) {
      best = s;
      continue;
    }
    const m = counts.get(best)!;
    if (n > m || (n === m && (times.get(s) ?? 0) < (times.get(best) ?? 0))) best = s;
  }
  return best;
}

/**
 * The pages changed by the commit that wrote lines `fromLine`–`toLine`
 * (1-based, inclusive) of the wiki root's `log.md`, as index pages sorted by
 * title. Null when the root is not a git repo, git fails, or no non-blank line
 * of the entry is committed. Paths the index does not hold (deleted pages,
 * non-page files) are left out. Never throws.
 */
export async function changedPagesForEntry(
  root: string,
  fromLine: number,
  toLine: number,
  resolveRelPath: (relPath: string) => WikiPageMeta | undefined,
): Promise<ChangedPage[] | null> {
  const blame = await runWikiGit(root, ["blame", "--porcelain", "-L", `${fromLine},${toLine}`, "--", "log.md"]);
  if (blame === null) return null;
  const sha = entryCommitFromBlame(blame);
  if (!sha) return null;
  // `--relative` (from `-C root`) limits the list to the wiki subtree and
  // prints paths relative to the root, which is what the index keys on.
  const files = await runWikiGit(root, ["show", "--relative", "--name-only", "--format=", sha]);
  if (files === null) return null;
  const seen = new Set<string>();
  const pages: ChangedPage[] = [];
  for (const raw of files.split("\n")) {
    const rel = raw.trim();
    if (!rel || META_FILES.has(rel)) continue;
    const meta = resolveRelPath(rel);
    if (!meta || seen.has(meta.relPath)) continue;
    seen.add(meta.relPath);
    pages.push({ relPath: meta.relPath, title: meta.title });
  }
  pages.sort((a, b) => a.title.localeCompare(b.title));
  return pages;
}
