/**
 * The retention cleanup's statements are bounded IN POSTGRES, not in JS: a
 * DELETE blocked on a table lock must give its pooled connection back. A JS
 * race only dropped the promise, the backend kept waiting, and five abandoned
 * runs starved the 5-connection pool (measured against a held ACCESS EXCLUSIVE
 * lock). Each test holds a real lock on a second connection.
 */
import { describe, expect, test } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { TEST_DATABASE_URL } from "../test/test-db-url.ts";
import { openPostgres } from "../../db/postgres-connection.ts";
import { getDb } from "./client.ts";
import { cleanupOldTraces } from "./traces.ts";
import { cleanupOldSnapshots } from "./prompt-snapshots.ts";
import { cleanupThreadCitations } from "./research-citations.ts";
import { harvestSearchSignals } from "./search-signals.ts";
import { startRetentionCleanup, stopRetentionCleanup } from "../scheduler/retention-cleanup.ts";

setupTestDb();

/** Hold `LOCK TABLE <table> IN ACCESS EXCLUSIVE MODE` on its own connection until released. */
async function holdLock(table: string): Promise<{ release: () => Promise<void> }> {
  const { sql: holder } = openPostgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const tx = holder.begin(async (t) => {
    await t.unsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    locked();
    await released;
  });
  await isLocked;
  return {
    release: async () => {
      release();
      await tx.catch(() => {});
      await holder.end({ timeout: 1 });
    },
  };
}

async function lockWaiters(sql = getDb()): Promise<number> {
  const [row] = await sql`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return row!.n;
}

/** Settles to the call's outcome, or "still waiting" after `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<{ state: "resolved" | "rejected" | "still waiting"; error?: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    p.then(
      () => ({ state: "resolved" as const }),
      (error) => ({ state: "rejected" as const, error }),
    ),
    new Promise<{ state: "still waiting" }>((r) => (timer = setTimeout(() => r({ state: "still waiting" }), ms))),
  ]);
  clearTimeout(timer);
  return result;
}

async function selectOneMs(): Promise<number> {
  const t0 = performance.now();
  await getDb()`SELECT 1`;
  return performance.now() - t0;
}

const OPT = { statementTimeoutMs: 300 };

const CASES: Array<[string, string, () => Promise<number>]> = [
  ["cleanupOldTraces", "traces", () => cleanupOldTraces(7, OPT)],
  ["cleanupOldSnapshots", "prompt_snapshots", () => cleanupOldSnapshots({ chatDays: 3, captureDays: 90 }, OPT)],
  ["cleanupThreadCitations", "research_citations", () => cleanupThreadCitations(7, OPT)],
  ["harvestSearchSignals", "search_signals", () => harvestSearchSignals(OPT)],
];

describe("retention statements against a held table lock", () => {
  for (const [fn, table, call] of CASES) {
    test(`${fn} rejects with a statement timeout and frees its backend (lock on ${table})`, async () => {
      const lock = await holdLock(table);
      let pending: Promise<number> | undefined;
      try {
        pending = call();
        const outcome = await within(pending, 2_000);
        expect(outcome.state, `${fn} must give up on the lock wait, not keep a backend waiting`).toBe("rejected");
        expect(String((outcome.error as Error)?.message)).toContain("statement timeout");
        expect(await lockWaiters()).toBe(0);
        expect(await selectOneMs()).toBeLessThan(1_000);
      } finally {
        await lock.release();
        await pending?.catch(() => {});
      }
    });
  }

  test("a successful bounded call does not leave statement_timeout set on the pooled connections", async () => {
    await cleanupOldTraces(7, OPT);
    await cleanupOldSnapshots({ chatDays: 3, captureDays: 90 }, OPT);
    await cleanupThreadCitations(7, OPT);
    await harvestSearchSignals(OPT);
    // Five concurrent sleeps occupy all five pooled connections.
    const rows = await Promise.all(
      Array.from({ length: 5 }, () => getDb()`SELECT current_setting('statement_timeout') AS s, pg_sleep(0.05)`),
    );
    expect(rows.map((r) => r[0]!.s)).toEqual(["0", "0", "0", "0", "0"]);
  });

  test("ticks against a held lock never exhaust the pool: at most one backend waits", async () => {
    const lock = await holdLock("traces");
    // Counted on a connection of its own: a starved pool would hang the count.
    const { sql: monitor } = openPostgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    // `runTimeoutMs` was the JS run bound that abandoned runs with their backends
    // still waiting; it is ignored now, and kept here so the regression stays visible.
    const opts = { firstDelayMs: 0, intervalMs: 100, runTimeoutMs: 50 };
    try {
      startRetentionCleanup(
        { schedulerEnabled: true, tracingRetentionDays: 7, promptSnapshotsRetentionDays: 3, promptSnapshotsCaptureRetentionDays: 90 },
        opts,
      );
      await Bun.sleep(800); // 8 ticks
      const outcome = await within(getDb()`SELECT 1`, 1_000);
      const waiters = await lockWaiters(monitor);
      expect(outcome.state, "SELECT 1 must answer while the cleanup is blocked").toBe("resolved");
      expect(waiters, "backends waiting on the held lock").toBeLessThanOrEqual(1);
    } finally {
      await lock.release();
      await monitor.end({ timeout: 1 });
      await stopRetentionCleanup(5_000);
    }
  });
});
