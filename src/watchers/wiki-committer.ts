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
 * On a machine running the repo-sync loop (`SYNC_REPOS`, `src/sync/`) this
 * sweeper can be SUBSUMED for a repo the loop owns in `wiki` mode and stand down
 * — the loop does the same job with a quiet period and a rebase, and running both
 * would void both guarantees. But CONFIGURATION does not subsume anything:
 * `syncSubsumesSweeper` stands this sweeper down only on EVIDENCE the loop
 * reached its commit path inside ~26h, plus the one `blocked` case where the
 * sweeper is unsafe rather than redundant. The warn is decoupled from the
 * stand-down, so a loop that has not committed in ~26h says so once a day even
 * while it subsumes.
 *
 * Per tick, for the bot's `wikiDir`:
 *  - resolve the git toplevel; not-a-repo ⇒ no-op.
 *  - covered by a `wiki`-mode `SYNC_REPOS` entry WITH evidence (or blocked) ⇒
 *    no-op (subsumed) — but warn first if the loop has not committed in ~26h.
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

import { existsSync } from "node:fs";
import type { Watcher, WatcherAlert } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";
import {
  gitToplevel,
  onDefaultBranch,
  listWikiSubtreeDirty,
  commitWikiChange,
} from "../wiki/commit.ts";
import { syncSubsumesSweeper } from "../sync/run.ts";
import { todayOslo } from "../gardener/util.ts";
import { openSourceHealth } from "./source-health.ts";
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
    // Nothing to track: with no wikiDir there is no source to be healthy or unhealthy about.
    return [];
  }

  // Per-source health (2026-07 audit). The off-default-branch no-op below is the single
  // most dangerous skip in this checker: `src/wiki/commit.ts` applies the SAME rule to
  // per-write commits and defers to this sweeper, so if a human leaves the wiki repo on a
  // feature branch, BOTH layers defer to each other and nothing is ever committed —
  // silently, at INFO, once a day, while gardener applies and fact-check appends keep
  // landing uncommitted. That is the 2026-07-23 87-page-loss shape, and it reported
  // "healthy" (`alertsFound: 0`) throughout, indistinguishable from a clean tree.
  const health = await openSourceHealth(watcher.id, watcher.name);
  const SRC = `committer:${name}`;

  const top = await gitToplevel(wikiDir);
  if (!top) {
    // `gitToplevel` returns null on ANY nonzero exit, so this branch conflates a
    // legitimately non-repo wiki with a broken one — a moved/typo'd wikiDir (git exits
    // 128), git missing from PATH, a dubious-ownership refusal. Marking all of those `ok`
    // would report healthy forever while the sweeper is 100% dead and gardener applies
    // keep writing uncommitted files: the 87-page-loss shape again. A missing directory
    // is the realistic case and is definitely an error; a present-but-non-repo directory
    // is a legitimate configuration and stays `ok`.
    //
    // Residual (accepted): git-absent or an ownership refusal on an EXISTING repo dir
    // still reads `ok` here. Distinguishing them needs `gitToplevel` to surface the exit
    // code, which is a wider change to `src/wiki/commit.ts` than this seam warrants.
    if (!existsSync(wikiDir)) {
      log.error("Wiki-committer: wikiDir {dir} does not exist — nothing can ever be swept", {
        botName: name,
        dir: wikiDir,
      });
      health.mark(SRC, "error", `wikiDir does not exist: ${wikiDir}`);
      return health.finish();
    }
    log.info("Wiki-committer: {dir} is not inside a git repo — nothing to sweep", {
      botName: name,
      dir: wikiDir,
    });
    health.mark(SRC, "ok");
    return health.finish();
  }

  // The repo-sync loop SUBSUMES this sweeper for any repo it owns in `wiki`
  // mode. Running both would be actively harmful, not merely redundant: the
  // sweeper has no quiet period, so it commits the file the loop is deliberately
  // holding back because it was edited 30 seconds ago — and it pushes without
  // ever rebasing, so on a two-machine setup its pushes are silent
  // non-fast-forward failures. Compared on git TOPLEVELS.
  //
  // But CONFIGURATION alone is not evidence the loop runs: `SYNC_REPOS` being
  // parseable used to stand this sweeper down forever, so a machine whose launchd
  // job was never installed had nobody committing the wiki at all — the 2026-07-23
  // page-loss shape this watcher exists for. Nor is "the loop ran" evidence: a
  // tick that errors at the fetch (origin unreachable) commits nothing, so
  // `syncSubsumesSweeper` requires a tick that reached the LOCAL section inside
  // ~26h. Genuine subsumption is marked `ok`, not `skipped`: the work IS being
  // done, by the loop, so a streak would escalate a health alert on a healthy
  // configuration.
  //
  // The WARN is deliberately decoupled from the stand-down and emitted FIRST.
  // `blocked` subsumes regardless of freshness (the loop refused an unmerged
  // tree and this sweeper, having no pre-flight of its own, would commit the
  // half-finished merge) — but "nobody has committed this wiki in ~26h" is still
  // true, and the one thing that must never happen is a silent stand-down over a
  // wiki nothing is committing.
  const subsumption = await syncSubsumesSweeper(top);
  if (subsumption.configuredButIdle) {
    log.warn(
      "Wiki-committer: {top} is configured for the SYNC_REPOS loop but it has not reached a commit pass in ~26h{tail}: check the 15-min tick is firing, that origin is reachable and the loop is not pre-flight blocked, or that muninn did not just restart (the sync ledger is in-memory and refills on the next tick)",
      {
        botName: name,
        top,
        repo: subsumption.name,
        tail: subsumption.subsumed
          ? " (still standing down — the loop is blocked)"
          : " (sweeping anyway)",
      },
    );
  }
  if (subsumption.subsumed) {
    log.info(
      "Wiki-committer: {top} is covered by the SYNC_REPOS sync loop — sweep subsumed, standing down",
      { botName: name, top },
    );
    health.mark(SRC, "ok");
    return health.finish();
  }

  if (!(await onDefaultBranch(top))) {
    log.warn(
      "Wiki-committer: {top} is off its default branch — skipping sweep (left for a later run)",
      { botName: name, top },
    );
    health.mark(SRC, "skipped", "wiki repo is off its default branch — nothing can be committed");
    return health.finish();
  }

  const { dirty, deletions } = await listWikiSubtreeDirty(top, wikiDir);
  if (dirty.length === 0) {
    log.info("Wiki-committer: wiki subtree clean for \"{name}\" — nothing to sweep", {
      botName: name,
      name,
    });
    // A clean tree is the sweeper working as intended, so this is the healthy outcome.
    health.mark(SRC, "ok");
    return health.finish();
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
    health.mark(SRC, "ok");
    return [
      ...(await health.finish()),
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
    health.mark(SRC, "error", `commit of ${n} dirty file(s) failed`);
    return [
      ...(await health.finish()),
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
  // Dirty files exist but nothing was committed (an off-branch race, or a
  // nothing-to-commit disagreement). Repeating forever means the wiki stays uncommitted,
  // so this accrues a streak rather than staying a quiet no-op.
  health.mark(SRC, "skipped", `${n} dirty file(s) not committed (${result.reason ?? "unknown"})`);
  return health.finish();
}
