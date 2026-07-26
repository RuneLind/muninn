/**
 * One-shot: sweep the pre-calibration X candidate backlog off the shelf.
 *
 * WHY THIS IS A SCRIPT, NOT A MIGRATION: the sweep is a one-time correction to THIS
 * machine's shelf, not a schema/data invariant. A migration would replay against every
 * environment created later and silently dismiss a fresh, legitimately-captured backlog.
 *
 * WHAT IT DOES: bulk-dismisses `summary_candidates` rows with `source = 'x'`,
 * `status = 'new'`, a **tweet-permalink URL**, created BEFORE a cutoff, setting
 * `status = 'dismissed', dismissed_reason = 'hype-dedup-sweep'`. Those rows were captured
 * under the uncalibrated pre-#383/#384/#385/#386 gate — mostly farm pointer tweets scored
 * 0.9–0.95 — and would otherwise sit on the shelf until `expireStaleCandidates(14)`.
 *
 * WHY THE URL SCOPE (belt-and-braces): since #385 an X pointer candidate is keyed on its
 * normalized DESTINATION url, not the tweet permalink. The backlog this script exists to
 * clear is by definition pre-#385 and therefore tweet-keyed, so restricting to
 * `x.com`/`twitter.com` permalinks means a destination-keyed row can never be swept by an
 * over-broad cutoff. (`upsertDestinationCandidate` does treat the sweep reason as
 * re-admittable, so a swept destination key would not be poisoned — but not touching them
 * at all is the cheaper guarantee.)
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
 *   bun scripts/sweep-x-hype-backlog.ts --before 2026-07-26 --execute   # actually writes
 *   bun scripts/sweep-x-hype-backlog.ts --before=2026-07-26   # --flag=value form also works
 *   bun scripts/sweep-x-hype-backlog.ts --source x            # override the source vertical (default 'x')
 *
 * `--before` is REQUIRED with `--execute` (a dry-run may omit it and explore against
 * "now"). A date-only `--before` (e.g. `2026-07-26`) is parsed as **UTC midnight**, per
 * JS `Date` semantics — pass a full ISO timestamp if you need local-time precision.
 */
import { loadConfig } from "../src/config.ts";
import { initDb, getDb, closeDb } from "../src/db/client.ts";
import { HYPE_DEDUP_SWEEP_REASON } from "../src/db/summary-candidates.ts";

/** Tweet-permalink shapes only — destination-keyed (#385) rows must never be swept. */
const TWEET_URL_PATTERN = "^https?://((www|mobile)\\.)?(x|twitter)\\.com/";

const USAGE = `Usage: bun scripts/sweep-x-hype-backlog.ts [--before <date>] [--source <name>] [--execute]

  --before <date>   Only sweep rows created before this cutoff. REQUIRED with --execute.
                    A date-only value (2026-07-26) is parsed as UTC midnight.
  --source <name>   Source vertical to sweep (default: x).
  --execute         Actually write. Without it the script is a read-only dry-run.

Both --flag value and --flag=value forms are accepted.`;

const VALUE_FLAGS = new Set(["--before", "--source"]);
const BOOL_FLAGS = new Set(["--execute"]);

function usageError(msg: string): never {
  console.error(msg);
  console.error(`\n${USAGE}`);
  process.exit(1);
}

/**
 * Strict parse: only the flags above are accepted, in either `--flag value` or
 * `--flag=value` form. Any other `--token` is a usage error rather than a silent
 * no-op — a `--exeucte` typo must not read as "dry-run, all good".
 */
