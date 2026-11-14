/**
 * The pages one `log.md` entry's commit changed, for What's new's batch mode
 * (`digest.ts`). The commit is found from the entry's header line, not from
 * every commit of that day (huginn-nav logged three `update` entries on
 * 2026-10-31, each in its own commit): `git blame` names the commit that last
 * touched the line and where it sat then, and `git log -L` walks the line's
 * history back from there. A later edit that keeps the header's date and kind
 * (a page-rename sweep over `log.md`) is walked past; a commit that wrote the
 * line fresh, or wrote it over another entry's header (huginn-nav did both on
 * 2026-05-10 and 2026-05-11), is the entry's commit. Sweep commits count here,
 * on purpose — the opposite of `git-dates.ts`.
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

/** A header's date and kind — `digest.ts`'s header shape, read here without
 *  importing it (it imports this module). */
function headerKey(line: string): string | null {
  const m = line.match(/^##\s+\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/);
  if (!m) return null;
  const pipe = m[2]!.indexOf("|");
  return `${m[1]} ${pipe === -1 ? "" : m[2]!.slice(0, pipe).trim()}`;
}

/** The commit and original line number on the first line of `git blame
 *  --porcelain` output. Null for an uncommitted line or unreadable output. */
export function blameOrigin(porcelain: string): { sha: string; line: number } | null {
  const m = porcelain.match(/^([0-9a-f]{40}) (\d+) \d+/);
  if (!m || UNCOMMITTED.test(m[1]!)) return null;
  return { sha: m[1]!, line: Number(m[2]) };
}

/**
 * The entry's commit from `git log -L <n>,<n>:log.md --format=%x01%H` output
 * for its header line, newest commit first: the first commit whose change to
 * the line is an addition, or replaces a line that is not a header with the
 * same date and kind; else the oldest commit listed. Null when none is.
 */
export function entryCommitFromLineLog(output: string): string | null {
  let last: string | null = null;
  for (const block of output.split("\x01").slice(1)) {
    const [head, ...rest] = block.split("\n");
    const sha = head!.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    last = sha;
    const removed = rest.find((l) => l.startsWith("-") && !l.startsWith("---"));
    const added = rest.find((l) => l.startsWith("+") && !l.startsWith("+++"));
    if (removed === undefined) return sha;
    // A removed line that is not a header has key null, which no header's
    // key equals, so it stops the walk too.
    if (headerKey(removed.slice(1)) !== headerKey((added ?? "+").slice(1))) return sha;
  }
  return last;
}

/**
 * The pages changed by the commit that wrote the header on line `headerLine`
 * (1-based) of the wiki root's `log.md`, as index pages sorted by title. Null
 * when the root is not a git repo, git fails, or the line is not committed.
 * Paths the index does not hold (deleted pages, non-page files) are left out.
 * Never throws.
 */
export async function changedPagesForEntry(
  root: string,
  headerLine: number,
  resolveRelPath: (relPath: string) => WikiPageMeta | undefined,
): Promise<ChangedPage[] | null> {
  const blame = await runWikiGit(root, ["blame", "--porcelain", "-L", `${headerLine},${headerLine}`, "--", "log.md"]);
  const origin = blame === null ? null : blameOrigin(blame);
  if (!origin) return null;
  const history = await runWikiGit(root, ["log", `-L${origin.line},${origin.line}:log.md`, "--format=%x01%H", origin.sha]);
  const sha = history === null ? null : entryCommitFromLineLog(history);
  if (!sha) return null;
  // `--relative` (from `-C root`) limits the list to the wiki subtree and
  // prints paths relative to the root, which is what the index keys on. A
  // merge (an entry written while resolving one) lists what it brought in
  // over its first parent; plain `git show` gives a merge's combined diff,
  // which names only the files the merge itself had to resolve.
  const files = await runWikiGit(root, ["show", "--relative", "--name-only", "--format=", "--diff-merges=first-parent", sha]);
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
