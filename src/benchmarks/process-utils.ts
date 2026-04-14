/**
 * Process / readiness helpers shared by the benchmark MCP managers.
 *
 * Both `serena-benchmark.ts` and `yggdrasil-manager.ts` spawn long-running
 * MCP HTTP subprocesses on dedicated ports and need the same lifecycle
 * primitives: kill anything holding the port before binding, then poll
 * until the subprocess is actually serving.
 */

import type { Subprocess } from "bun";
import { getLog } from "../logging.ts";

const log = getLog("benchmarks", "process");

const DEFAULT_READY_POLL_MS = 1_000;

/** Predicate that decides whether a probe response counts as "ready". */
export type ReadyPredicate = (res: Response) => boolean;

/** Default predicate: any response (even 4xx/5xx) means the server is listening. */
export const anyResponse: ReadyPredicate = () => true;

/** Strict predicate: only 2xx counts. */
export const okResponse: ReadyPredicate = (res) => res.ok;

/**
 * Poll a URL until the subprocess is ready or the timeout elapses. Returns
 * `false` if the subprocess exits before becoming ready or the deadline hits.
 */
export async function waitForReady(
  url: string,
  proc: Subprocess,
  timeoutMs: number,
  options: { pollMs?: number; predicate?: ReadyPredicate } = {},
): Promise<boolean> {
  const pollMs = options.pollMs ?? DEFAULT_READY_POLL_MS;
  const predicate = options.predicate ?? anyResponse;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (predicate(res)) return true;
    } catch {
      // connection refused — not ready yet
    }
    await Bun.sleep(pollMs);
  }
  return false;
}

/**
 * Kill any process currently holding the given TCP port. Best-effort —
 * silently no-ops if `lsof` is missing or nothing holds the port.
 */
export async function killStaleProcess(port: number): Promise<void> {
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
