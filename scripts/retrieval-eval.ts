/**
 * Retrieval eval CLI — run the golden query set against huginn / memory /
 * research retrieval and print a compact metrics table (recall@k / hit-rate /
 * MRR), persisting one row to `benchmark_retrieval_runs` for regression
 * tracking.
 *
 *   bun scripts/retrieval-eval.ts                     # all targets, default base URL
 *   bun scripts/retrieval-eval.ts --target huginn     # one target only
 *   bun scripts/retrieval-eval.ts --base-url http://localhost:8321
 *   bun scripts/retrieval-eval.ts --seed-memories     # seed synthetic memory fixtures first
 *   bun scripts/retrieval-eval.ts --no-persist        # don't write a run row
 *
 * --seed-memories writes fixture rows into whatever DATABASE_URL points at,
 * so it refuses unless the database name ends with "_test". Pass
 * --allow-live-seed to override deliberately (the fixtures are synthetic and
 * live under a dedicated fixture user, but a live DB should not be seeded by
 * accident).
 *
 * Golden set lives in the gitignored benchmarks/retrieval/*.jsonl (same
 * local-only policy as benchmarks/issues + benchmarks/rag).
 */

import { loadConfig } from "../src/config.ts";
import { initDb, closeDb } from "../src/db/client.ts";
import { discoverAllBots, resolveResearchBot } from "../src/bots/config.ts";
import {
  discoverRetrievalSets,
  runRetrievalEval,
  RETRIEVAL_TARGETS,
  type RetrievalTarget,
  type RetrievalQuery,
  type AggregateMetrics,
} from "../src/benchmarks/retrieval.ts";
import { seedMemoryFixtures, MEMORY_FIXTURE_BOT_NAME } from "../src/benchmarks/retrieval-fixtures.ts";

function parseArgs(argv: string[]) {
  const args: {
    target?: RetrievalTarget;
    baseUrl?: string;
    bot?: string;
    seedMemories: boolean;
    allowLiveSeed: boolean;
    persist: boolean;
  } = { seedMemories: false, allowLiveSeed: false, persist: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") {
      const v = argv[++i];
      if (!v || !RETRIEVAL_TARGETS.includes(v as RetrievalTarget)) {
        throw new Error(`--target must be one of ${RETRIEVAL_TARGETS.join(", ")}`);
      }
      args.target = v as RetrievalTarget;
    } else if (a === "--base-url") {
      args.baseUrl = argv[++i];
    } else if (a === "--bot") {
      args.bot = argv[++i];
    } else if (a === "--seed-memories") {
      args.seedMemories = true;
    } else if (a === "--allow-live-seed") {
      args.allowLiveSeed = true;
    } else if (a === "--no-persist") {
      args.persist = false;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

/** Database name from a postgres:// URL, or null when unparseable. */
function databaseName(databaseUrl: string): string | null {
  try {
    const name = new URL(databaseUrl).pathname.replace(/^\//, "");
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtRow(label: string, m: AggregateMetrics): string {
  return [
    label.padEnd(12),
    String(m.queryCount).padStart(5),
    fmtPct(m.hitRate).padStart(9),
    fmtPct(m.recallAtK).padStart(11),
    m.mrr.toFixed(3).padStart(7),
  ].join("  ");
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
initDb(config);

try {
  if (args.seedMemories) {
    const dbName = databaseName(config.databaseUrl);
    if (!dbName?.endsWith("_test") && !args.allowLiveSeed) {
      console.error(
        `Refusing --seed-memories: DATABASE_URL points at "${dbName ?? "?"}", which does not end with "_test".\n` +
          "Seeding writes fixture rows into this database. Point DATABASE_URL at the test DB, " +
          "or pass --allow-live-seed to seed it anyway.",
      );
      process.exit(1);
    }
    await seedMemoryFixtures();
    console.log(`Seeded synthetic memory fixtures into "${dbName}".\n`);
  }

  const sets = await discoverRetrievalSets();
  const queries: RetrievalQuery[] = sets.flatMap((s) => s.queries);
  if (queries.length === 0) {
    console.error(
      "No golden queries found in benchmarks/retrieval/*.jsonl.\n" +
        "The golden set is local-only (gitignored). Create benchmarks/retrieval/golden-queries.jsonl first.",
    );
    process.exit(1);
  }

  const knowledgeApiUrl = args.baseUrl ?? config.knowledgeApiUrl;

  // Resolve a bot for the research decomposition path.
  const bots = discoverAllBots();
  const researchBot = args.bot
    ? bots.find((b) => b.name.toLowerCase() === args.bot!.toLowerCase())
    : resolveResearchBot(bots);

  console.log(
    `Retrieval eval — ${queries.length} queries` +
      (args.target ? ` (target=${args.target})` : "") +
      `\n  huginn: ${knowledgeApiUrl}` +
      `\n  research bot: ${researchBot?.name ?? "(none discovered — research target will error)"}\n`,
  );

  const result = await runRetrievalEval({
    queries,
    knowledgeApiUrl,
    botName: researchBot?.name ?? "retrieval-eval",
    botDir: researchBot?.dir,
    connector: researchBot?.connector,
    target: args.target,
    memoryBotName: MEMORY_FIXTURE_BOT_NAME,
    persist: args.persist,
    notes: `cli${args.target ? ` target=${args.target}` : ""}`,
  });

  const { metrics, perQuery } = result;

  console.log("Per-query:");
  console.log(
    `  ${"id".padEnd(18)} ${"target".padEnd(9)} ${"hit".padStart(4)} ${"recall".padStart(7)} ${"rr".padStart(6)}  matched`,
  );
  for (const q of perQuery) {
    const status = q.skipped ? " (skipped)" : q.error ? ` (error: ${q.error})` : "";
    console.log(
      `  ${q.id.padEnd(18)} ${q.target.padEnd(9)} ${String(q.hitAtK).padStart(4)} ${fmtPct(q.recallAtK).padStart(7)} ${q.reciprocalRank.toFixed(2).padStart(6)}  ${q.matched.length}/${q.expectedCount}${status}`,
    );
  }

  console.log("\nAggregate:");
  console.log(
    `  ${"target".padEnd(12)}  ${"count".padStart(5)}  ${"hitRate".padStart(9)}  ${"recall@k".padStart(11)}  ${"MRR".padStart(7)}`,
  );
  for (const target of RETRIEVAL_TARGETS) {
    const m = metrics.perTarget[target];
    if (m) console.log(`  ${fmtRow(target, m)}`);
  }
  console.log(`  ${fmtRow("OVERALL", metrics.overall)}`);

  if (result.runId) console.log(`\nPersisted run ${result.runId}`);
} finally {
  await closeDb();
}
