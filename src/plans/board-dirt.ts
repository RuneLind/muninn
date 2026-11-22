/**
 * Is a dirty plan page's only change the `/plans` board's own pending write,
 * and who on this instance will commit it?
 *
 * The board's two page writes (`POST /api/plans/priority`, `POST /api/plans/status`)
 * write only the plans wiki (`PLANS_WIKI_NAME`) and pass no committer, so the
 * page stays dirty until something commits it, and a writer that refuses a dirty
 * page (Done) must not blame a session for it (F36, arch review 2026-11-16).
 * Which committer that is depends on the instance: the repo-sync loop only when
 * `SYNC_REPOS` covers that wiki in `wiki` mode, worded from its ledger's last
 * tick (healthy, not run since boot, idle, or stopped with its reason), the daily `wiki-committer`
 * sweeper only when the wiki root lies inside the `wikiDir` of a bot with an
 * enabled sweeper row (`sweeperCommits`; it sweeps nothing else), and otherwise
 * nobody — the message then says to commit it by hand.
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
import type { SyncLoopOutlook } from "../sync/decide.ts";

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
  /** `null` when no `wiki`-mode `SYNC_REPOS` entry covers the wiki; otherwise
   *  what the loop's ledger says about it (`syncLoopOutlook`). */
  syncLoop: SyncLoopOutlook | null;
  /** The wiki root lies inside a swept bot `wikiDir` (`sweeperCommits`). */
  sweeper: boolean;
}

/** Done's refusal for a page whose only dirt is the board's pending write,
 *  naming only the remedies that exist on this instance, and the loop only as
 *  far as its ledger is evidence. */
export function pendingBoardWriteMessage(relPath: string, committers: BoardWriteCommitters): string {
  const { syncLoop, sweeper } = committers;
  const orSweep = sweeper ? " (or the daily wiki sweep does)" : "";
  let who: string;
  if (syncLoop === null) {
    who = sweeper ? "The daily wiki sweep commits it, or commit it by hand." : "Nothing on this instance commits it automatically: commit it by hand.";
  } else if (syncLoop.kind === "healthy") {
    who = `The repo-sync loop commits it after its quiet period${orSweep}, or commit it by hand.`;
  } else if (syncLoop.kind === "never-run") {
    who = `The repo-sync loop commits it after its quiet period if it is running (it has not run since muninn started)${orSweep}, or commit it by hand.`;
  } else if (syncLoop.kind === "idle") {
    who = `The repo-sync loop commits it after its quiet period if it is still running (its last run was ${syncLoop.lastRunHoursAgo} h ago)${orSweep}, or commit it by hand.`;
  } else {
    const word = syncLoop.state === "error" ? "failing" : syncLoop.state;
    const rest = sweeper && !syncLoop.stopsSweeper ? "The daily wiki sweep commits it, or commit it by hand." : "Clear that, or commit it by hand.";
    who = `The repo-sync loop is ${word} and will not commit it until that is cleared: ${syncLoop.reason}. ${rest}`;
  }
  return `${relPath} carries a priority or status change from the plans board that is not committed yet. ${who} Then try again.`;
}
