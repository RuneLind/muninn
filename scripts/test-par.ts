/**
 * `bun run test:par`: every link of the generated `test` chain, several processes
 * at a time, so a local run holds exactly CI's file sets.
 *
 *   bun scripts/test-par.ts [--jobs N]    run the chain, N links at a time (default 6)
 *   bun scripts/test-par.ts --list-stale  print `_test` databases that are neither muninn_test nor a slot's
 *   bun scripts/test-par.ts --drop-stale [--yes]  print what it would drop; with --yes, drop them
 *
 * Each slot gets its own database, `muninn_par_<slot>_test`, rebuilt the way
 * `db:setup:test` builds `muninn_test` and reused across runs; its links see it in
 * both `MUNINN_TEST_DATABASE_URL` and `DATABASE_URL`. The fixed scratch databases
 * and the role some DB tests create (`db/provision.test.ts`, three under `src/db/`)
 * each belong to one link, so no two slots touch them at once. Two `test:par` runs
 * on one server at the same time do collide, as two `bun run test` runs do.
 *
 * `--drop-stale` refuses outright while any `_test` database has a connection: a
 * run between two links holds none on the database it will use next, so "skip
 * what is in use" is not enough. Do not run it while other sessions are testing.
 *
 * Children are spawned in their own process group and killed, group and all, on
 * SIGINT, SIGTERM or any exit, so none keeps writing to a slot's database.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { openPostgres } from "../db/postgres-connection.ts";
import { TEST_DATABASE_URL } from "../src/test/test-db-url.ts";
import { check, junitName, linkCost, loadChain, readTimings, SHARD_TOTAL, type ChainLink } from "./test-chain.ts";

const ROOT = path.join(import.meta.dir, "..");
const OUT_DIR = path.join(ROOT, ".test-par");
export const DEFAULT_JOBS = 6;
const SLOT_DB = /^muninn_par_\d+_test$/;
const TEST_DB = /^[A-Za-z0-9_]+_test$/;

export function slotDbName(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1) throw new Error(`slot must be a positive integer, got ${slot}`);
  return `muninn_par_${slot}_test`;
}

/** `base` with its database swapped; credentials, host and query kept. */
export function withDatabase(base: string, name: string): string {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
}

export function childEnv(env: Record<string, string | undefined>, url: string): Record<string, string | undefined> {
  return { ...env, MUNINN_TEST_DATABASE_URL: url, DATABASE_URL: url };
}

/** `--jobs N` or `--jobs=N`, a positive integer; `DEFAULT_JOBS` when absent. */
export function parseJobs(argv: readonly string[]): number {
  let raw: string | undefined;
  argv.forEach((a, i) => {
    if (a === "--jobs") raw = argv[i + 1] ?? "";
    else if (a.startsWith("--jobs=")) raw = a.slice("--jobs=".length);
  });
  if (raw === undefined) return DEFAULT_JOBS;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`--jobs takes a positive integer, got "${raw}"`);
  return Number(raw);
}

/**
 * The `_test` databases `--drop-stale` may drop: never `muninn_test`, a slot's,
 * or one named in `keep` (the database this run's TEST_DATABASE_URL names).
 */
export function staleDatabases(names: readonly string[], keep: readonly string[] = []): string[] {
  const kept = new Set(["muninn", "muninn_test", ...keep]);
  return names.filter((n) => TEST_DB.test(n) && !kept.has(n) && !SLOT_DB.test(n)).sort();
}

export type DropPlan = { kind: "refuse"; busy: string[] } | { kind: "dry-run" | "drop"; drop: string[] };

/**
 * Refuse when any `_test` database has a connection (`active`: name → count),
 * slots and `muninn_test` included: that is a test run live on the server, and
 * its scratch databases are among the candidates. Otherwise drop only with `yes`.
 */
export function planDrop(stale: readonly string[], active: Readonly<Record<string, number>>, yes: boolean): DropPlan {
  const busy = Object.keys(active).filter((n) => TEST_DB.test(n) && (active[n] ?? 0) > 0).sort();
  if (busy.length > 0) return { kind: "refuse", busy };
  return { kind: yes ? "drop" : "dry-run", drop: [...stale] };
}

