/**
 * Backfill author / author_score on existing X summary_candidates rows.
 *
 * Migration 050 adds the two columns and backfills `author` from candidate_src via a
 * pure-SQL parse, but `author_score` needs the huginn `x-feed-author-scores.json` lookup,
 * which SQL can't do. This one-shot script fills it in: for every X row missing a score,
 * it normalizes the handle (from `author`, else parsed from candidate_src 'X (@handle)'),
 * looks the ranking score up, and writes both columns. Idempotent — re-running only
 * touches rows still missing a score, and a handle absent from the ranking stays NULL.
 *
 * The scores file must be readable (sibling huginn checkout, or set X_AUTHOR_SCORES_PATH).
 *
 * Usage:
 *   bun scripts/backfill-candidate-authors.ts            # dry-run — prints the plan
 *   bun scripts/backfill-candidate-authors.ts --apply    # writes to the DB
 */
import { loadConfig } from "../src/config.ts";
import { initDb, getDb, closeDb } from "../src/db/client.ts";
import { normalizeHandle, getAuthorScore, getAuthorTierThresholds } from "../src/summaries/author-scores.ts";

const apply = process.argv.includes("--apply");

const config = loadConfig();
initDb(config);
const sql = getDb();

// Verify the scores file resolves before touching anything — a null threshold means the
// file is missing/unreadable, so every lookup would NULL out and the run is pointless.
const thresholds = await getAuthorTierThresholds();
if (!thresholds) {
  console.error(
    "X author-scores file unavailable (set X_AUTHOR_SCORES_PATH or check the sibling huginn checkout) — aborting.",
  );
  await closeDb();
  process.exit(1);
}
console.log(`Author tier cuts: top1%=${thresholds.top1.toFixed(4)} top5%=${thresholds.top5.toFixed(4)}\n`);

// X rows still missing a score. author may already be set (migration 050 backfill) or not.
const rows = await sql<{ id: string; author: string | null; candidate_src: string | null }[]>`
  SELECT id, author, candidate_src
  FROM summary_candidates
  WHERE source = 'x' AND author_score IS NULL
`;

console.log(`Found ${rows.length} X row(s) without an author_score${apply ? "" : " (dry-run)"}\n`);

let updated = 0;
let noHandle = 0;
let noScore = 0;

for (const row of rows) {
  // Prefer the stored author; else parse the handle out of candidate_src ('X (@handle)').
  // Regex kept IDENTICAL to migration 050's pattern (@ required) — 'X (unknown)' has no @
  // and must not match here either.
  const fromSrc = row.candidate_src?.match(/X \(@([^)]+)\)/)?.[1] ?? null;
  const handle = normalizeHandle(row.author ?? fromSrc);
  if (!handle) {
    noHandle++;
    continue;
  }
  const score = await getAuthorScore(handle);
  if (score == null) {
    noScore++;
    // Still write the normalized handle if the SQL backfill missed it.
    if (apply && !row.author) {
      await sql`UPDATE summary_candidates SET author = ${handle} WHERE id = ${row.id}`;
    }
    continue;
  }
  if (apply) {
    await sql`
      UPDATE summary_candidates
      SET author = ${handle}, author_score = ${score}
      WHERE id = ${row.id}
    `;
  }
  updated++;
  console.log(`  ${row.id} → @${handle} score=${score.toFixed(4)}`);
}

console.log(
  `\n${apply ? "Updated" : "Would update"} ${updated} row(s); ${noScore} handle(s) not in the ranking, ${noHandle} without a resolvable handle.`,
);
if (!apply) console.log("Dry-run — re-run with --apply to write.");

await closeDb();
