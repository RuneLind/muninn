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
import { lintWiki, LINT_CHECKS, type LintCheck } from "../wiki/lint.ts";
import { todayOslo } from "../gardener/util.ts";
import { isReadonlyWikiRoot, isWikiReadonly } from "../wiki/readonly.ts";
import {
  seedLintProposals,
  DEFAULT_LINT_PROPOSAL_DEPS,
} from "../gardener/lint-proposals.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "wiki-linter");

/**
 * Human labels + pluralization for the one-line alert summary. `Record<LintCheck, …>`
 * so a new check cannot compile without one — an unlabelled check would alert with
 * an empty sentence ("Wiki lint:  — review at …") while findings piled up.
 */
const CHECK_SUMMARY: Record<LintCheck, { one: string; many: string }> = {
  "broken-link": { one: "broken link", many: "broken links" },
  orphan: { one: "orphan", many: "orphans" },
  "stale-updated": { one: "stale updated:", many: "stale updated:" },
  "missing-sources": { one: "missing Sources", many: "missing Sources" },
  "index-truncation": { one: "truncated wikilink", many: "truncated wikilinks" },
  "nested-annotation": { one: "nested annotation", many: "nested annotations" },
  "unrendered-fact-mark": { one: "unrendered fact mark", many: "unrendered fact marks" },
  "stem-collision": { one: "stem collision", many: "stem collisions" },
  "same-work-no-link": { one: "unlinked pair", many: "unlinked pairs" },
  "series-unnamed": { one: "unnamed series", many: "unnamed series" },
  "series-inconsistent": { one: "inconsistent series", many: "inconsistent series" },
};

/** Iterates the ENGINE's own list, never a re-typed order: `summarizeCounts` walks
 *  the checks, not the label map, so a hand-maintained copy missing a new check
 *  produced the empty sentence even with the map above fully typed. */
function summarizeCounts(counts: Record<LintCheck, number>): string {
  const parts: string[] = [];
  for (const check of LINT_CHECKS) {
    const n = counts[check];
    if (n <= 0) continue;
    const label = CHECK_SUMMARY[check]!;
    parts.push(`${n} ${n === 1 ? label.one : label.many}`);
  }
  return parts.join(", ");
}

/** The one seam this checker writes through, injectable so a test can assert
 *  THAT it ran — the seeder's answer is counts, and every outcome it can report
 *  on a clean wiki is zero. */
export interface WikiLinterDeps {
  seed: typeof seedLintProposals;
}

export async function checkWikiLinter(
  watcher: Watcher,
  botConfig: BotConfig,
  deps: WikiLinterDeps = { seed: seedLintProposals },
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

  // Check 8's findings carry a FIX, so the weekly pass also seeds the review
  // gate with them — the one thing this watcher writes, and only to the DB.
  //
  // Both read-only mechanisms refuse first: the mini must never fill the gate
  // with rows only the write owner can apply. A group already proposed — in any
  // status, a dismissal's `rejected` rows included — is skipped by the seeder,
  // so a weekly re-run does not re-propose what a reviewer said no to.
  //
  // **It runs even when this pass has NOTHING to propose, and before the
  // clean-wiki return.** The seeder's first rule is the SELF-HEAL, which retires
  // every live `draft` group whose key no current finding mints — so a wiki
  // whose fixable findings have all been fixed is EXACTLY the state where every
  // live group is superseded. The first cut skipped the call on
  // `fixable.length === 0` and claimed the opposite ("nothing that could have
  // superseded a live group either"), which left those cards live forever. The
  // cost of being wrong the other way is one indexed read per wiki per week.
  const fixable = findings.filter((f) => f.fix);
  if (isWikiReadonly() || isReadonlyWikiRoot(botConfig.wikiDir)) {
    log.info("Wiki-linter: read-only, not seeding lint proposals for \"{name}\"", {
      botName: name,
      name,
    });
  } else {
    try {
      const seeded = await deps.seed(fixable, {
        ...DEFAULT_LINT_PROPOSAL_DEPS,
        wikiDir: botConfig.wikiDir,
        wikiName: name,
      });
      if (seeded.proposed > 0 || seeded.staled > 0) {
        log.info(
          "Wiki-linter: proposed {proposed} lint fix group(s) ({rows} rows), retired {staled}, {claimed} page-claimed for \"{name}\"",
          {
            botName: name,
            name,
            proposed: seeded.proposed,
            rows: seeded.rows,
            staled: seeded.staled,
            claimed: seeded.claimed,
          },
        );
      }
    } catch (err) {
      // Best-effort: a seeding failure must never cost the report itself.
      log.warn("Wiki-linter: seeding lint proposals failed for \"{name}\": {error}", {
        botName: name,
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

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
  // notifies (this type is on `dedupContentHash`'s per-type skip list in runner.ts).
  return [
    {
      id: `wiki-lint-${todayOslo(Date.now())}`,
      source: "wiki-linter",
      summary,
      urgency: "low",
    },
  ];
}
