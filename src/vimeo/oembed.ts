/**
 * Vimeo metadata over oEmbed — the one Vimeo fact muninn can get with NO browser.
 *
 * `https://vimeo.com/api/oembed.json?url=<watch url>` answers 200 with the
 * title, author, duration, upload date and thumbnail for a public (or
 * hash-carrying unlisted) video, from a plain unauthenticated `fetch`. That is
 * the whole metadata half of a capture, and it does not go anywhere near the
 * caption harvest's headless Chromium — so a video whose captions cannot be
 * harvested still gets a titled, dated record.
 *
 * A private, deleted or password-walled video answers 403/404. Neither is an
 * error, and they are not the same fact either — which is why the STATUS rides
 * along on {@link VimeoNotPublic} and this module refuses to decide for the
 * caller:
 *
 *   - **404 is durable.** Vimeo does not have that video for an anonymous
 *     reader, and re-asking will not change it.
 *   - **403 may be a GATE.** Vimeo bot-gates unauthenticated clients (measured
 *     2026-09-04 on `player.vimeo.com/video/<id>/config`), so a 403 can mean
 *     "not you, right now" rather than "not public". A caller that can retry
 *     later, or from elsewhere, is entitled to.
 *
 * Every OTHER failure — a 5xx, a timeout, an oversized or unparseable body —
 * throws {@link VimeoOembedError}, because those say nothing about the video.
 */
import { getLog } from "../logging.ts";
import { readBounded } from "../utils/bounded-fetch.ts";
import { resolveVimeoRef, vimeoWatchUrl } from "./url.ts";

const log = getLog("vimeo", "oembed");

/** Whole-operation budget. oEmbed is one small GET; 10 s is generous. */
export const VIMEO_OEMBED_TIMEOUT_MS = 10_000;

/**
 * Hard body cap. A real oEmbed answer is ~1 KB, so 64 KB is two orders of
 * magnitude of slack — the point is that a wrong service on `VIMEO_OEMBED_BASE`
 * cannot stream muninn out of memory.
 */
export const VIMEO_OEMBED_MAX_BYTES = 64 * 1024;

/**
 * Base URL of the oEmbed endpoint, read at CALL time (the `isWikiReadonly()`
 * idiom) so a test or an e2e spec can point it at a local stub without a
 * process-wide snapshot deciding it first. `VIMEO_OEMBED_BASE` is in
 * `AMBIENT_INSTANCE_ENV`, so no suite inherits a developer's value.
 */
export function vimeoOembedBaseUrl(): string {
  return process.env.VIMEO_OEMBED_BASE?.trim() || "https://vimeo.com";
}

export interface VimeoMetadata {
  readonly title: string;
  readonly author: string;
  readonly durationSec: number;
  readonly uploadDate: string;
  readonly thumbnailUrl: string;
}

/**
 * The video is not reachable without credentials — private, deleted, walled, or
 * (on a 403) gated. The STATUS is part of the answer, not decoration for a log
 * line: 404 is a durable fact about the video, while 403 may be Vimeo declining
 * THIS client, and only the caller knows whether retrying later is worth it.
 */
export interface VimeoNotPublic {
  readonly notPublic: true;
  /** 404 (durable) or 403 (may be a bot gate). */
  readonly status: number;
}

export type VimeoOembedResult = VimeoMetadata | VimeoNotPublic;

export function isNotPublic(result: VimeoOembedResult): result is VimeoNotPublic {
  return (result as VimeoNotPublic).notPublic === true;
}

export class VimeoOembedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VimeoOembedError";
  }
}

