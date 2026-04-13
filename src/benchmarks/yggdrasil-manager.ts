/**
 * Benchmark-scoped Yggdrasil manager.
 *
 * Spawns Yggdrasil MCP HTTP instances backed by the shared muninn Postgres
 * database, indexing benchmark worktrees under `bench-<issueKey>-<repo>`
 * names so they can't collide with the prod index (see Bug 5 in
 * benchmarks/known-bugs.md).
 *
 * Unlike the Serena benchmark manager, there is *one* Yggdrasil MCP
 * subprocess per cell (not one per worktree) because Yggdrasil's MCP server
 * exposes every row in `ci_repos` via a single catalog regardless of which
 * `YGGDRASIL_PORT` it's bound to. Spawning per-worktree would just duplicate
 * a catalog that already lives in the shared Postgres.
 *
 * Tree-sitter state caveat: `src/indexer/parser.ts` in yggdrasil caches a
 * module-level parser instance, so concurrent `indexRepo` calls in the same
 * process race. The runner is sequential-by-default *and* we shell out to
 * `bun run src/cli.ts index` in a subprocess per repo so the module state
 * is fully isolated.
 *
 * Teardown path: `DELETE FROM ci_repos WHERE name = ANY(...)` cascades
 * through `ci_files → ci_symbols → ci_edges → ci_import_map` via
 * `ON DELETE CASCADE` — confirmed with the yggdrasil peer agent.
 */

import type { Subprocess } from "bun";
import { resolve } from "node:path";
import { homedir } from "node:os";
import postgres from "postgres";
import { getLog } from "../logging.ts";

const log = getLog("benchmarks", "yggdrasil");

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 1_000;
const INDEX_TIMEOUT_MS = 15 * 60_000;

/** Lowest port the benchmark Yggdrasil manager will allocate. */
export const BENCHMARK_YGGDRASIL_PORT_BASE = 9250;

/** Where the yggdrasil checkout lives. Override with $YGGDRASIL_REPO_PATH. */
const YGGDRASIL_REPO_PATH =
  process.env.YGGDRASIL_REPO_PATH ??
  resolve(homedir(), "source/private/yggdrasil");

/**
 * Postgres URL for the benchmark Yggdrasil. Defaults to the shared muninn
 * database so bench cells can speak to the same schema that the prod
 * yggdrasil indexer uses — the `bench-*` prefix keeps them namespaced from
 * the prod rows.
 */
const YGGDRASIL_DATABASE_URL =
  process.env.YGGDRASIL_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://muninn:muninn@127.0.0.1:5435/muninn";

export interface BenchmarkYggdrasilRepoSpec {
  /** Short label from the manifest, e.g. `"melosys-api"`. */
  repo: string;
  /** Filesystem path Yggdrasil should index. Usually a worktree path. */
  worktreePath: string;
  /** Languages to index — defaults to `["java","kotlin","typescript","tsx"]`. */
  languages?: string[];
}

export interface BenchmarkYggdrasilOptions {
  /** Mount name used in the scratch `.mcp.json` — must be short (see Bug 10). */
  name: string;
  /** Issue key (e.g. `"MELOSYS-7588"`) — used in the `bench-*-*` repo-name prefix. */
  issueKey: string;
  /** Worktrees to index for this cell. */
  repos: BenchmarkYggdrasilRepoSpec[];
  /** Port to bind the MCP server to. */
  port: number;
}

export interface BenchmarkYggdrasilInstance {
  name: string;
  issueKey: string;
  port: number;
  /** MCP endpoint URL — `http://127.0.0.1:<port>/mcp` */
  mcpUrl: string;
  /** `ci_repos.name` values created by this instance — used for teardown. */
  repoNames: string[];
  /** Per-worktree index metadata — mirrors BenchmarkStackConfig's shape. */
  indexedRepos: Array<{ repoName: string; worktreePath: string }>;
  proc: Subprocess;
  startedAt: number;
}

class BenchmarkYggdrasilManager {
  private instances = new Map<string, BenchmarkYggdrasilInstance>();

