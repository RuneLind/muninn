import { test, expect, describe, afterAll } from "bun:test";
import postgres from "postgres";
import { TEST_DATABASE_URL } from "../test/test-db-url.ts";
import { runMigrations } from "../../db/migrate.ts";

/**
 * The migration runner's advisory lock.
 *
 * The failure it exists for: two replicas rolling out at the same instant both
 * read `schema_migrations`, both compute the same pending list, and both apply
 * it. The runner's `max: 1` connection and per-migration `sql.begin` make ONE
 * run atomic per migration and say nothing at all about two runs — most files in
 * `db/migrations/` are written as a bare `CREATE TABLE`, so the loser crashes
 * and the platform reports a crash-loop for a database that is in fact fine.
 *
 * Asserted by HOLDING the lock from an outside session and showing the runner
 * waits, rather than by racing two runs and hoping to catch the interleaving:
 * a race against an already-migrated database applies nothing either way, and
 * would pass on a runner with no lock at all.
 */
const LOCK_KEY = 0x6d756e6e;

/** Long enough that a runner ignoring the lock would have finished (a no-op run
 *  against the migrated test DB is single-digit ms), short enough to keep the
 *  suite quick. */
const BLOCK_OBSERVE_MS = 700;

const holder = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
afterAll(async () => { await holder.end(); });

describe("db/migrate.ts advisory lock", () => {
  test("a run BLOCKS while another session holds the lock, then completes", async () => {
    await holder`SELECT pg_advisory_lock(${LOCK_KEY})`;

    let settled = false;
    const run = runMigrations(TEST_DATABASE_URL, { quiet: true }).then(() => { settled = true; });

    await new Promise((r) => setTimeout(r, BLOCK_OBSERVE_MS));
    // The whole assertion: with the lock held elsewhere, the runner has not
    // read the pending list, let alone applied anything.
    expect(settled).toBe(false);

    await holder`SELECT pg_advisory_unlock(${LOCK_KEY})`;
    await run;
    expect(settled).toBe(true);
  });

  test("the run RELEASES the lock — a second run is not blocked forever", async () => {
    // The other half. A lock taken and never released turns the first rollout
    // into a permanent block on every later one, which is a worse outage than
    // the race it closes.
    await runMigrations(TEST_DATABASE_URL, { quiet: true });
    const [row] = await holder`
      SELECT count(*)::int AS held FROM pg_locks
      WHERE locktype = 'advisory' AND objid = ${LOCK_KEY} AND granted
    `;
    expect(row?.held).toBe(0);

    // And it can be taken again immediately, from here.
    const [got] = await holder`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS ok`;
    expect(got?.ok).toBe(true);
    await holder`SELECT pg_advisory_unlock(${LOCK_KEY})`;
  });
});
