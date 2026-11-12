/**
 * The step checks' applied-migrations read (`readAppliedMigrations`,
 * `src/wiki/step-checks/real-deps.ts`) against the REAL test database, on the
 * shared 5-connection pool with every connection busy: the probe answers
 * `unknown` at its 100 ms bound, and no statement another caller has pipelined
 * behind the read is ever cancelled. Cancelling a pipelined postgres.js query
 * sends a CancelRequest for the backend's pid, which lands on whatever that
 * backend runs then, usually the next caller's statement (reproduced: 3 of 60
 * rounds). Here the read is only raced by a timer and left to finish.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import { answerStepChecks, ProbeCache } from "../wiki/step-checks/answer.ts";
import type { ProbeDeps } from "../wiki/step-checks/probes.ts";
import { readAppliedMigrations } from "../wiki/step-checks/real-deps.ts";

setupTestDb();

const POOL = 5;
const ROUNDS = 30;
const page = ["---", "title: T", "---", "", "<NextMoves>", "", '<Lane kind="you">', "", '1. M <Check migration="001" />', "", "</Lane>", "", "</NextMoves>", ""].join("\n");

function probeDeps(read: () => Promise<ReadonlySet<string>>): ProbeDeps {
  return {
    git: async () => {
      throw new Error("git must not run");
    },
    roots: null,
    readEnvFile: async () => ({ missing: true }),
    processHasEnv: () => false,
    appliedMigrations: read,
  };
}

/**
 * One round: every pool connection held by another caller's `pg_sleep`, the
 * bounded read asked, then more of the other caller's statements pipelined
 * behind it. Returns the probe's state and the other caller's failures.
 */
async function round(read: () => Promise<ReadonlySet<string>>): Promise<{ state: string; failures: string[] }> {
  const sql = getDb();
  const failures: string[] = [];
  const caught = (p: PromiseLike<unknown>) => Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => void failures.push(e instanceof Error ? e.message : String(e)),
  );
  const holds = Array.from({ length: POOL }, () => caught(sql`SELECT pg_sleep(0.3)`));
  await Bun.sleep(30);
  const answered = answerStepChecks(page, { probes: probeDeps(read), machine: null, cache: new ProbeCache(), boundMs: 100 });
  await Bun.sleep(5);
  const behind = Array.from({ length: 3 * POOL }, (_, i) => caught(sql`SELECT pg_sleep(0.02), ${i}::int AS i`));
  const a = await answered;
  await Promise.all([...holds, ...behind]);
  return { state: a.steps[0]!.state, failures };
}

describe("readAppliedMigrations on a busy pool", () => {
  test(`${ROUNDS} rounds: the probe answers unknown at its bound, no other caller's statement fails, the pool still works`, async () => {
    const states: string[] = [];
    const failures: string[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const r = await round(readAppliedMigrations);
      states.push(r.state);
      failures.push(...r.failures);
    }
    expect(failures).toEqual([]);
    expect(states).toEqual(Array(ROUNDS).fill("unknown"));
    // Let the last round's read finish, then the pool answers.
    await Bun.sleep(200);
    expect((await getDb()`SELECT 1 AS one`)[0]!.one).toBe(1);
    expect((await readAppliedMigrations()).size).toBeGreaterThan(0);
  }, 60_000);

  test("an idle pool: the read returns the applied set", async () => {
    const rows = await getDb()<{ version: string }[]>`SELECT version FROM schema_migrations`;
    expect(await readAppliedMigrations()).toEqual(new Set(rows.map((r) => r.version)));
  });

  test("no step-check source calls `.cancel(`: a cancel reaches whatever the backend runs next", () => {
    const dir = path.join(import.meta.dir, "../wiki/step-checks");
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(3);
    const callers = sources.filter((f) => /\.cancel\s*\(/.test(readFileSync(path.join(dir, f), "utf8")));
    expect(callers).toEqual([]);
  });
});