  /**
   * Start a benchmark Yggdrasil instance: index every worktree sequentially
   * under a `bench-<issue>-<repo>` name, then spawn the MCP server. Idempotent
   * — if an instance with the same name is already running, returns it.
   */
  async start(opts: BenchmarkYggdrasilOptions): Promise<BenchmarkYggdrasilInstance> {
    const existing = this.instances.get(opts.name);
    if (existing) {
      log.info("Benchmark Yggdrasil {name} already running on {port}, reusing", {
        botName: "benchmarks",
        name: opts.name,
        port: existing.port,
      });
      return existing;
    }

    await killStaleProcess(opts.port);

    // ── Step 1: index each worktree (sequential on purpose) ──
    const repoNames: string[] = [];
    const indexedRepos: Array<{ repoName: string; worktreePath: string }> = [];
    for (const spec of opts.repos) {
      const repoName = buildBenchRepoName(opts.issueKey, spec.repo);
      log.info("Indexing {path} as {name}", {
        botName: "benchmarks",
        path: spec.worktreePath,
        name: repoName,
      });
      try {
        await runYggdrasilIndexer({
          name: repoName,
          worktreePath: spec.worktreePath,
        });
      } catch (err) {
        // Best-effort cleanup of anything we already indexed so we don't
        // leave half an instance in the database.
        if (repoNames.length > 0) {
          await deleteBenchRepos(repoNames).catch(() => { /* ignore */ });
        }
        throw err;
      }
      repoNames.push(repoName);
      indexedRepos.push({ repoName, worktreePath: spec.worktreePath });
    }

    // ── Step 2: spawn the MCP server ──
    log.info("Starting benchmark Yggdrasil {name} on port {port} ({n} repos)", {
      botName: "benchmarks",
      name: opts.name,
      port: opts.port,
      n: repoNames.length,
    });

    const proc = Bun.spawn(
      ["bun", "run", "src/mcp/server.ts"],
      {
        cwd: YGGDRASIL_REPO_PATH,
        env: {
          ...process.env,
          YGGDRASIL_PORT: String(opts.port),
          DATABASE_URL: YGGDRASIL_DATABASE_URL,
        },
        stdout: "inherit",
        stderr: "inherit",
      },
    );

    const mcpUrl = `http://127.0.0.1:${opts.port}/mcp`;
    const healthUrl = `http://127.0.0.1:${opts.port}/health`;
    const ready = await waitForReady(healthUrl, proc, READY_TIMEOUT_MS);
    if (!ready) {
      try { proc.kill(); } catch { /* ignore */ }
      await deleteBenchRepos(repoNames).catch(() => { /* best effort */ });
      const exitInfo = proc.exitCode !== null ? ` (exited ${proc.exitCode})` : "";
      throw new Error(
        `Benchmark Yggdrasil ${opts.name} did not become ready on port ${opts.port}${exitInfo}`,
      );
    }

    const instance: BenchmarkYggdrasilInstance = {
      name: opts.name,
      issueKey: opts.issueKey,
      port: opts.port,
      mcpUrl,
      repoNames,
      indexedRepos,
      proc,
      startedAt: Date.now(),
    };

    proc.exited.then((code) => {
      if (this.instances.get(opts.name) === instance) {
        log.error("Benchmark Yggdrasil {name} exited unexpectedly with code {code}", {
          botName: "benchmarks",
          name: opts.name,
          code,
        });
        this.instances.delete(opts.name);
      }
    });

    this.instances.set(opts.name, instance);
    log.info("Benchmark Yggdrasil {name} ready at {url} ({n} repos)", {
      botName: "benchmarks",
      name: opts.name,
      url: mcpUrl,
      n: repoNames.length,
    });
    return instance;
  }