/** Live child process groups, killed together on a signal or any exit. */
export class ChildRegistry {
  private readonly live = new Set<number>();
  constructor(private readonly kill: (pid: number, sig: NodeJS.Signals) => void = (pid, sig) => process.kill(pid, sig)) {}
  add(pid: number): void {
    this.live.add(pid);
  }
  delete(pid: number): void {
    this.live.delete(pid);
  }
  /** Signals each live child's process group (`-pid`); one already gone does not stop the rest. */
  killAll(sig: NodeJS.Signals): number {
    let n = 0;
    for (const pid of this.live) {
      try {
        this.kill(-pid, sig);
        n++;
      } catch {
        // ESRCH: the group is already gone
      }
    }
    this.live.clear();
    return n;
  }
}

export function signalExitCode(sig: "SIGINT" | "SIGTERM"): number {
  return 128 + (sig === "SIGINT" ? 2 : 15);
}

/** Longest first by `cost`, so the slowest links do not start last. */
export function parOrder<T extends { key: string }>(links: readonly T[], cost: (l: T) => number): T[] {
  return [...links].sort((a, b) => cost(b) - cost(a) || a.key.localeCompare(b.key));
}

/**
 * `run` over `items`, at most `jobs` at a time. Each worker owns one slot
 * (1..min(jobs, items)) for its whole life, so two concurrent runs never share
 * a slot. `run` must not throw.
 */
