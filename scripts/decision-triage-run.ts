/**
 * One decision triage pass on one wiki, into a file of your choosing: the real
 * facts and model call, every line in `--out`, never the nightly log, no state
 * and no clock started. The model call writes its usual trace and `/agents` row.
 *
 * Usage:
 *   DECISION_TRIAGE_REPO_ROOTS=<dir,name=path> bun scripts/decision-triage-run.ts \
 *     --wiki <name> --out <file> [--root <wiki>=<path>]
 *
 * From a worktree (no `.env`, no `bots/`), with `--env-file <checkout>/.env` in front.
 * Exit code: 0 on `ok` or `partial`, 1 on `refused` or `failed`.
 */

import { parseArgs } from "node:util";
import path from "node:path";
import { loadConfig, resolveWikiAnswerConfig } from "../src/config.ts";
import { closeDb, initDb } from "../src/db/client.ts";
import { appendLogLines, DECISION_TRIAGE_DIR } from "../src/wiki/decision-triage/log.ts";
import { runDecisionTriage } from "../src/wiki/decision-triage/run.ts";
import { realTriageRunDeps, scopeVerdict, triageScope } from "../src/wiki/decision-triage/scope.ts";
import { outInsideLog, rootOverrides, triageEntries } from "../src/wiki/decision-triage/script-roots.ts";
import { isInsideDir } from "../src/wiki/work-map/dry-run.ts";

const { values } = parseArgs({
  options: {
    wiki: { type: "string" },
    out: { type: "string" },
    root: { type: "string", multiple: true },
  },
});

const wiki = values.wiki?.trim();
if (!wiki || !values.out) {
  console.error("usage: bun scripts/decision-triage-run.ts --wiki <name> --out <file> [--root <wiki>=<path>]");
  process.exit(2);
}
const out = path.resolve(values.out);

const config = loadConfig();
if (!config.decisionTriageRepoRoots) {
  console.error("DECISION_TRIAGE_REPO_ROOTS is not set: the triage is off. Set it inline on this command.");
  process.exit(2);
}
const overrides = rootOverrides(values.root ?? []);
const answerConfig = resolveWikiAnswerConfig();
const scope = await triageScope({
  workMapWikis: config.workMapWikis,
  answerWikis: answerConfig.wikis,
  entryOf: (name) => triageEntries(overrides, [name])[0],
});
const standing = scopeVerdict(scope, wiki);
if ("reason" in standing) {
  console.error(`${standing.reason}; the triage spends no model call on it`);
  process.exit(2);
}
const { entry } = standing;
if (isInsideDir(entry.root, out) || outInsideLog(out)) {
  console.error(`--out ${out} is inside the wiki root or ${DECISION_TRIAGE_DIR} (or could not be resolved); this run writes nothing there`);
  process.exit(2);
}

initDb(config);
const started = Date.now();
let exit = 0;
try {
  const res = await runDecisionTriage(realTriageRunDeps(config, entry, answerConfig, { append: (lines) => appendLogLines(out, lines), floorEntries: () => scope.covered }));
  if (res.outcome === "aborted") throw new Error("aborted");
  // Counts and repo facts only: an open card's verdict stays in the file.
  console.log(
    JSON.stringify(
      {
        out,
        outcome: res.outcome,
        ...(res.run.reason ? { reason: res.run.reason } : {}),
        cards: res.run.cards,
        counts: res.counts,
        usage: res.run.usage,
        floor: res.run.floor,
        repos: res.run.repos.map((r) => (r.found ? `${r.repo}: ${r.tipDate}, fetch ${typeof r.fetch === "object" ? "failed" : r.fetch}` : `${r.repo}: not found (${r.reason})`)),
        wallSeconds: Math.round((Date.now() - started) / 100) / 10,
      },
      null,
      1,
    ),
  );
  if (res.outcome === "refused" || res.outcome === "failed") exit = 1;
} finally {
  await closeDb();
}
process.exit(exit);
