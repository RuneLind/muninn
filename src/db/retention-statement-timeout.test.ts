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
import { closeDb, getDb, initDb } from "./client.ts";
import { withStatementTimeout } from "./statement-timeout.ts";
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
      Array.from({ length: 5 }, () =>
        getDb()`SELECT current_setting('statement_timeout') AS s, current_setting('client_connection_check_interval') AS c, pg_sleep(0.05)`,
      ),
    );
    expect(rows.map((r) => r[0]!.s)).toEqual(["0", "0", "0", "0", "0"]);
    expect(rows.map((r) => r[0]!.c)).toEqual(["0", "0", "0", "0", "0"]);
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

// ── Batched deletes: a large backlog converges across runs ────────────────
// One unbatched DELETE over a backlog that outlives the statement timeout rolls
// back whole, and the next hourly run fails the same way. Each batch is its
// own statement and its own commit, so a timed-out batch keeps the earlier ones.

const OLD_DAYS = 30;

/** `n` rows older than every window, oldest first, then one fresh row. Returns the old ids in age order. */
async function seedBacklog(table: "traces" | "prompt_snapshots" | "research_citations", n: number): Promise<string[]> {
  const sql = getDb();
  const ids: string[] = [];
  for (let i = 0; i <= n; i++) {
    const fresh = i === n;
    // Old rows one minute apart, so ORDER BY created_at is the insertion order.
    const age = fresh ? sql`NOW()` : sql`NOW() - make_interval(days => ${OLD_DAYS}) + make_interval(mins => ${i})`;
    let row;
    if (table === "traces") {
      [row] = await sql`INSERT INTO traces (trace_id, name, created_at) VALUES (gen_random_uuid(), 'span', ${age}) RETURNING id`;
    } else if (table === "prompt_snapshots") {
      [row] = await sql`
        INSERT INTO prompt_snapshots (trace_id, system_prompt, user_prompt, created_at)
        VALUES (gen_random_uuid(), 's', 'u', ${age}) RETURNING id`;
    } else {
      [row] = await sql`
        INSERT INTO research_citations (doc_id, collection, cited, thread_id, created_at)
        VALUES ('d', 'c', false, gen_random_uuid(), ${age}) RETURNING id`;
    }
    if (!fresh) ids.push(row!.id);
  }
  return ids;
}

async function remainingIds(table: string): Promise<string[]> {
  const rows = await getDb().unsafe(`SELECT id FROM ${table} ORDER BY created_at`);
  return rows.map((r) => r.id as string);
}