export async function runPool<T, R>(items: readonly T[], jobs: number, run: (item: T, slot: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(jobs, items.length) }, async (_, i) => {
    while (next < items.length) {
      const at = next++;
      results[at] = await run(items[at]!, i + 1);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- I/O ---

const children = new ChildRegistry();

function spawnTracked(cmd: string[], opts: Parameters<typeof Bun.spawn>[1]): Bun.Subprocess {
  const proc = Bun.spawn(cmd, { ...opts, detached: true });
  children.add(proc.pid);
  void proc.exited.then(() => children.delete(proc.pid));
  return proc;
}

function adminUrl(): string {
  return withDatabase(TEST_DATABASE_URL, "muninn");
}

async function listTestDatabases(): Promise<string[]> {
  const { sql } = openPostgres(adminUrl(), { max: 1 });
  try {
    const rows = await sql<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname LIKE '%\\_test'`;
    return rows.map((r) => r.datname);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function activeTestDatabases(): Promise<Record<string, number>> {
  const { sql } = openPostgres(adminUrl(), { max: 1 });
  try {
    const rows = await sql<{ datname: string; n: number }[]>`
      SELECT datname, count(*)::int AS n FROM pg_stat_activity
      WHERE datname LIKE '%\\_test' AND pid <> pg_backend_pid() GROUP BY datname`;
    return Object.fromEntries(rows.map((r) => [r.datname, r.n]));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function cmdStale(drop: boolean, yes: boolean): Promise<number> {
  const keep = [new URL(TEST_DATABASE_URL).pathname.slice(1)];
  const stale = staleDatabases(await listTestDatabases(), keep);
  for (const n of stale) console.log(n);
  console.log(`${stale.length} stale _test database(s)`);
  if (!drop || stale.length === 0) return 0;
  const plan = planDrop(stale, await activeTestDatabases(), yes);
  if (plan.kind === "refuse") {
    console.error(`✗ refusing to drop anything: a test run is live on this server (connections to ${plan.busy.join(", ")}). Run --drop-stale only while no other session is testing.`);
    return 1;
  }
  if (plan.kind === "dry-run") {
    console.log(`would drop ${plan.drop.length} database(s); pass --yes to drop them`);
    return 0;
  }
  const { sql } = openPostgres(adminUrl(), { max: 1, onnotice: () => {} });
  let failed = 0;
  try {
    for (const n of plan.drop) {
      try {
        await sql.unsafe(`DROP DATABASE "${n}"`);
        console.log(`dropped ${n}`);
      } catch (e) {
        failed++;
        console.log(`skipped ${n}: ${(e as Error).message}`);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return failed === 0 ? 0 : 1;
}

async function setupSlot(slot: number): Promise<{ slot: number; url: string; code: number; output: string }> {
  const url = withDatabase(TEST_DATABASE_URL, slotDbName(slot));
  const proc = spawnTracked(["bun", "db/setup-test-db.ts"], { cwd: ROOT, env: childEnv(process.env, url), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
  return { slot, url, code, output: out + err };
}

interface LinkRun {
  link: ChainLink;
  slot: number;
  code: number;
  seconds: number;
  log: string;
}

async function cmdRun(jobs: number): Promise<number> {
  const t0 = performance.now();
  const { tree, table, links } = loadChain();
  const cost = linkCost(tree, readTimings());
  const order = parOrder(links, cost);
  const slots = Math.min(jobs, order.length);

  rmSync(OUT_DIR, { recursive: true, force: true });
  const logDir = path.join(OUT_DIR, "logs");
  const junitDir = path.join(OUT_DIR, "junit");
  mkdirSync(logDir, { recursive: true });
  mkdirSync(junitDir, { recursive: true });

  const setups = await Promise.all(Array.from({ length: slots }, (_, i) => setupSlot(i + 1)));
  const badSetup = setups.filter((s) => s.code !== 0);
  for (const s of badSetup) console.error(`✗ setting up ${slotDbName(s.slot)} failed (exit ${s.code}):\n${s.output.trimEnd()}`);
  if (badSetup.length > 0) return 1;
  const urlOf = new Map(setups.map((s) => [s.slot, s.url]));
  console.log(`${order.length} links, ${slots} at a time; databases ready in ${((performance.now() - t0) / 1000).toFixed(1)} s; logs in ${path.relative(ROOT, logDir)}/`);

  const runs = await runPool(order, slots, async (link, slot): Promise<LinkRun> => {
    const log = path.join(logDir, junitName(link.key).replace(/\.xml$/, ".log"));
    const start = performance.now();
    let code: number;
    let fd: number | undefined;
    try {
      fd = openSync(log, "w");
      const out = path.join(junitDir, junitName(link.key));
      const proc = spawnTracked(["bun", "test", "--reporter=junit", `--reporter-outfile=${out}`, ...link.args], {
        cwd: ROOT,
        env: childEnv(process.env, urlOf.get(slot)!),
        stdout: fd,
        stderr: fd,
      });
      code = await proc.exited;
    } catch (e) {
      code = -1;
      console.error(`could not start ${link.key}: ${(e as Error).message}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const seconds = (performance.now() - start) / 1000;
    console.log(`${code === 0 ? "✓" : "✗"} ${seconds.toFixed(1).padStart(6)} s  [${slot}]  ${link.key}${code === 0 ? "" : `  exit ${code}`}`);
    return { link, slot, code, seconds, log };
  });

  const junit = new Map<string, string>();
  for (const f of new Bun.Glob("*.xml").scanSync({ cwd: junitDir })) junit.set(f, readFileSync(path.join(junitDir, f), "utf8"));
  const shards = Array.from({ length: SHARD_TOTAL }, (_, i) => i + 1);
  const ranOnce = check({ links, table, tree, junit, shards, results: [], timings: {} });

  const wall = (performance.now() - t0) / 1000;
  const failed = runs.filter((r) => r.code !== 0);
  console.log(`\nslowest links:`);
  for (const r of [...runs].sort((a, b) => b.seconds - a.seconds).slice(0, 8)) console.log(`  ${r.seconds.toFixed(1).padStart(6)} s  ${r.link.key}`);
  for (const p of ranOnce.problems) console.log(`✗ ${p}`);
  if (failed.length > 0) {
    console.log(`\n${failed.length} failing link(s):`);
    for (const r of failed) console.log(`  ${r.link.key}  exit ${r.code}  ${path.relative(ROOT, r.log)}`);
  }
  console.log(`\n${runs.length - failed.length}/${runs.length} links passed, ${ranOnce.ran} files ran once, wall ${wall.toFixed(1)} s (${slots} jobs)`);
  return failed.length === 0 && ranOnce.problems.length === 0 ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  try {
    if (argv.includes("--list-stale")) return await cmdStale(false, false);
    if (argv.includes("--drop-stale")) return await cmdStale(true, argv.includes("--yes"));
    const unknown = argv.filter((a, i) => a !== "--jobs" && !a.startsWith("--jobs=") && argv[i - 1] !== "--jobs");
    if (unknown.length > 0) {
      console.error(`usage: bun scripts/test-par.ts [--jobs N] | --list-stale | --drop-stale [--yes] (unknown: ${unknown.join(" ")})`);
      return 2;
    }
    return await cmdRun(parseJobs(argv));
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  // SIGKILL: the runner is going away and nothing a child writes after this is wanted.
  process.on("exit", () => children.killAll("SIGKILL"));
  // Without a handler a signal ends the process without the `exit` event.
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(signalExitCode(sig)));
  process.exit(await main(process.argv.slice(2)));
}
