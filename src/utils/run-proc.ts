/**
 * The ONE bounded spawn helper — concurrent stdout/stderr/exit drain plus a hard
 * timeout.
 *
 * It lived in `src/video/media.ts` until a second caller appeared: the wiki
 * Stamp route (`dashboard/routes/wiki-stamp.ts`) shells out to claude-usage's
 * `wiki-stamp` CLI, and a route in the wiki group must not import the
 * capture-vertical graph (yt-dlp, whisper, ffmpeg helpers and their constants)
 * to get a spawn. The behaviour is unchanged for the media callers; the only
 * addition is {@link RunProcOptions.env}.
 *
 * **`env` REPLACES the child environment** — that is `Bun.spawn`'s own contract,
 * not this helper's choice — so a caller that wants one extra variable passes
 * `{ ...process.env, X }`. A bare `{ X }` leaves the child with no `PATH`, which
 * for the Stamp route means every spawn fails to find `bun` and lands in the 502
 * bucket with an empty stderr.
 */

import { getLog } from "../logging.ts";

const log = getLog("utils", "run-proc");

export interface ProcResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunProcOptions {
  /** The child's WHOLE environment. Omit to inherit this process's. */
  env?: Record<string, string | undefined>;
}

/**
 * Spawn a process, draining stdout AND stderr concurrently with exit (awaiting
 * `exited` first can deadlock if the pipe buffer fills — same fix as stt.ts),
 * and kill it if it runs past `timeoutMs` (mirrors executor.ts's timeout).
 */
export async function runProc(
  cmd: string[],
  timeoutMs: number,
  label: string,
  opts: RunProcOptions = {},
): Promise<ProcResult> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    ...(opts.env ? { env: opts.env } : {}),
  });

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      log.error("{label} timed out after {timeoutMs}ms — killing PID {pid}", {
        label,
        timeoutMs,
        pid: proc.pid,
      });
      proc.kill();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const workPromise = (async (): Promise<ProcResult> => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  })();

  try {
    return await Promise.race([workPromise, timeoutPromise]);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}