/** Hold a row lock (`SELECT … FOR UPDATE`) on one row, on its own connection. */
async function holdRowLock(table: string, id: string): Promise<{ release: () => Promise<void> }> {
  const { sql: holder } = openPostgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const tx = holder.begin(async (t) => {
    await t.unsafe(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
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

type BatchOpts = { statementTimeoutMs?: number; batchSize?: number; maxBatches?: number; shouldStop?: () => boolean };
const DELETES: Array<[string, "traces" | "prompt_snapshots" | "research_citations", (o: BatchOpts) => Promise<number>]> = [
  ["cleanupOldTraces", "traces", (o) => cleanupOldTraces(7, o as never)],
  ["cleanupOldSnapshots", "prompt_snapshots", (o) => cleanupOldSnapshots({ chatDays: 3, captureDays: 3 }, o as never)],
  ["cleanupThreadCitations", "research_citations", (o) => cleanupThreadCitations(7, o as never)],
];

describe("retention deletes run in batches", () => {
  for (const [fn, table, del] of DELETES) {
    test(`${fn}: a backlog larger than one batch is deleted across batches, and the fresh row stays`, async () => {
      await seedBacklog(table, 5);
      const fresh = (await remainingIds(table)).at(-1);
      expect(await del({ ...OPT, batchSize: 2 })).toBe(5);
      expect(await remainingIds(table)).toEqual([fresh!]);
    });

    test(`${fn}: a batch that times out leaves the earlier batches committed`, async () => {
      const ids = await seedBacklog(table, 6);
      // Batches of 2, oldest first: the third batch reaches the locked fifth row.
      const lock = await holdRowLock(table, ids[4]!);
      let outcome: Awaited<ReturnType<typeof within>>;
      try {
        outcome = await within(del({ ...OPT, batchSize: 2 }), 3_000);
      } finally {
        await lock.release();
      }
      expect(outcome.state).toBe("rejected");
      expect(String((outcome.error as Error)?.message)).toContain("statement timeout");
      const left = await remainingIds(table);
      expect(left.slice(0, 2), "only the rows from the timed-out batch on are left").toEqual([ids[4]!, ids[5]!]);
      expect(left).toHaveLength(3);
      expect((outcome.error as { deleted?: number }).deleted, "rows the committed batches deleted").toBe(4);
    });

    test(`${fn}: the per-run batch cap stops the run, and the next run carries on`, async () => {
      await seedBacklog(table, 5);
      expect(await del({ ...OPT, batchSize: 2, maxBatches: 2 })).toBe(4);
      expect(await remainingIds(table)).toHaveLength(2);
      expect(await del({ ...OPT, batchSize: 2, maxBatches: 2 })).toBe(1);
      expect(await remainingIds(table)).toHaveLength(1);
    });

    test(`${fn}: the stop flag ends the run between batches`, async () => {
      await seedBacklog(table, 6);
      let checks = 0;
      expect(await del({ ...OPT, batchSize: 2, shouldStop: () => checks++ >= 1 })).toBe(2);
      expect(await remainingIds(table)).toHaveLength(5);
    });
  }
});

describe("withStatementTimeout: a timeout below 1 ms is refused", () => {
  for (const ms of [0, -5, Number.NaN, 0.5, Number.POSITIVE_INFINITY]) {
    test(`statementTimeoutMs ${ms} throws and runs nothing`, async () => {
      let ran = false;
      await expect(
        withStatementTimeout({ statementTimeoutMs: ms }, async (sql) => {
          ran = true;
          return sql`SELECT 1`;
        }),
      ).rejects.toThrow(/statementTimeoutMs/);
      expect(ran).toBe(false);
    });
  }

  test("1 ms is a real bound: pg_sleep times out", async () => {
    await expect(withStatementTimeout({ statementTimeoutMs: 1 }, (sql) => sql`SELECT pg_sleep(0.2)`)).rejects.toThrow(
      /statement timeout/,
    );
  });
});

describe("closeDb with a timeout", () => {
  test("returns within its bound while a statement is blocked on a lock", async () => {
    const lock = await holdLock("traces");
    // No statement timeout: this DELETE would wait on the lock for as long as it is held.
    const blocked = getDb()`DELETE FROM traces`.then(
      () => "done",
      (e: Error) => e.message,
    );
    let closing: Promise<void> | undefined;
    try {
      await Bun.sleep(100);
      closing = closeDb({ timeoutSeconds: 1 } as never);
      const outcome = await within(closing, 3_000);
      expect(outcome.state, "closeDb must not wait for the blocked statement").toBe("resolved");
      expect(await within(blocked, 1_000)).toMatchObject({ state: "resolved" });
    } finally {
      await lock.release();
      await blocked;
      await closing;
      initDb({ databaseUrl: TEST_DATABASE_URL } as never);
      await getDb().unsafe("SET client_min_messages = WARNING");
    }
  });

  test("a bounded statement orphaned by the close stops waiting in Postgres too, not only in JS", async () => {
    const lock = await holdLock("traces");
    // Counted on a connection of its own: the pool under test is being closed.
    const { sql: monitor } = openPostgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    const blocked = cleanupOldTraces(7, { statementTimeoutMs: 60_000 }).catch(() => 0);
    let closing: Promise<void> | undefined;
    try {
      await Bun.sleep(200);
      expect(await lockWaiters(monitor)).toBe(1);
      closing = closeDb({ timeoutSeconds: 1 });
      await closing;
      let waiters = 1;
      for (let i = 0; i < 30 && waiters > 0; i++) {
        await Bun.sleep(100);
        waiters = await lockWaiters(monitor);
      }
      expect(waiters, "the terminated client's backend must not keep waiting on the lock").toBe(0);
    } finally {
      await lock.release();
      await blocked;
      await closing;
      await monitor.end({ timeout: 1 });
      initDb({ databaseUrl: TEST_DATABASE_URL } as never);
      await getDb().unsafe("SET client_min_messages = WARNING");
    }
  });
});
