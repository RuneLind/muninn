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
}

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
      reject(new ProcTimeoutError(label, timeoutMs));
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
    return await Promise.race([workPromise, timeoutPromise]);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}
