/**
 * Run the work map (either kind) on one wiki without touching it: the real
 * digest, model call and normalize, the map written to `--out`, nothing
 * committed, no state file (`src/wiki/work-map/dry-run.ts`). The model call
 * writes its usual trace and `/agents` row.
 *
 * Usage:
 *   bun scripts/work-map-dry-run.ts --wiki <name> --out <file> [--previous <file>]
 *     [--root <path>]          the wiki's root, when this checkout's registry lacks it
 *     [--save-answer <file>]   also save the model answer, its prompt and the run's clock
 *     [--answer <file>]        replay a saved answer through normalize at its saved clock;
 *                              no model call, $0. Refused when tonight's digest differs
 *                              from the saved prompt (pass the same --previous).
 *
 * From a worktree (no `.env`, no `bots/`):
 *   bun --env-file <checkout>/.env scripts/work-map-dry-run.ts --wiki jarvis --root <wiki root> --out /tmp/x.json
 */

import { parseArgs } from "node:util";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { closeDb, initDb } from "../src/db/client.ts";
import { getWikiRegistry } from "../src/wiki/registry-memo.ts";
import { readFile } from "node:fs/promises";
import { dryRunDeps, parseSavedAnswer } from "../src/wiki/work-map/dry-run.ts";
import { realWorkMapModel, startWorkMapRun } from "../src/wiki/work-map/run.ts";

const { values } = parseArgs({
  options: {
    wiki: { type: "string" },
    out: { type: "string" },
    previous: { type: "string" },
    root: { type: "string" },
    "save-answer": { type: "string" },
    answer: { type: "string" },
  },
});

const wiki = values.wiki?.trim();
if (!wiki || !values.out) {
  console.error("usage: bun scripts/work-map-dry-run.ts --wiki <name> --out <file> [--previous <file>] [--root <path>] [--save-answer <file>] [--answer <file>]");
  process.exit(2);
}

const config = loadConfig();
const entry = values.root
  ? { name: wiki, root: path.resolve(values.root), source: "extra" as const }
  : getWikiRegistry().find((e) => e.name.toLowerCase() === wiki.toLowerCase());
if (!entry) {
  console.error(`${wiki} is not a registered wiki here; pass --root <path>`);
  process.exit(2);
}

if (!values.answer) initDb(config);
const started = Date.now();
try {
  const deps = dryRunDeps({
    entry,
    model: config.workMapModel,
    ...(config.workMapEffort ? { effort: config.workMapEffort } : {}),
    profile: config.profile,
    out: path.resolve(values.out),
    ...(values.previous ? { previous: path.resolve(values.previous) } : {}),
    ...(values.answer ? { answer: parseSavedAnswer(await readFile(path.resolve(values.answer), "utf8")) } : {}),
    ...(values["save-answer"] ? { saveAnswer: path.resolve(values["save-answer"]) } : {}),
    callModel: realWorkMapModel(config),
  });
  const res = await startWorkMapRun(entry.name, deps).promise;
  const wall = Math.round((Date.now() - started) / 100) / 10;
  if (res.outcome !== "ok") {
    console.error(`${res.outcome}${"reason" in res ? `: ${res.reason}` : ""}`);
    process.exitCode = 1;
  } else {
    const m = res.map;
    const cov = m.coverage as Record<string, unknown>;
    console.log(
      JSON.stringify(
        {
          out: path.resolve(values.out),
          kind: "kind" in m ? m.kind : "work",
          efforts: m.efforts.length,
          needsYou: m.needsYou.length,
          loose: m.loose.length,
          coverage: cov,
          usage: m.usage,
          wallSeconds: wall,
        },
        null,
        1,
      ),
    );
  }
} finally {
  if (!values.answer) await closeDb();
}
