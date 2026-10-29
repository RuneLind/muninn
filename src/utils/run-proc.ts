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

import { readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dlopen, FFIType, ptr } from "bun:ffi";
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
  /** Leave the timeout's own ERROR line to the caller, which reports the
   *  {@link ProcTimeoutError} itself (a probe whose failure is one warn). */
  quietTimeout?: boolean;
  /** With `processGroup`: when the leader dies on the timeout's SIGTERM, the
   *  rest of the group keeps the grace too (SIGKILL only once `killGraceMs`
   *  has run out with members left), so a member cleaning up its lock files is
   *  not cut short. Without it the group gets SIGKILL as soon as the leader is
   *  gone. */
  groupGrace?: boolean;
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
  cancels: (() => void)[] = [],
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  cancels.push(() => void reader.cancel().catch(() => {}));
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
 * Process groups started with `processGroup` whose leader has not exited yet,
 * or whose timeout kill has not finished.
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

/** How long a group the parent's exit or signal ends gets between SIGTERM and SIGKILL. */
export const RUN_PROC_EXIT_TERM_GRACE_MS = 1_000;

/** Whether any process of group `pgid` can still be signalled. macOS answers
 *  EPERM for a group whose only member is an unreaped zombie: gone too. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroups(pgids: readonly number[], sig: NodeJS.Signals): void {
  for (const g of pgids) {
    try {
      process.kill(-g, sig);
    } catch {
      /* already gone */
    }
  }
}

/** The `exit` hook: SIGTERM every live group, so git and the like remove
 *  their lock files, wait for them synchronously (an exit handler cannot
 *  await), then SIGKILL what is left. On Linux a dead leader stays a zombie
 *  until the event loop reaps it, so this wait runs its full grace there. */
function endLiveGroupsSync(): void {
  const groups = [...liveGroups];
  liveGroups.clear();
  if (!groups.length) return;
  signalGroups(groups, "SIGTERM");
  const tick = new Int32Array(new SharedArrayBuffer(4));
  const end = performance.now() + RUN_PROC_EXIT_TERM_GRACE_MS;
  while (performance.now() < end && groups.some(groupAlive)) Atomics.wait(tick, 0, 0, 20);
  signalGroups(groups, "SIGKILL");
}

/** The signal hook's version when the process has no listener of its own:
 *  the same SIGTERM, grace and SIGKILL, with the event loop running, so the
 *  dead leaders are reaped and the wait ends as soon as the groups are gone. */
async function endLiveGroups(): Promise<void> {
  const groups = [...liveGroups];
  liveGroups.clear();
  if (!groups.length) return;
  signalGroups(groups, "SIGTERM");
  const end = performance.now() + RUN_PROC_EXIT_TERM_GRACE_MS;
  while (performance.now() < end && groups.some(groupAlive)) await Bun.sleep(20);
  signalGroups(groups, "SIGKILL");
}

const SIGNAL_NUMBERS = { SIGHUP: osConstants.signals.SIGHUP, SIGINT: osConstants.signals.SIGINT, SIGTERM: osConstants.signals.SIGTERM };
type HookedSignal = keyof typeof SIGNAL_NUMBERS;

/**
 * Whether this process inherited `sig` as ignored (`nohup` for SIGHUP, a
 * background job of a non-interactive shell for SIGINT). A JS listener would
 * replace the ignore, and the re-raise below would then kill a process its
 * caller had shielded. Linux reads `SigIgn` in `/proc/self/status`; macOS asks
 * `sigaction(2)` through FFI (the handler is the struct's first field on both
 * platforms; `SIG_IGN` is 1). Anything else, or a failed read, answers false:
 * the hook is installed, as before this check existed.
 */
export function inheritedIgnore(sig: HookedSignal): boolean {
  const n = SIGNAL_NUMBERS[sig];
  try {
    if (process.platform === "linux") {
      const m = /^SigIgn:\s*([0-9a-f]+)$/m.exec(readFileSync("/proc/self/status", "utf8"));
      return !!m && ((BigInt(`0x${m[1]}`) >> BigInt(n - 1)) & 1n) === 1n;
    }
    if (process.platform === "darwin") {
      const lib = dlopen("/usr/lib/libSystem.B.dylib", {
        sigaction: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      });
      try {
        const old = new BigUint64Array(8);
        return lib.symbols.sigaction(n, null, ptr(old)) === 0 && old[0] === 1n;
      } finally {
        lib.close();
      }
    }
  } catch {
    /* unreadable: treat as not ignored */
  }
  return false;
}