function parseArgs(argv: string[]): { execute: boolean; before?: string; source: string } {
  const values = new Map<string, string>();
  let execute = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) usageError(`Unexpected argument "${token}"`);

    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);

    if (BOOL_FLAGS.has(flag)) {
      if (eq !== -1) usageError(`${flag} does not take a value`);
      execute = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) usageError(`Unknown flag "${flag}"`);

    let value: string | undefined;
    if (eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      value = argv[++i];
      if (value !== undefined && value.startsWith("--")) value = undefined;
    }
    if (value === undefined || value === "") {
      usageError(`${flag} requires a value (e.g. ${flag} 2026-07-26)`);
    }
    values.set(flag, value);
  }

  return { execute, before: values.get("--before"), source: values.get("--source") ?? "x" };
}

const { execute, before: beforeArg, source } = parseArgs(process.argv.slice(2));

function parseCutoff(raw: string | undefined): Date {
  if (!raw) return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    usageError(`--before must be a parseable date (got "${raw}")`);
  }
  return d;
}

async function main() {
  // An execute run must name the era it is clearing — the implicit "now" default is fine
  // for exploring in a dry-run, but far too blunt a default for a bulk write.
  if (execute && !beforeArg) {
    usageError("--execute requires an explicit --before cutoff (e.g. --before 2026-07-26)");
  }

  const config = loadConfig();
  initDb(config);
  const sql = getDb();
  const cutoff = parseCutoff(beforeArg);

  console.log(
    `Sweep target: source='${source}', status='new', tweet-permalink url, created_at < ${cutoff.toISOString()}`,
  );
  console.log(`Mode: ${execute ? "EXECUTE (writes)" : "DRY-RUN (no writes) — pass --execute to apply"}\n`);
  if (!execute && !beforeArg) {
    console.log(
      "WARNING: no --before given, so the cutoff defaults to now (everything). --execute will REFUSE this — pass an explicit --before.\n",
    );
  }

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

  // A `--source` typo (e.g. 'X', 'x-post') would otherwise report a serene 0 rows.
  if (before.length === 0) {
    const sources = await sql`
      SELECT source, count(*)::int AS n FROM summary_candidates GROUP BY source ORDER BY n DESC
    `;
    console.warn(
      `\nWARNING: no rows at all for source='${source}' — is it a typo? Sources present: ${
        sources.length ? sources.map((r: any) => `${r.source} (${r.n})`).join(", ") : "(table empty)"
      }`,
    );
  }

  const eligibleRows = await sql`
    SELECT count(*)::int AS n
    FROM summary_candidates
    WHERE source = ${source}
      AND status = 'new'
      AND created_at < ${cutoff}
      AND url ~* ${TWEET_URL_PATTERN}
  `;
  const eligible = Number(eligibleRows[0]?.n ?? 0);
  const verb = execute ? "Sweeping" : "Would sweep";
  console.log(
    `\n${verb}: ${eligible} row(s) → status='dismissed', dismissed_reason='${HYPE_DEDUP_SWEEP_REASON}'`,
  );

  if (!execute) {
    // Show the operator WHICH era they are about to clear, not just how many rows.
    const byDay = await sql`
      SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS n
      FROM summary_candidates
      WHERE source = ${source}
        AND status = 'new'
        AND created_at < ${cutoff}
        AND url ~* ${TWEET_URL_PATTERN}
      GROUP BY 1
      ORDER BY 1
    `;
    if (byDay.length) {
      console.log("\nEligible rows by created_at (UTC day):");
      for (const r of byDay) {
        const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day);
        console.log(`  ${day}: ${r.n}`);
      }
    }
    console.log("\nDry-run — nothing written. Re-run with --before <date> --execute to apply.");
    return;
  }

  const swept = await sql`
    UPDATE summary_candidates
    SET status = 'dismissed', dismissed_reason = ${HYPE_DEDUP_SWEEP_REASON}, updated_at = now()
    WHERE source = ${source}
      AND status = 'new'
      AND created_at < ${cutoff}
      AND url ~* ${TWEET_URL_PATTERN}
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
}

// The sweep's success is decided by the UPDATE, not by the pool teardown: a rejected
// closeDb() after a completed --execute must not turn a good run into a non-zero exit.
main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => {});
  });
