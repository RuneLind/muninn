/**
 * Is a dirty plan page's only change the `/plans` board's own pending write?
 *
 * The board's two page writes (`POST /api/plans/priority`, `POST /api/plans/status`)
 * pass no committer: the repo-sync loop commits them after its quiet period, or
 * the daily sweep does. Until then the page is dirty, and a writer that refuses a
 * dirty page (Done) must not blame a session for it (F36, arch review 2026-11-16).
 *
 * The answer compares the page with its `HEAD` blob through the wiki's own
 * metadata-only rule (`classifyPageChange`), narrowed to the board's keys: the
 * body byte-identical, and the frontmatter differing only in `priority:`,
 * `plan_status:` or `status_date:` lines. Anything else, or any read that fails,
 * answers `false`, so the caller keeps its plain refusal.
 */

import path from "node:path";
import { realpath } from "node:fs/promises";
import { runGit } from "../wiki/commit.ts";
import { classifyPageChange } from "../wiki/git-dates.ts";

/** The frontmatter keys the board's page writes touch (`setPlanPriority`, `setPlanStatus`). */
export const BOARD_FRONTMATTER_KEYS = ["priority", "plan_status", "status_date"] as const;

export async function dirtIsPendingBoardWrite(wikiDir: string, relPath: string): Promise<boolean> {
  try {
    const root = await realpath(wikiDir).catch(() => wikiDir);
    const abs = path.join(root, relPath);
    // `HEAD:./<path>` resolves against `-C`, so a wiki nested in a bigger repo works too.
    const head = await runGit(path.dirname(abs), ["show", `HEAD:./${path.basename(abs)}`], { raw: true });
    if (head.code !== 0) return false;
    const work = await Bun.file(abs).text();
    return classifyPageChange(head.stdout, work, BOARD_FRONTMATTER_KEYS) === "metadata-only";
  } catch {
    return false;
  }
}
