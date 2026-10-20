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
 * exactly the names the child needs. Note a bare `{}` leaves the child with no
 * `PATH`: for the Stamp route that means every spawn fails to find `bun` and
 * lands in the 502 bucket with an empty stderr, which is why its allowlist
 * carries `PATH`.
 *
 * **Both streams are BOUNDED** at {@link RUN_PROC_MAX_OUTPUT_BYTES}. The drain
 * is `new Response(stream).text()`, which buffers the whole stream in this
 * process: a child that prints without end is an unbounded allocation inside the
 * dashboard's event loop, and the timeout does not help — a fast writer reaches
 * gigabytes well inside 15 s. The cap is the same 8 MB the claude-usage proxy
 * reads under (`utils/bounded-fetch.ts`), for the same reason: it is the size
 * above which the answer is a bug rather than a payload.
 */

import { getLog } from "../logging.ts";
import { RUN_PROC_KILL_GRACE_MS, RUN_PROC_POST_KILL_WAIT_MS as POST_KILL_WAIT_MS } from "./run-proc-bounds.ts";

const log = getLog("utils", "run-proc");

export interface ProcResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunProcOptions {
  /** The child's WHOLE environment. Omit to inherit this process's. */
  env?: Record<string, string | undefined>;
  /** Per-stream output cap. Defaults to {@link RUN_PROC_MAX_OUTPUT_BYTES}. */
  maxOutputBytes?: number;
  /** The child's working directory. Omit to inherit this process's. */
  cwd?: string;
  /** Start the child as its own process-group leader (`setsid`), so the
   *  timeout's signals reach every process it started, not only itself. */
  processGroup?: boolean;
  /** How long a timed-out child gets between SIGTERM and SIGKILL. Defaults to
   *  {@link RUN_PROC_KILL_GRACE_MS}. */
  killGraceMs?: number;
}

export { RUN_PROC_KILL_GRACE_MS };

/** Bytes kept per stream. See the header for why there is a cap at all. */
export const RUN_PROC_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** What a truncated stream ends with, so a reader of the text can tell a cut
 *  stream from a child that simply stopped talking. */
export const RUN_PROC_TRUNCATED_MARKER = "\n[output truncated]";

/**
 * Read a stream as text, stopping after `maxBytes`.
 *
 * Decoded CHUNK BY CHUNK through one streaming `TextDecoder`, so a multi-byte
 * character split across two chunks still decodes: `decode(chunk, {stream:true})`
 * holds the partial sequence until the rest arrives. The cap is counted in
 * BYTES (what the child actually produced) and applied before decoding, so the
 * bound holds whatever the encoding is.
 *
 * The stream is CANCELLED once the cap is hit rather than drained to the end:
 * draining it would spend the whole runtime of an endlessly-printing child for
 * output that is thrown away, and cancelling closes the pipe, which is what
 * makes such a child stop (or die on EPIPE) instead of running to the timeout.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (seen + value.byteLength > maxBytes) {
        out += decoder.decode(value.subarray(0, Math.max(0, maxBytes - seen)));
        out += decoder.decode();
        await reader.cancel().catch(() => {});
        return out + RUN_PROC_TRUNCATED_MARKER;
      }
      seen += value.byteLength;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return out + decoder.decode();
}

/**
 * The timeout rejection, as a TYPE rather than as a message.
 *
 * The Stamp route has to answer 409 `stamp-timeout` for a deadline and 502 for
 * anything else this throws — `Bun.spawn` itself throws SYNCHRONOUSLY for an
 * argv it cannot build (a NUL in an argument fails in ~10 ms) and for a binary
 * it cannot execute. Catching everything as a timeout reported those as "the CLI
 * did not return", which sends an operator looking for a wedged child that never
 * existed. Matching on the message string would work until someone edits the
 * string.
 */
export class ProcTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "ProcTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Process groups started with `processGroup` whose leader has not exited yet.
 *
 * A group leader is a session leader (`detached`), so it no longer shares the
 * parent's process group: Ctrl-C on `bun run dev` (SIGINT to the terminal's
 * foreground group) does not reach it, and the timeout that would have killed it
 * dies with the parent — a 3 h whisper then runs on orphaned. So the parent's
 * exit kills every live group: muninn's `shutdown()` drains this set first, and
 * the hooks below cover every other way out.
 */
