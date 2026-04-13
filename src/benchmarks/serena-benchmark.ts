/**
 * Benchmark-scoped Serena manager.
 *
 * Spawns Serena MCP HTTP instances pointing at benchmark worktrees, separate
 * from the dashboard-managed prod instances tracked in src/serena/manager.ts.
 *
 * Why a separate manager rather than extending SerenaManager:
 *   - Prod instances are loaded from bot config.json by name. Benchmark
 *     instances are constructed dynamically from a worktree path.
 *   - Prod manager refreshes the tool-proxy catalog on every start/stop;
 *     the benchmark runner doesn't go through the proxy at all (it points
 *     a per-cell .mcp.json directly at the benchmark instance's HTTP url).
 *   - Mixing the two would risk a benchmark teardown clobbering a prod
 *     instance, or vice versa.
 *
 * Port range: 9200+ to avoid colliding with the prod 9121-9130-ish range
 * (see bots/melosys/config.json).
 */

import type { Subprocess } from "bun";
import { getLog } from "../logging.ts";

const log = getLog("benchmarks", "serena");

const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 1_000;

/** Lowest port the benchmark manager will allocate. */
export const BENCHMARK_SERENA_PORT_BASE = 9200;

export interface BenchmarkSerenaOptions {
  /** Logical name (used in logs and the .mcp.json overlay) */
  name: string;
  /** Filesystem path Serena should index. Usually a worktree path. */
  projectPath: string;
  /** Port to bind to. The manager kills any stale process holding it first. */
  port: number;
}

export interface BenchmarkSerenaInstance {
  name: string;
  projectPath: string;
  port: number;
  /** MCP endpoint URL — http://127.0.0.1:<port>/mcp */
  mcpUrl: string;
  /** Bun subprocess (kept so we can kill it on stop) */
  proc: Subprocess;
  startedAt: number;
}

class BenchmarkSerenaManager {
  private instances = new Map<string, BenchmarkSerenaInstance>();

  /**
   * Start a benchmark Serena instance. Idempotent — if an instance with the
   * same name is already running, returns it instead of double-spawning.
   */
  async start(opts: BenchmarkSerenaOptions): Promise<BenchmarkSerenaInstance> {
    const existing = this.instances.get(opts.name);
    if (existing) {
      log.info("Benchmark Serena {name} already running on {port}, reusing", {
        botName: "benchmarks",
        name: opts.name,
        port: existing.port,
      });
      return existing;
    }

    await killStaleProcess(opts.port);

    log.info("Starting benchmark Serena {name} on port {port} for {path}", {
      botName: "benchmarks",
      name: opts.name,
      port: opts.port,
      path: opts.projectPath,
    });

    const proc = Bun.spawn(
      [
        "uvx", "--from", "git+https://github.com/oraios/serena",
        "serena", "start-mcp-server",
        "--transport", "streamable-http",
        "--port", String(opts.port),
        "--host", "127.0.0.1",
        "--context", "claude-code",
        "--project", opts.projectPath,
        "--open-web-dashboard", "False",
      ],
      {
        stdout: "inherit",
        stderr: "inherit",
      },
    );

    const mcpUrl = `http://127.0.0.1:${opts.port}/mcp`;
    const ready = await waitForReady(mcpUrl, proc, READY_TIMEOUT_MS);
    if (!ready) {
      try { proc.kill(); } catch { /* ignore */ }
      const exitInfo = proc.exitCode !== null ? ` (exited ${proc.exitCode})` : "";
      throw new Error(`Benchmark Serena ${opts.name} did not become ready on port ${opts.port}${exitInfo}`);
    }

    const instance: BenchmarkSerenaInstance = {
      name: opts.name,
      projectPath: opts.projectPath,
      port: opts.port,
      mcpUrl,
      proc,
      startedAt: Date.now(),
    };

    // Watch for unexpected exit while the runner thinks it's still up
    proc.exited.then((code) => {
      if (this.instances.get(opts.name) === instance) {
        log.error("Benchmark Serena {name} exited unexpectedly with code {code}", {
          botName: "benchmarks",
          name: opts.name,
          code,
        });
        this.instances.delete(opts.name);
      }
    });

    this.instances.set(opts.name, instance);
    log.info("Benchmark Serena {name} ready at {url}", {
      botName: "benchmarks",
      name: opts.name,
      url: mcpUrl,
    });
    return instance;
  }

  async stop(name: string): Promise<void> {
    const instance = this.instances.get(name);
    if (!instance) return;
    log.info("Stopping benchmark Serena {name}", { botName: "benchmarks", name });
    try {
      instance.proc.kill();
    } catch { /* ignore */ }
    this.instances.delete(name);
  }

  async stopAll(): Promise<void> {
    const names = Array.from(this.instances.keys());
    await Promise.allSettled(names.map((n) => this.stop(n)));
  }

  getInstance(name: string): BenchmarkSerenaInstance | undefined {
    return this.instances.get(name);
  }

  listRunning(): BenchmarkSerenaInstance[] {
    return Array.from(this.instances.values());
  }
}

export const benchmarkSerenaManager = new BenchmarkSerenaManager();

/**
 * Allocate a free port for a benchmark Serena instance, starting from
 * BENCHMARK_SERENA_PORT_BASE. Skips any port currently held by a running
 * benchmark instance — does NOT detect ports held by other processes
 * (prod Serena, etc.); the manager kills stale holders on start anyway.
 */
export function allocateBenchmarkPort(usedPorts: Iterable<number>): number {
  const used = new Set(usedPorts);
  for (const inst of benchmarkSerenaManager.listRunning()) used.add(inst.port);
  let port = BENCHMARK_SERENA_PORT_BASE;
  while (used.has(port)) port++;
  return port;
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
      // Any response (even 4xx/5xx) means the server is listening.
      // Serena returns 405 to a GET; that's fine.
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      // connection refused — not ready yet
    }
    await Bun.sleep(READY_POLL_MS);
  }
  return false;
}

async function killStaleProcess(port: number): Promise<void> {
  try {
    const proc = Bun.spawn(["lsof", "-ti", `:${port}`], { stdout: "pipe", stderr: "ignore" });
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
