/**
 * The one host-pinned, bounded download this vertical performs — for a caption
 * file, a media manifest, or a media segment. The three callers differ only in
 * the host they trust, the byte cap and the words in their error messages.
 *
 * Every URL this fetches comes out of a page a third party controls (the
 * harvest reads them off Chromium's request stream), so the rules are the
 * `downloadVtt` rules verbatim, now stated once:
 *
 *  - https only, and the hostname compared EXACTLY against the pinned host
 *    (a trailing root dot normalised, nothing else);
 *  - `redirect: "error"` — a host pin that follows redirects is not a host pin,
 *    since the first hop can be anywhere;
 *  - bounded in TIME (one budget, raced at every await, not left to the abort
 *    signal alone) and in BYTES (an over-cap body is REFUSED, and the request
 *    is ABORTED at the moment the cap is crossed — a `reader.cancel()` does not
 *    close a Bun fetch socket, measured cross-process in `safe-fetch.ts`).
 *
 * The cap refuses rather than truncates for the same reason in all three
 * callers: half a VTT is a transcript with a silent hole, half a manifest is a
 * JSON parse error at best, and half a media segment is a file ffmpeg reads up
 * to the cut and then reports success on.
 */

/** Base class for every refusal this downloader produces. */
export class VimeoDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VimeoDownloadError";
  }
}

export interface DownloadPinnedOptions {
  /** The ONLY hostname the URL may name. Compared exactly, lowercase. */
  host: string;
  maxBytes: number;
  timeoutMs: number;
  /**
   * The noun the messages use for this download ("Caption", "Manifest",
   * "Segment") — the caller's word, so a log line names what failed rather
   * than "download".
   */
  what: string;
  /** Test seam — production uses the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * The error class thrown. Defaults to {@link VimeoDownloadError}; a caller
   * that has its own subclass (so ITS callers can `instanceof` it) passes it.
   */
  error?: new (message: string, options?: ErrorOptions) => VimeoDownloadError;
}

/**
 * Download one URL under the rules above and return its bytes.
 *
 * Text callers decode; binary callers append. The function never buffers more
 * than `maxBytes` — the streamed path refuses byte by byte, and a bodiless
 * response has only its declared `content-length` to go on, which is checked
 * BEFORE anything is buffered.
 */
export async function downloadPinned(url: string, opts: DownloadPinnedOptions): Promise<Uint8Array> {
  const Err = opts.error ?? VimeoDownloadError;
  const { host, maxBytes, timeoutMs, what } = opts;
  const lowerWhat = what.toLowerCase();

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Err(`Not a URL: ${url}`, { cause: err });
  }
  if (parsed.protocol !== "https:") {
    throw new Err(`Refusing non-https ${lowerWhat} URL: ${parsed.protocol}//${parsed.host}`);
  }
  // `URL.hostname` is already lowercase (WHATWG lowercases it); only the
  // trailing root dot is left to normalise.
  if (parsed.hostname.replace(/\.$/, "") !== host) {
    throw new Err(`Refusing ${lowerWhat} URL on host ${parsed.hostname} (only ${host} is allowed)`);
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  // The FLAG says why, not `signal.aborted`: this function aborts its own
  // controller on an over-cap body too, and that is not a timeout.
  let timedOut = false;
  // The budget as something to RACE, not only as an abort — the same shape
  // `fetchVimeoOembed` uses, and for the same reason: the signal bounds a
  // transport that HONOURS it, while racing bounds the CALLER whatever the
  // transport does. A `fetchImpl` stub, an e2e fake, or a body that ignores its
  // signal left this function awaiting a promise that never settled, with the
  // timer already fired and nobody listening. `.catch` is attached at once so a
  // timer firing when nothing is racing cannot raise an unhandled rejection, and
  // the timer is cleared in the `finally` below.
  let expire: () => void = () => {};
  const budgetExpired = new Promise<never>((_resolve, reject) => {
    expire = () => reject(new Err(`${what} download timed out after ${timeoutMs}ms`));
  });
  budgetExpired.catch(() => {});
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    expire();
  }, timeoutMs);

  const classify: (err: unknown, reading: boolean) => never = (err, reading) => {
    // The budget's own rejection is already this module's error, with the
    // right message — re-wrapping it would bury it as a transport failure.
    if (err instanceof VimeoDownloadError) throw err;
    // A real `fetch` throws here for two different reasons — the budget, and
    // `redirect: "error"` meeting a 3xx — and naming only the second made a
    // plain timeout read as a redirect refusal. The transport's own message
    // says which; this line no longer guesses.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Err(
      timedOut
        ? `${what} download timed out after ${timeoutMs}ms`
        : reading
          ? `${what} body could not be read: ${detail}`
          : `${what} download failed: ${detail}`,
      { cause: err },
    );
  };

  try {
    let res: Response;
    try {
      const fetching = doFetch(url, { redirect: "error", signal: controller.signal });
      fetching.catch(() => {}); // the race's loser is nobody's rejection
      res = await Promise.race([fetching, budgetExpired]);
    } catch (err) {
      classify(err, false);
    }
    // UNREACHABLE against a real `fetch`: with `redirect: "error"` a 3xx throws
    // above and never becomes a Response. It stays for a `fetchImpl` that hands
    // one back anyway — a stub, an e2e fake — so the refusal is the same either
    // way rather than a redirect body being parsed as content.
    if (res.status >= 300 && res.status < 400) {
      controller.abort();
      throw new Err(`${what} URL answered a redirect (${res.status}); refusing to follow it`);
    }
    if (!res.ok) {
      controller.abort();
      throw new Err(`${what} download returned HTTP ${res.status}`);
    }

    // Deliberately NOT `readBounded` (`src/utils/bounded-fetch.ts`), the repo's
    // other body cap: that one cancels its reader on the over-cap path, and a
    // `reader.cancel()` does not close a Bun fetch socket (measured
    // cross-process: 52 GB kept arriving after a read that returned in 8 ms).
    // Only aborting the CONTROLLER stops the transfer, and it has to happen at
    // the moment the cap is crossed — inside this loop.
    const reader = res.body?.getReader();
    if (!reader) {
      // No stream to bound. The declared length is then the only bound there
      // is, so it is checked BEFORE anything is buffered.
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        controller.abort();
        throw new Err(`${what} body declares ${declared} bytes, over the ${maxBytes}-byte cap`);
      }
      const reading = res.arrayBuffer();
      reading.catch(() => {});
      let buf: ArrayBuffer;
      try {
        buf = await Promise.race([reading, budgetExpired]);
      } catch (err) {
        classify(err, true);
      }
      if (buf.byteLength > maxBytes) {
        throw new Err(`${what} body exceeds ${maxBytes} bytes`);
      }
      return new Uint8Array(buf);
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      // Raced, not merely awaited: a stream that neither yields nor errors on
      // abort leaves `reader.read()` pending forever, and the cap below can only
      // fire on bytes that actually arrive.
      const draining = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          if (received > maxBytes) {
            // Stopping the READ does not stop the TRANSFER — abort the request
            // that opened the socket (the `safe-fetch.ts` measurement).
            controller.abort();
            throw new Err(`${what} body exceeds ${maxBytes} bytes`);
          }
          chunks.push(value);
        }
      })();
      draining.catch(() => {});
      await Promise.race([draining, budgetExpired]);
    } catch (err) {
      // The budget can expire HERE, mid-body — the likeliest failure this
      // download has, and it used to escape as a raw `AbortError` past every
      // caller's `instanceof` check.
      classify(err, true);
    }
    const joined = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return joined;
  } finally {
    clearTimeout(timer);
  }
}
