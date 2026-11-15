/**
 * What every read of another machine's muninn shares (`MUNINN_PEERS`): one
 * bounded GET whose reply is checked inside the same bound, and a down window
 * per machine. The step-check answerer (`peer.ts`) and the boot line's peer
 * rows (`boot-line-peer.ts`) each pass their own reply check and log line.
 */

import { readBounded } from "../../utils/bounded-fetch.ts";
import { within, type Stamp } from "./two-clock.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** A failed fetch's why, from what Bun exposes as `name`/`code` (observed on Bun 1.3: a refused redirect is `code: "UnexpectedRedirect"`, an abort a DOMException named `AbortError`/`TimeoutError`). */
export function fetchFailureWhy(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown } | null;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "timed out";
  if (e?.code === "UnexpectedRedirect") return "answered with a redirect";
  return "could not be reached";
}

/** Bun's fetch messages quote the url (query included): never let it into the log. */
export const scrubUrls = (msg: string) => msg.replace(/\bhttps?:\/\/[^\s"'<>]*/gi, "<url>").slice(0, 300);

export interface PeerFailure {
  reason: string;
  err?: unknown;
}

export type PeerGet<T> = { value: T } | { failure: PeerFailure };

export interface PeerGetOpts {
  fetch: FetchLike;
  timeoutMs: number;
  maxBytes: number;
}

/**
 * GET `url` and pass its JSON body to `read`, all inside `timeoutMs`: status
 * 200 without a redirect (a 429 is «is busy»), a JSON content type, at most
 * `maxBytes`. A failure's reason completes «the peer … <reason>». Rejects only
 * when `read` throws.
 */
export async function boundedPeerGet<T>(url: string, opts: PeerGetOpts, read: (body: unknown) => { value: T } | { refused: string }): Promise<PeerGet<T>> {
  const fail = (reason: string, err?: unknown): PeerGet<T> => ({ failure: { reason, err } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ctl = new AbortController();
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      ctl.abort();
      resolve("timeout");
    }, opts.timeoutMs);
  });
  const exchange = async (): Promise<PeerGet<T>> => {
    let res: Response;
    try {
      res = await opts.fetch(url, { redirect: "error", signal: ctl.signal, headers: { accept: "application/json" } });
    } catch (err) {
      return fail(fetchFailureWhy(err), err);
    }
    // An unread body is released by the abort in `finally`.
    if (res.status === 429 && !res.redirected) return fail("is busy");
    if (res.status !== 200 || res.redirected) return fail(`answered HTTP ${res.status}`);
    if (!(res.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return fail("did not answer JSON");
    let body: unknown;
    try {
      body = JSON.parse(await readBounded(res, opts.maxBytes, new URL(url).origin));
    } catch {
      return fail("sent a reply muninn cannot read");
    }
    const got = read(body);
    return "refused" in got ? fail(got.refused) : got;
  };
  try {
    const got = await Promise.race([exchange(), timeout]);
    return got === "timeout" ? fail("timed out") : got;
  } finally {
    clearTimeout(timer);
    // Releases the connection and any body left unread; a no-op once the body was read.
    ctl.abort();
  }
}

/**
 * Per machine: after a request fails as a whole, `isDown` answers for `downMs`
 * so callers skip the peer instead of waiting out another timeout. The window
 * is live only while its age is in [0, downMs) on both clocks (`within`).
 * `onOpen` runs once per window opened, never for a request that was already
 * in flight when it opened.
 */
export function createDownWindow(opts: { downMs: number; now: () => Stamp; onOpen: (machine: string, failure: PeerFailure) => void }) {
  /** Bounded by the configured peers. */
  const down = new Map<string, { openedAt: Stamp; reason: string }>();
  const isDown = (machine: string, t: Stamp = opts.now()) => {
    const d = down.get(machine);
    return d && within(d.openedAt, opts.downMs, t) ? d : null;
  };
  const settle = (machine: string, failure?: PeerFailure) => {
    if (!failure) {
      down.delete(machine);
      return;
    }
    const t = opts.now();
    if (isDown(machine, t)) return;
    down.set(machine, { openedAt: t, reason: failure.reason });
    opts.onOpen(machine, failure);
  };
  return { isDown, settle };
}

/** The structured fields a peer failure logs: error name and code and a url-free message, never the url. */
export function failureLogFields(err: unknown): { errorName?: string; errorCode?: string | number; errorMessage?: string } {
  const e = err as { name?: unknown; code?: unknown; message?: unknown } | undefined;
  return {
    errorName: typeof e?.name === "string" ? e.name : undefined,
    errorCode: typeof e?.code === "string" || typeof e?.code === "number" ? e.code : undefined,
    errorMessage: typeof e?.message === "string" ? scrubUrls(e.message) : undefined,
  };
}
