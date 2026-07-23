/**
 * Wiki-committer sweeper watcher — commits uncommitted wiki changes.
 *
 * A daily sibling of the wiki-gardener/linter that catches wiki writes the
 * per-write commit seam (`src/wiki/commit.ts`) missed: manual edits made outside
 * muninn, a crashed gardener-apply run, and — crucially — writes that were
 * SKIPPED because the repo was off its default branch when they landed (the
 * commit seam deliberately leaves those for a later sweep). It exists because a
 * wiki repo that silently accumulates uncommitted pages is one `git clean` away
 * from losing them (the 2026-07-23 huginn-jarvis incident).
 *
 * Per tick, for the bot's `wikiDir`:
 *  - resolve the git toplevel; not-a-repo ⇒ no-op.
 *  - off the default branch ⇒ no-op (a feature checkout is left alone — the same
 *    rule the commit seam applies; committing onto a feature branch would be
 *    surprising).
 *  - on the default branch and dirty WITHIN THE WIKI SUBTREE (tracked-modified,
 *    untracked, or deleted — `git status --porcelain -- <wikiDir>`): commit
 *    exactly those paths via `commitWikiChange` with a `[sweep] …` subject and the
 *    file list in the body. Deletions are staged too (a removed page is a real
 *    change to commit). Unrelated dirt elsewhere in the repo is never touched.
 *
 * Report-only otherwise: it emits a `WatcherAlert` ONLY when it actually swept
 * (or when a sweep it attempted failed) — quiet when clean/off-branch/not-a-repo,
 * matching how the wiki-linter reports.
 */

import type { Watcher, WatcherAlert } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";
import {
  gitToplevel,
  onDefaultBranch,
  listWikiSubtreeDirty,
  commitWikiChange,
} from "../wiki/commit.ts";
import { todayOslo } from "../gardener/util.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "wiki-committer");

export async function checkWikiCommitter(
  watcher: Watcher,
  botConfig: BotConfig,
): Promise<WatcherAlert[]> {
  const name = botConfig.name;
  const wikiDir = botConfig.wikiDir;
  if (!wikiDir) {
    log.warn("Wiki-committer: bot \"{name}\" has no wikiDir configured — skipping", {
      botName: name,
      name,
    });
    return [];
  }

  const top = await gitToplevel(wikiDir);
  if (!top) {
    log.info("Wiki-committer: {dir} is not inside a git repo — nothing to sweep", {
      botName: name,
      dir: wikiDir,
    });
    return [];
  }

  if (!(await onDefaultBranch(top))) {
    log.info(
      "Wiki-committer: {top} is off its default branch — skipping sweep (left for a later run)",
      { botName: name, top },
    );
    return [];
  }

  const { dirty, deletions } = await listWikiSubtreeDirty(top, wikiDir);
  if (dirty.length === 0) {
    log.info("Wiki-committer: wiki subtree clean for \"{name}\" — nothing to sweep", {
      botName: name,
      name,
    });
    return [];
  }

  const n = dirty.length;
  const push = botConfig.wikiAutoCommit?.push ?? true;
  const message = `[sweep] daily wiki sweep: ${n} files`;
  // The file list rides in the commit body so the sweep is auditable in the log.
  const bodyLines = dirty.map((p) => `- ${p}`);

  const result = await commitWikiChange(wikiDir, dirty, message, {
    push,
    bodyLines,
    deletions,
  });

  if (result.committed) {
    log.info("Wiki-committer: swept {n} file(s) for \"{name}\" into a [sweep] commit", {
      botName: name,
      name,
      n,
    });
    return [
      {
        id: `wiki-sweep-${todayOslo(Date.now())}`,
        source: "wiki-committer",
        summary: `Swept ${n} uncommitted wiki file${n === 1 ? "" : "s"} into a [sweep] commit`,
        urgency: "low",
      },
    ];
  }

  // Only an actual error (git add/commit failed) is worth an alert — a
  // nothing-to-commit / off-branch race is a quiet no-op.
  if (result.reason === "error") {
    log.warn("Wiki-committer: sweep of {n} file(s) failed for \"{name}\" — see prior warnings", {
      botName: name,
      name,
      n,
    });
    return [
      {
        id: `wiki-sweep-fail-${todayOslo(Date.now())}`,
        source: "wiki-committer",
        summary: `Wiki sweep found ${n} uncommitted file${n === 1 ? "" : "s"} but the commit failed — check muninn logs`,
        urgency: "medium",
      },
    ];
  }

  log.info("Wiki-committer: sweep for \"{name}\" committed nothing ({reason})", {
    botName: name,
    name,
    reason: result.reason ?? "unknown",
  });
  return [];
}