export interface VimeoOembedOptions {
  /** Test seam — production uses the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Overrides {@link vimeoOembedBaseUrl} for one call. */
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Fetch a video's metadata. `idOrUrl` is anything {@link resolveVimeoRef}
 * accepts — a bare id or any Vimeo URL shape — and an unlisted video's private
 * hash is carried through to oEmbed, which 404s without it.
 *
 * Bounded in time AND in bytes, with the time budget covering the body read.
 */
export async function fetchVimeoOembed(
  idOrUrl: string,
  opts: VimeoOembedOptions = {},
): Promise<VimeoOembedResult> {
  const ref = resolveVimeoRef(idOrUrl);
  if (!ref) throw new VimeoOembedError(`Not a Vimeo video URL: ${idOrUrl.trim()}`);
  const watchUrl = vimeoWatchUrl(ref);
  const base = (opts.baseUrl ?? vimeoOembedBaseUrl()).replace(/\/+$/, "");
  const endpoint = `${base}/api/oembed.json?url=${encodeURIComponent(watchUrl)}`;
  const doFetch = opts.fetchImpl ?? fetch;
  const budgetMs = opts.timeoutMs ?? VIMEO_OEMBED_TIMEOUT_MS;
  const controller = new AbortController();
  // The flag, not `signal.aborted`, is what says WHY: the body read aborts the
  // same controller when it goes over the cap, and that is not a timeout.
  let timedOut = false;
  // The budget as something to RACE, not only as an abort. The signal bounds a
  // `fetch` that honours it; racing bounds the CALLER whatever the body turns
  // out to be — which is the promise this function makes. `.catch` is attached
  // at once so a timer that fires when nothing is racing (the 403 branch
  // returning first) cannot raise an unhandled rejection.
  let expire: () => void = () => {};
  const budgetExpired = new Promise<never>((_resolve, reject) => {
    expire = () => reject(new VimeoOembedError(`Vimeo oEmbed timed out after ${budgetMs}ms for ${watchUrl}`));
  });
  budgetExpired.catch(() => {});
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    expire();
  }, budgetMs);

  // The whole operation, headers AND body, lives inside the one budget — the
  // timer used to be cleared the moment the headers landed, which left the body
  // read with no timer and no abort behind it. Measured: a 200 followed by a
  // stalled body hung past 3 s on a 200 ms budget, unreapable.
  try {
    let res: Response;
    try {
      const fetching = doFetch(endpoint, { signal: controller.signal, redirect: "follow" });
      fetching.catch(() => {}); // the race's loser is nobody's rejection
      res = await Promise.race([fetching, budgetExpired]);
    } catch (err) {
      if (err instanceof VimeoOembedError) throw err;
      throw new VimeoOembedError(
        timedOut
          ? `Vimeo oEmbed timed out after ${budgetMs}ms for ${watchUrl}`
          : `Vimeo oEmbed request failed for ${watchUrl}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (res.status === 403 || res.status === 404) {
      log.info("Vimeo oEmbed says not public ({status}) for {watchUrl}", { status: res.status, watchUrl });
      return { notPublic: true, status: res.status };
    }
    if (!res.ok) {
      throw new VimeoOembedError(`Vimeo oEmbed returned HTTP ${res.status} for ${watchUrl}`);
    }

    // `readBounded` is the repo's one body-cap loop (`src/utils/bounded-fetch.ts`)
    // and this is exactly what it is for: the declared length is the cheap check,
    // the read loop is the guarantee. It cancels the reader on the over-cap path
    // but cancelling does NOT close a Bun fetch socket, so the abort below is
    // what actually stops the transfer.
    let raw: string;
    try {
      const reading = readBounded(res, VIMEO_OEMBED_MAX_BYTES, endpoint);
      reading.catch(() => {});
      raw = await Promise.race([reading, budgetExpired]);
    } catch (err) {
      // Whichever way the read ended, stop the transfer: `readBounded` cancels
      // its reader, and a cancel does not close a Bun fetch socket.
      controller.abort();
      if (err instanceof VimeoOembedError) throw err;
      throw new VimeoOembedError(
        timedOut
          ? `Vimeo oEmbed timed out after ${budgetMs}ms for ${watchUrl}`
          : `Vimeo oEmbed body could not be read for ${watchUrl}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      throw new VimeoOembedError(`Vimeo oEmbed returned an unparseable body for ${watchUrl}`, { cause: err });
    }
    return toMetadata(body, watchUrl);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * oEmbed's `duration` is seconds. Anything that is not a non-negative finite
 * number is "the endpoint did not say", which is 0 — `Number()` alone turned
 * `true` into a one-second video and let a negative through.
 */
function toDurationSec(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function toMetadata(body: unknown, watchUrl: string): VimeoMetadata {
  // `typeof [] === "object"`, so an ARRAY needs saying: without this an array
  // body came back as metadata with every field empty — a record that reads like
  // an untitled video rather than like a broken endpoint.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new VimeoOembedError(`Vimeo oEmbed returned a non-object body for ${watchUrl}`);
  }
  const raw = body as Record<string, unknown>;
  return {
    title: typeof raw.title === "string" ? raw.title : "",
    author: typeof raw.author_name === "string" ? raw.author_name : "",
    durationSec: toDurationSec(raw.duration),
    uploadDate: typeof raw.upload_date === "string" ? raw.upload_date : "",
    thumbnailUrl: typeof raw.thumbnail_url === "string" ? raw.thumbnail_url : "",
  };
}
