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
 * Each `bun run src/cli.ts index` runs in its own subprocess, so yggdrasil's
 * tree-sitter parser singleton (`src/indexer/parser.ts`) is fresh per call —
 * we can index repos in parallel without races.
 *
 * Teardown path: `DELETE FROM ci_repos WHERE name = ANY(...)` cascades
 * through `ci_files → ci_symbols → ci_edges → ci_import_map` via
 * `ON DELETE CASCADE`.
 */

import type { Subprocess } from "bun";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { getLog } from "../logging.ts";
import { getDb } from "../db/client.ts";
import { killStaleProcess, waitForReady, okResponse } from "./process-utils.ts";

const log = getLog("benchmarks", "yggdrasil");

const READY_TIMEOUT_MS = 60_000;
const INDEX_TIMEOUT_MS = 15 * 60_000;

/** Lowest port the benchmark Yggdrasil manager will allocate. */
export const BENCHMARK_YGGDRASIL_PORT_BASE = 9250;

/** Where the yggdrasil checkout lives. Override with $YGGDRASIL_REPO_PATH. */
const YGGDRASIL_REPO_PATH =
  process.env.YGGDRASIL_REPO_PATH ??
  resolve(homedir(), "source/private/yggdrasil");

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

export interface BenchmarkYggdrasilStackEntry {
  name: string;
  port: number;
  projectPath: string;
}

export interface BenchmarkYggdrasilInstance {
  name: string;
  issueKey: string;
  port: number;
  /** MCP endpoint URL — `http://127.0.0.1:<port>/mcp` */
  mcpUrl: string;
  /** Per-worktree index metadata used for `BenchmarkStackConfig` and teardown. */
  indexedRepos: ReadonlyArray<{ repoName: string; worktreePath: string }>;
  proc: Subprocess;
  startedAt: number;
}

/** Shape the runner persists in `BenchmarkStackConfig.yggdrasilInstances`. */
export function toStackEntries(
  instance: BenchmarkYggdrasilInstance,
): BenchmarkYggdrasilStackEntry[] {
  return instance.indexedRepos.map((r) => ({
    name: r.repoName,
    port: instance.port,
    projectPath: r.worktreePath,
  }));
}

class BenchmarkYggdrasilManager {
  private instances = new Map<string, BenchmarkYggdrasilInstance>();

  /**
   * Start a benchmark Yggdrasil instance: index every worktree under a
   * `bench-<issue>-<repo>` name in parallel, then spawn the MCP server.
   * Idempotent — if an instance with the same name is already running,
   * returns it.
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

    // Each indexer call shells out to a fresh `bun run src/cli.ts` subprocess,
    // so the tree-sitter parser singleton is per-child — parallel is safe.
    const indexedRepos = await indexAllRepos(opts.issueKey, opts.repos);

    log.info("Starting benchmark Yggdrasil {name} on port {port} ({n} repos)", {
      botName: "benchmarks",
      name: opts.name,
      port: opts.port,
      n: indexedRepos.length,
    });

    const proc = Bun.spawn(
      ["bun", "run", "src/mcp/server.ts"],
      {
        cwd: YGGDRASIL_REPO_PATH,
        env: {
          ...process.env,
          YGGDRASIL_PORT: String(opts.port),
        },
        stdout: "inherit",
        stderr: "inherit",
      },
    );

    const mcpUrl = `http://127.0.0.1:${opts.port}/mcp`;
    const healthUrl = `http://127.0.0.1:${opts.port}/health`;
    const ready = await waitForReady(healthUrl, proc, READY_TIMEOUT_MS, {
      predicate: okResponse,
    });
    if (!ready) {
      try { proc.kill(); } catch { /* ignore */ }
      await deleteBenchRepos(indexedRepos.map((r) => r.repoName)).catch(() => { /* best effort */ });
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
      n: indexedRepos.length,
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
    await deleteBenchRepos(instance.indexedRepos.map((r) => r.repoName)).catch((err) => {
      log.warn("Failed to clean up bench ci_repos rows for {name}: {err}", {
        botName: "benchmarks",
        name,
        err: err instanceof Error ? err.message : String(err),
      });
    });
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
 * instances; foreign holders are handled by `killStaleProcess` on start.
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

async function indexAllRepos(
  issueKey: string,
  specs: BenchmarkYggdrasilRepoSpec[],
): Promise<Array<{ repoName: string; worktreePath: string }>> {
  const planned = specs.map((spec) => ({
    repoName: buildBenchRepoName(issueKey, spec.repo),
    worktreePath: spec.worktreePath,
  }));

  const results = await Promise.allSettled(
    planned.map(async (entry) => {
      log.info("Indexing {path} as {name}", {
        botName: "benchmarks",
        path: entry.worktreePath,
        name: entry.repoName,
      });
      await runYggdrasilIndexer(entry);
      return entry;
    }),
  );

  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    // Tear down anything that did get indexed so we don't leak rows.
    const succeeded = results
      .filter((r): r is PromiseFulfilledResult<{ repoName: string; worktreePath: string }> =>
        r.status === "fulfilled")
      .map((r) => r.value.repoName);
    if (succeeded.length > 0) {
      await deleteBenchRepos(succeeded).catch(() => { /* ignore */ });
    }
    const reasons = failures
      .map((r) => (r as PromiseRejectedResult).reason)
      .map((e) => (e instanceof Error ? e.message : String(e)))
      .join("; ");
    throw new Error(`Yggdrasil indexer failed for ${failures.length} repo(s): ${reasons}`);
  }

  return results.map(
    (r) => (r as PromiseFulfilledResult<{ repoName: string; worktreePath: string }>).value,
  );
}

async function runYggdrasilIndexer(args: {
  repoName: string;
  worktreePath: string;
}): Promise<void> {
  const proc = Bun.spawn(
    ["bun", "run", "src/cli.ts", "index", "--full", args.worktreePath, args.repoName],
    {
      cwd: YGGDRASIL_REPO_PATH,
      env: { ...process.env },
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
    throw new Error(`Yggdrasil indexer exited with code ${code} for ${args.repoName}`);
  }
}

async function deleteBenchRepos(names: string[]): Promise<void> {
  if (names.length === 0) return;
  const sql = getDb();
  await sql`DELETE FROM ci_repos WHERE name = ANY(${names}::text[])`;
}
