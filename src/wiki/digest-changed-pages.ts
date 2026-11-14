/**
 * The pages one `log.md` entry's commit changed, for What's new's batch mode
 * (`digest.ts`). The commit is the one that added the entry's header line to
 * `log.md` (git's pickaxe, `-S`), not every commit of that day: huginn-nav
 * logged three `update` entries on 2026-10-31, each in its own commit of about
 * 30 files. Sweep commits count here, on purpose — the opposite of
 * `git-dates.ts`, which skips them when dating pages.
 */

import { runWikiGit } from "./git-dates.ts";
import type { WikiPageMeta } from "./store.ts";

export interface ChangedPage {
  relPath: string;
  title: string;
}

/** Root files that are the log's own bookkeeping, not content pages. */
const META_FILES = new Set(["log.md", "index.md"]);

/**
 * The pages changed by the commit that added `headerLine` to the wiki root's
 * `log.md`, as index pages sorted by title. Null when the root is not a git
 * repo, git fails, or no commit added the line (an uncommitted entry). Paths
 * the index does not hold (deleted pages, non-page files) are left out.
 * Never throws.
 */
export async function changedPagesForEntry(
  root: string,
  headerLine: string,
  resolveRelPath: (relPath: string) => WikiPageMeta | undefined,
): Promise<ChangedPage[] | null> {
  const shas = await runWikiGit(root, ["log", "--format=%H", `-S${headerLine}`, "--", "log.md"]);
  if (shas === null) return null;
  const list = shas.split("\n").map((l) => l.trim()).filter(Boolean);
  // Newest first; the oldest commit that changed the line's count is the one
  // that added it.
  const sha = list[list.length - 1];
  if (!sha) return null;
  // `--relative` (from `-C root`) limits the list to the wiki subtree and
  // prints paths relative to the root, which is what the index keys on.
  const files = await runWikiGit(root, [
    "show",
    "--relative",
    "--name-only",
    "--format=",
    "--diff-merges=first-parent",
    sha,
  ]);
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
