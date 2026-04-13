/**
 * Benchmark-scoped Yggdrasil manager — STUB.
 *
 * Yggdrasil is muninn's tree-sitter + pgvector code intelligence engine
 * (~/source/private/yggdrasil). It exposes an MCP HTTP server backed by
 * the shared muninn Postgres database. The benchmark wants to point a
 * per-cell Yggdrasil instance at a worktree so candidates analyse code
 * frozen at baseCommit.
 *
 * STATUS: deferred for the first Phase 1 session. The blocker is described
 * in benchmarks/known-bugs.md Bug 5 (ci_repos.name UNIQUE collision against
 * the live melosys-api index). The fix is straightforward — prefix benchmark
 * repo names like "bench-MELOSYS-7588-melosys-api" — but it requires either
 * a small Yggdrasil change to allow per-instance name prefixes, or a
 * benchmark-side wrapper that calls upsertRepo with prefixed names before
 * indexing.
 *
 * This file exists so the runner can import a real interface today and a
 * future session can fill in the bodies without changing the runner's
 * type signatures.
 */

export interface BenchmarkYggdrasilOptions {
  /** Logical name for the instance — also used as the ci_repos prefix */
  name: string;
  /** Filesystem path Yggdrasil should index (a worktree path) */
  projectPath: string;
  /** Port to bind the MCP HTTP server to */
  port: number;
}

export interface BenchmarkYggdrasilInstance {
  name: string;
  projectPath: string;
  port: number;
  mcpUrl: string;
  startedAt: number;
}

class BenchmarkYggdrasilManager {
  /**
   * Start a benchmark Yggdrasil instance pointed at a worktree. NOT YET
   * IMPLEMENTED — see Bug 5 in benchmarks/known-bugs.md for the blocker
   * (ci_repos.name UNIQUE collision against the live index).
   *
   * Phase 1 first-cell uses Serena-only stacks; Yggdrasil stacks come back
   * once the namespacing question is resolved.
   */
  async start(_opts: BenchmarkYggdrasilOptions): Promise<BenchmarkYggdrasilInstance> {
    throw new Error(
      "BenchmarkYggdrasilManager.start: deferred — see benchmarks/known-bugs.md Bug 5 " +
        "(ci_repos.name UNIQUE collision). Use a Serena-only stack for Phase 1's first cell.",
    );
  }

  async stop(_name: string): Promise<void> {
    // No-op: nothing was started.
  }

  async stopAll(): Promise<void> {
    // No-op.
  }

  async index(_opts: BenchmarkYggdrasilOptions): Promise<void> {
    throw new Error(
      "BenchmarkYggdrasilManager.index: deferred — see benchmarks/known-bugs.md Bug 5",
    );
  }

  getInstance(_name: string): BenchmarkYggdrasilInstance | undefined {
    return undefined;
  }

  listRunning(): BenchmarkYggdrasilInstance[] {
    return [];
  }
}

export const benchmarkYggdrasilManager = new BenchmarkYggdrasilManager();
