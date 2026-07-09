/**
 * Wiki-linter watcher checker — report-only.
 *
 * A weekly sibling of the wiki-gardener that runs the lint engine
 * (`src/wiki/lint.ts`) over the bot's knowledge wiki and, when there are
 * findings, emits ONE summarizing alert pointing the reviewer at
 * `/wiki/gardener` (which hosts the Lint findings section). It NEVER writes to
 * the wiki or the DB — findings are transient, recomputed on demand.
 *
 * `runChecker` (runner.ts) passes the full `BotConfig` through, so this checker
 * only needs the bot's `wikiDir`. Like the gardener, a bot with no `wikiDir` is
 * skipped (returns []).
 */

import type { Watcher, WatcherAlert } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";
import { getWikiIndex } from "../wiki/store.ts";
import { lintWiki } from "../wiki/lint.ts";
import { todayOslo } from "../gardener/util.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "wiki-linter");

/** Human labels + pluralization for the one-line alert summary. */
const CHECK_SUMMARY: Record<string, { one: string; many: string }> = {
  "broken-link": { one: "broken link", many: "broken links" },
  orphan: { one: "orphan", many: "orphans" },
  "stale-updated": { one: "stale updated:", many: "stale updated:" },
  "missing-sources": { one: "missing Sources", many: "missing Sources" },
};

const CHECK_ORDER = ["broken-link", "orphan", "stale-updated", "missing-sources"] as const;

function summarizeCounts(counts: Record<string, number>): string {
  const parts: string[] = [];
  for (const check of CHECK_ORDER) {
    const n = counts[check] ?? 0;
    if (n <= 0) continue;
    const label = CHECK_SUMMARY[check]!;
    parts.push(`${n} ${n === 1 ? label.one : label.many}`);
  }
  return parts.join(", ");
}

export async function checkWikiLinter(
  watcher: Watcher,
  botConfig: BotConfig,
): Promise<WatcherAlert[]> {
  const name = botConfig.name;
  if (!botConfig.wikiDir) {
    log.warn("Wiki-linter: bot \"{name}\" has no wikiDir configured — skipping", {
      botName: name,
      name,
    });
    return [];
  }

  const index = await getWikiIndex({ root: botConfig.wikiDir });
  if (!index) {
    log.warn("Wiki-linter: wiki not readable for \"{name}\" — skipping", { botName: name, name });
    return [];
  }

  const { findings, counts } = await lintWiki(index);
  if (findings.length === 0) {
    log.info("Wiki-linter: no findings for \"{name}\" — wiki is clean", { botName: name, name });
    return [];
  }

  const summary = `Wiki lint: ${summarizeCounts(counts)} — review at /wiki/gardener`;
  log.info("Wiki-linter: {count} finding(s) for \"{name}\"", {
    botName: name,
    name,
    count: findings.length,
  });

  // Per-run-stable dated id: at most one lint alert per day (a same-day re-run
  // dedups by id), a new report each subsequent weekly fire. The runner skips
  // content-hash dedup for this type so an identical count next week still
  // notifies (see runner.ts `skipContentHash`).
  return [
    {
      id: `wiki-lint-${todayOslo(Date.now())}`,
      source: "wiki-linter",
      summary,
      urgency: "low",
    },
  ];
}