let groupHooksInstalled = false;

/**
 * End the live groups on SIGINT, SIGTERM, SIGHUP and `exit`, and keep how the
 * parent itself exits: a process with its own listener for the signal
 * (muninn's `shutdown()`, `on` or `once`, before or after the first group)
 * keeps its exit and gets the groups SIGKILLed at once, as its shutdown drains
 * them too; one without gets SIGTERM, up to {@link RUN_PROC_EXIT_TERM_GRACE_MS}
 * for the groups to go, SIGKILL, and then the default death re-raised, which a
 * listener would otherwise have cancelled (a second signal in that grace
 * SIGKILLs and re-raises at once). The hook goes first in the listener list,
 * because a `once` listener ahead of it is removed before the hook runs. A
 * signal the process inherited as ignored gets no hook at all, so `nohup` and
 * a background job keep surviving it ({@link inheritedIgnore}).
 */
function installGroupHooks(): void {
  if (groupHooksInstalled) return;
  groupHooksInstalled = true;
  process.on("exit", endLiveGroupsSync);
  for (const sig of Object.keys(SIGNAL_NUMBERS) as HookedSignal[]) {
    if (inheritedIgnore(sig)) continue;
    let ending = false;
    const reraise = () => {
      process.removeListener(sig, onSignal);
      process.kill(process.pid, sig);
    };
    const onSignal = () => {
      if (process.listenerCount(sig) !== 1) {
        killLiveProcessGroups();
      } else if (ending) {
        killLiveProcessGroups();
        reraise();
      } else {
        ending = true;
        void endLiveGroups().then(reraise);
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
 * rejection. The rejection leaves nothing behind that holds the event loop: its
 * timers are cleared, and its pipe reads are cancelled, so a process that left
 * the group and still holds a pipe does not keep this one alive. A group stays
 * in the live registry until its timeout kill is done, so the parent's signal
 * or exit in that window still ends it.
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
  // Kept registered while a timeout kill is under way; a leader the kill
  // gave up on leaves the registry when it does exit.
  let killDone = false;
  void proc.exited.then(() => {
    exited = true;
    if (!timedOut || killDone) liveGroups.delete(proc.pid);
  });
  const cancelReads: (() => void)[] = [];

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (!opts.quietTimeout) {
        log.error("{label} timed out after {timeoutMs}ms — killing PID {pid}", {
          label,
          timeoutMs,
          pid: proc.pid,
        });
      }
      signal("SIGTERM");
      const grace = opts.killGraceMs ?? RUN_PROC_KILL_GRACE_MS;
      // Fires only while the child is still there: an exit inside the grace
      // settles below first, and that path clears this timer.
      const killTimer = setTimeout(() => {
        log.error("{label} ignored SIGTERM for {grace}ms — SIGKILL to PID {pid}", { label, grace, pid: proc.pid });
        signal("SIGKILL");
      }, grace);
      const termAt = performance.now();
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const leaderGoneOrGiveUp = new Promise<void>((settle) => {
        giveUp = setTimeout(settle, grace + POST_KILL_WAIT_MS);
        void proc.exited.then(() => settle());
      });
      void leaderGoneOrGiveUp.then(async () => {
        clearTimeout(giveUp);
        if (opts.processGroup && exited) {
          // A group leader that died on SIGTERM may leave members that trap
          // it: this is the only SIGKILL they get, since the grace timer is
          // cleared below. With `groupGrace` they get the rest of the grace
          // first.
          if (opts.groupGrace) {
            while (performance.now() - termAt < grace && groupAlive(proc.pid)) await Bun.sleep(20);
          }
          signal("SIGKILL");
        }
        clearTimeout(killTimer);
        killDone = true;
        if (exited) liveGroups.delete(proc.pid);
        for (const cancel of cancelReads) cancel();
        reject(new ProcTimeoutError(label, timeoutMs));
      });
    }, timeoutMs);
  });

  const workPromise = (async (): Promise<ProcResult> => {
    const maxBytes = opts.maxOutputBytes ?? RUN_PROC_MAX_OUTPUT_BYTES;
    const [stdout, stderr, exitCode] = await Promise.all([
      readCapped(proc.stdout as ReadableStream<Uint8Array> | null, maxBytes, cancelReads),
      readCapped(proc.stderr as ReadableStream<Uint8Array> | null, maxBytes, cancelReads),
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