  async stop(name: string): Promise<void> {
    const instance = this.instances.get(name);
    if (!instance) return;
    log.info("Stopping benchmark Yggdrasil {name}", { botName: "benchmarks", name });
    try {
      instance.proc.kill();
    } catch { /* ignore */ }
    this.instances.delete(name);
    await deleteBenchRepos(instance.repoNames).catch((err) => {
      log.warn("Failed to clean up bench ci_repos rows for {name}: {err}", {
        botName: "benchmarks",
        name,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async stopAll(): Promise<void> {
    const names = Array.from(this.instances.keys());
    await Promise.allSettled(names.map((n) => this.stop(n)));
  }

  /**
   * Nuclear cleanup — kill any running instances, then delete every
   * `bench-*` row in `ci_repos`. Safe to call at startup to sweep up
   * orphans from crashed runs.
   */
  async teardownAll(): Promise<void> {
    await this.stopAll();
    await deleteAllBenchRepos().catch((err) => {
      log.warn("teardownAll DELETE failed: {err}", {
        botName: "benchmarks",
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  getInstance(name: string): BenchmarkYggdrasilInstance | undefined {
    return this.instances.get(name);
  }

  listRunning(): BenchmarkYggdrasilInstance[] {
    return Array.from(this.instances.values());
  }
}

export const benchmarkYggdrasilManager = new BenchmarkYggdrasilManager();

/**
 * Allocate a free port for a benchmark Yggdrasil instance, starting from
 * `BENCHMARK_YGGDRASIL_PORT_BASE`. Mirrors `allocateBenchmarkPort` in
 * serena-benchmark.ts — skips ports held by currently-running benchmark
 * instances but does NOT detect foreign holders (`killStaleProcess` handles
 * that on start).
 */
export function allocateBenchmarkYggdrasilPort(usedPorts: Iterable<number>): number {
  const used = new Set(usedPorts);
  for (const inst of benchmarkYggdrasilManager.listRunning()) used.add(inst.port);
  let port = BENCHMARK_YGGDRASIL_PORT_BASE;
  while (used.has(port)) port++;
  return port;
}

export function buildBenchRepoName(issueKey: string, repo: string): string {
  return `bench-${issueKey}-${repo}`;
}

async function runYggdrasilIndexer(args: {
  name: string;
  worktreePath: string;
}): Promise<void> {
  const proc = Bun.spawn(
    ["bun", "run", "src/cli.ts", "index", "--full", args.worktreePath, args.name],
    {
      cwd: YGGDRASIL_REPO_PATH,
      env: {
        ...process.env,
        DATABASE_URL: YGGDRASIL_DATABASE_URL,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const timeout = setTimeout(() => {
    try { proc.kill(); } catch { /* ignore */ }
  }, INDEX_TIMEOUT_MS);
  const code = await proc.exited;
  clearTimeout(timeout);
  if (code !== 0) {
    throw new Error(`Yggdrasil indexer exited with code ${code} for ${args.name}`);
  }
}

async function waitForReady(
  url: string,
  proc: Subprocess,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // connection refused — not ready yet
    }
    await Bun.sleep(READY_POLL_MS);
  }
  return false;
}

async function killStaleProcess(port: number): Promise<void> {
  try {
    const proc = Bun.spawn(["lsof", "-ti", `:${port}`], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const pids = output.trim().split("\n").filter(Boolean);
    for (const pid of pids) {
      const n = parseInt(pid, 10);
      if (!Number.isNaN(n)) {
        log.warn("Killing stale process {pid} on port {port}", {
          botName: "benchmarks",
          pid: n,
          port,
        });
        try { process.kill(n, "SIGTERM"); } catch { /* ignore */ }
      }
    }
    if (pids.length > 0) await Bun.sleep(1000);
  } catch {
    // lsof missing or no holder — fine
  }
}

async function deleteBenchRepos(names: string[]): Promise<void> {
  if (names.length === 0) return;
  const sql = postgres(YGGDRASIL_DATABASE_URL, {
    max: 2,
    idle_timeout: 5,
    connect_timeout: 10,
  });
  try {
    await sql`DELETE FROM ci_repos WHERE name = ANY(${names}::text[])`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function deleteAllBenchRepos(): Promise<void> {
  const sql = postgres(YGGDRASIL_DATABASE_URL, {
    max: 2,
    idle_timeout: 5,
    connect_timeout: 10,
  });
  try {
    await sql`DELETE FROM ci_repos WHERE name LIKE 'bench-%'`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
