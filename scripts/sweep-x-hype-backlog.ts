/**
 * One-shot: sweep the pre-calibration X candidate backlog off the shelf.
 *
 * WHY THIS IS A SCRIPT, NOT A MIGRATION: the sweep is a one-time correction to THIS
 * machine's shelf, not a schema/data invariant. A migration would replay against every
 * environment created later and silently dismiss a fresh, legitimately-captured backlog.
 *
 * WHAT IT DOES: bulk-dismisses `summary_candidates` rows with `source = 'x'` and
 * `status = 'new'` created BEFORE a cutoff (default: now), setting
 * `status = 'dismissed', dismissed_reason = 'hype-dedup-sweep'`. Those rows were captured
 * under the uncalibrated pre-#383/#384/#385/#386 gate — mostly farm pointer tweets scored
 * 0.9–0.95 — and would otherwise sit on the shelf until `expireStaleCandidates(14)`.
 *
 * The sweep reason gets its OWN bucket in `candidateOutcomeStats` / the /summaries
 * Calibration tab: counted in `total`, EXCLUDED from the acceptance-rate denominator
 * (like `expired`), so it cannot distort the metric the recalibrated gate is measured
 * against. `dismissed_reason` is free text, so no migration is needed for the value.
 *
 * RECOVERABILITY: recoverable **by SQL only**. There is no un-dismiss endpoint or UI —
 * nothing is deleted, so a swept row can be restored with e.g.
 *   UPDATE summary_candidates SET status='new', dismissed_reason=NULL
 *   WHERE dismissed_reason='hype-dedup-sweep';
 * but that is a manual psql operation, not a button.
 *
 * Usage:
 *   bun scripts/sweep-x-hype-backlog.ts                       # DRY-RUN (default) — prints the plan
 *   bun scripts/sweep-x-hype-backlog.ts --execute             # actually writes
 *   bun scripts/sweep-x-hype-backlog.ts --before 2026-07-26   # only rows created before the cutoff
 *   bun scripts/sweep-x-hype-backlog.ts --source x            # override the source vertical (default 'x')
 */
import { loadConfig } from "../src/config.ts";
import { initDb, getDb, closeDb } from "../src/db/client.ts";
import { HYPE_DEDUP_SWEEP_REASON } from "../src/db/summary-candidates.ts";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`${flag} requires a value (e.g. ${flag} 2026-07-26)`);
    process.exit(1);
  }
  return value;
}

const execute = process.argv.includes("--execute");
const beforeArg = arg("--before");
const source = arg("--source") ?? "x";

function parseCutoff(raw: string | undefined): Date {
  if (!raw) return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    console.error(`--before must be a parseable date (got "${raw}")`);
    process.exit(1);
  }
  return d;
}

async function main() {
  const config = loadConfig();
  initDb(config);
  const sql = getDb();
  const cutoff = parseCutoff(beforeArg);

  console.log(`Sweep target: source='${source}', status='new', created_at < ${cutoff.toISOString()}`);
  console.log(`Mode: ${execute ? "EXECUTE (writes)" : "DRY-RUN (no writes) — pass --execute to apply"}\n`);

  // --- Before ---
  const before = await sql`
    SELECT status, dismissed_reason, count(*)::int AS n
    FROM summary_candidates
    WHERE source = ${source}
    GROUP BY status, dismissed_reason
    ORDER BY n DESC
  `;
  console.log(`Current '${source}' candidate rows by status:`);
  for (const r of before) {
    console.log(`  ${r.status}${r.dismissed_reason ? ` (${r.dismissed_reason})` : ""}: ${r.n}`);
  }

  const eligibleRows = await sql`
    SELECT count(*)::int AS n
    FROM summary_candidates
    WHERE source = ${source} AND status = 'new' AND created_at < ${cutoff}
  `;
  const eligible = Number(eligibleRows[0]?.n ?? 0);
  console.log(`\nWould sweep: ${eligible} row(s) → status='dismissed', dismissed_reason='${HYPE_DEDUP_SWEEP_REASON}'`);

  if (!execute) {
    console.log("\nDry-run — nothing written. Re-run with --execute to apply.");
    await closeDb();
    return;
  }

  const swept = await sql`
    UPDATE summary_candidates
    SET status = 'dismissed', dismissed_reason = ${HYPE_DEDUP_SWEEP_REASON}, updated_at = now()
    WHERE source = ${source} AND status = 'new' AND created_at < ${cutoff}
    RETURNING id
  `;
  console.log(`\nSwept ${swept.length} row(s).`);

  const after = await sql`
    SELECT status, dismissed_reason, count(*)::int AS n
    FROM summary_candidates
    WHERE source = ${source}
    GROUP BY status, dismissed_reason
    ORDER BY n DESC
  `;
  console.log(`\nResulting '${source}' candidate rows by status:`);
  for (const r of after) {
    console.log(`  ${r.status}${r.dismissed_reason ? ` (${r.dismissed_reason})` : ""}: ${r.n}`);
  }
  console.log("\nRecoverable by SQL only — there is no un-dismiss endpoint or UI.");

  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => {});
  process.exit(1);
});