const liveGroups = new Set<number>();

/** SIGKILL every live process group, and forget them. Returns how many were
 *  signalled. Synchronous, so an `exit` hook can run it. */
export function killLiveProcessGroups(): number {
  let n = 0;
  for (const pgid of liveGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
      n++;
    } catch {
      /* already gone */
    }
  }
  liveGroups.clear();
  return n;
}

let groupHooksInstalled = false;

/**
 * Kill the live groups on SIGINT, SIGTERM and `exit`, and keep how the parent
 * itself exits: a process with its own listener for the signal (muninn's
 * `shutdown()`, `on` or `once`, before or after the first group) keeps its
 * exit, and one without gets the default death re-raised, which a listener
 * would otherwise have cancelled. The hook goes first in the listener list,
 * because a `once` listener ahead of it is removed before the hook runs.
 * A process that inherited the signal as ignored is not detectable from here:
 * the re-raise kills it.
 */
function installGroupHooks(): void {
  if (groupHooksInstalled) return;
  groupHooksInstalled = true;
  process.on("exit", killLiveProcessGroups);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const onSignal = () => {
      killLiveProcessGroups();
      if (process.listenerCount(sig) === 1) {
        process.removeListener(sig, onSignal);
        process.kill(process.pid, sig);
      }
    };
    process.prependListener(sig, onSignal);
  }
}

/**
 * Spawn a process, draining stdout AND stderr concurrently with exit (awaiting
 * `exited` first can deadlock if the pipe buffer fills — same fix as stt.ts),
 * and kill it if it runs past `timeoutMs` (mirrors executor.ts's timeout).
 *
 * The timeout sends SIGTERM, then SIGKILL after `killGraceMs` if the child is
 * still there (a child that traps SIGTERM would otherwise outlive its
 * deadline), and rejects only once the child has EXITED, or {@link
 * POST_KILL_WAIT_MS} after the SIGKILL. A caller that holds a lock for the
 * child's lifetime (the Agent lens's one-child-per-page) can release it on the
 * rejection.
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
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.processGroup ? { detached: true } : {}),
  });

  // The whole group when the child leads one, else the child alone. A group
  // whose members have all gone throws ESRCH, which is the goal reached.
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (opts.processGroup) process.kill(-proc.pid, sig);
      else proc.kill(sig);
    } catch {
      /* already gone */
    }
  };
  let exited = false;
  if (opts.processGroup) {
    installGroupHooks();
    liveGroups.add(proc.pid);
  }
  void proc.exited.then(() => {
    exited = true;
    liveGroups.delete(proc.pid);
  });

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      log.error("{label} timed out after {timeoutMs}ms — killing PID {pid}", {
        label,
        timeoutMs,
        pid: proc.pid,
      });
      signal("SIGTERM");
      const grace = opts.killGraceMs ?? RUN_PROC_KILL_GRACE_MS;
      // Fires only while the child is still there: an exit inside the grace
      // settles below first, and that path clears this timer.
      const killTimer = setTimeout(() => {
        log.error("{label} ignored SIGTERM for {grace}ms — SIGKILL to PID {pid}", { label, grace, pid: proc.pid });
        signal("SIGKILL");
      }, grace);
      const fail = () => {
        clearTimeout(killTimer);
        reject(new ProcTimeoutError(label, timeoutMs));
      };
      void Promise.race([proc.exited, Bun.sleep(grace + POST_KILL_WAIT_MS)]).then(() => {
        // A group leader that died on SIGTERM may leave members that trap
        // it: this is the only SIGKILL they get, since the grace timer is
        // cleared below.
        if (opts.processGroup && exited) signal("SIGKILL");
        fail();
      });
    }, timeoutMs);
  });

  const workPromise = (async (): Promise<ProcResult> => {
    const maxBytes = opts.maxOutputBytes ?? RUN_PROC_MAX_OUTPUT_BYTES;
    const [stdout, stderr, exitCode] = await Promise.all([
      readCapped(proc.stdout as ReadableStream<Uint8Array> | null, maxBytes),
      readCapped(proc.stderr as ReadableStream<Uint8Array> | null, maxBytes),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  })();

  try {
    const result = await Promise.race([workPromise, timeoutPromise]);
    // The SIGTERM's own exit can drain first: it is still the timeout.
    if (timedOut) await timeoutPromise;
    return result;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}
