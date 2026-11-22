/**
 * Is a dirty plan page's only change the `/plans` board's own pending write,
 * and who on this instance will commit it?
 *
 * The board's two page writes (`POST /api/plans/priority`, `POST /api/plans/status`)
 * write only the plans wiki (`PLANS_WIKI_NAME`) and pass no committer, so the
 * page stays dirty until something commits it, and a writer that refuses a dirty
 * page (Done) must not blame a session for it (F36, arch review 2026-11-16).
 * Which committer that is depends on the instance: the repo-sync loop only when
 * `SYNC_REPOS` covers that wiki in `wiki` mode, the daily `wiki-committer`
 * sweeper only when the wiki is a bot's `wikiDir` (it sweeps nothing else), and
 * otherwise nobody — the message then says to commit it by hand.
 *
 * The answer compares the page with its `HEAD` blob through the wiki's own
 * metadata-only rule (`classifyPageChange`), narrowed to the board's keys: the
 * body byte-identical, and the frontmatter differing only in `priority:`,
 * `plan_status:` or `status_date:` lines. A hand edit of only those keys reads
 * the same, and is named as the board's write. Anything else, or any read that
 * fails, answers `false`, so the caller keeps its plain refusal.
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

/** Which unattended committers this instance runs for the wiki. */
export interface BoardWriteCommitters {
  /** A `wiki`-mode `SYNC_REPOS` entry covers the wiki. */
  syncLoop: boolean;
  /** The wiki is a bot's `wikiDir`, which the daily sweeper sweeps. */
  sweeper: boolean;
}

/** Done's refusal for a page whose only dirt is the board's pending write,
 *  naming only the remedies that exist on this instance. */
export function pendingBoardWriteMessage(relPath: string, committers: BoardWriteCommitters): string {
  const who =
    committers.syncLoop && committers.sweeper
      ? "The repo-sync loop commits it after its quiet period (or the daily wiki sweep does), or commit it by hand."
      : committers.syncLoop
        ? "The repo-sync loop commits it after its quiet period, or commit it by hand."
        : committers.sweeper
          ? "The daily wiki sweep commits it, or commit it by hand."
          : "Nothing on this instance commits it automatically: commit it by hand.";
  return `${relPath} carries a priority or status change from the plans board that is not committed yet. ${who} Then try again.`;
}
