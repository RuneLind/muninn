/**
 * In-memory supervisor for long-running benchmark cell subprocesses spawned
 * from the dashboard. Each job is keyed by its pre-allocated analysis trace
 * ID — the same UUID the runner's Tracer uses so the live view can
 * subscribe to spans under it from the moment the POST returns.
 *
 * This is deliberately not a generic job system. It tracks exactly what the
 * live view needs:
 *   - the child PID (so we can kill orphans)
 *   - the current status (pending, running, done, error)
 *   - the stdout/stderr tail (for the live view's log panel)
 *   - the eventual exit code
 *
 * Jobs are held for 10 min after completion so a page refresh right after
 * "done" still sees the final state. After that they're evicted.
 */

import { getLog } from "../logging.ts";

const log = getLog("benchmarks", "live-job");

export interface LiveJobLogLine {
  at: number;
  stream: "stdout" | "stderr";
  line: string;
}

export interface LiveJob {
  traceId: string;
  issueKey: string;
  treatmentPath: string;
  treatmentLabel: string;
  status: "pending" | "running" | "done" | "error";
  error: string | null;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  pid: number | null;
  /** Last ~200 log lines. Older lines are dropped. */
  logTail: LiveJobLogLine[];
}

const MAX_LOG_LINES = 200;
const JOB_RETENTION_MS = 10 * 60 * 1000;

class LiveJobSupervisor {
  private jobs = new Map<string, LiveJob>();
  private procs = new Map<string, import("bun").Subprocess>();

  /** Register a new job before the subprocess is spawned. */
  register(
    traceId: string,
    issueKey: string,
    treatmentPath: string,
    treatmentLabel: string,
  ): LiveJob {
    const job: LiveJob = {
      traceId,
      issueKey,
      treatmentPath,
      treatmentLabel,
      status: "pending",
      error: null,
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      pid: null,
      logTail: [],
    };
    this.jobs.set(traceId, job);
    return job;
  }

  get(traceId: string): LiveJob | null {
    return this.jobs.get(traceId) ?? null;
  }

  list(): LiveJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Mark a job as running and record the child PID. */
  markRunning(traceId: string, proc: import("bun").Subprocess): void {
    const job = this.jobs.get(traceId);
    if (!job) return;
    job.status = "running";
    job.pid = proc.pid;
    this.procs.set(traceId, proc);
  }

  appendLog(traceId: string, stream: "stdout" | "stderr", line: string): void {
    const job = this.jobs.get(traceId);
    if (!job) return;
    job.logTail.push({ at: Date.now(), stream, line });
    if (job.logTail.length > MAX_LOG_LINES) {
      job.logTail.splice(0, job.logTail.length - MAX_LOG_LINES);
    }
  }

  markDone(traceId: string, exitCode: number): void {
    const job = this.jobs.get(traceId);
    if (!job) return;
    job.status = exitCode === 0 ? "done" : "error";
    job.finishedAt = Date.now();
    job.exitCode = exitCode;
    if (exitCode !== 0) {
      job.error = `Subprocess exited with code ${exitCode}`;
    }
    this.procs.delete(traceId);
    this.scheduleEviction(traceId);
  }

  markError(traceId: string, error: string): void {
    const job = this.jobs.get(traceId);
    if (!job) return;
    job.status = "error";
    job.finishedAt = Date.now();
    job.error = error;
    this.procs.delete(traceId);
    this.scheduleEviction(traceId);
  }

  /**
   * Kill the subprocess for a given trace. Best-effort — if the PID is gone
   * by the time we try, we still mark the job as errored so the UI updates.
   */
  kill(traceId: string): boolean {
    const proc = this.procs.get(traceId);
    if (!proc) return false;
    try {
      proc.kill();
      log.warn("Killed benchmark live job {traceId} (pid={pid})", {
        botName: "benchmarks",
        traceId,
        pid: proc.pid,
      });
      this.markError(traceId, "Killed by user");
      return true;
    } catch (err) {
      log.error("Failed to kill live job {traceId}: {error}", {
        botName: "benchmarks",
        traceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private scheduleEviction(traceId: string): void {
    setTimeout(() => {
      this.jobs.delete(traceId);
    }, JOB_RETENTION_MS);
  }
}

export const liveJobSupervisor = new LiveJobSupervisor();

/**
 * Stream subprocess stdout/stderr line-by-line into the job's log tail.
 * Does not await — returns immediately; the caller is responsible for
 * awaiting proc.exited separately.
 */
export async function pipeSubprocessLogs(
  traceId: string,
  stream: ReadableStream<Uint8Array> | null,
  label: "stdout" | "stderr",
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) {
          liveJobSupervisor.appendLog(traceId, label, line);
        }
      }
    }
    if (buffer.length > 0) {
      liveJobSupervisor.appendLog(traceId, label, buffer);
    }
  } catch (err) {
    log.warn("pipe error on {label}: {error}", {
      botName: "benchmarks",
      label,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    reader.releaseLock();
  }
}
