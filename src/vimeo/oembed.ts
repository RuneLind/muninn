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
 * A private, deleted or password-walled video answers 403/404. That is not an
 * error: it is the answer, and it arrives as `{notPublic: true}` so a caller can
 * record "not public" instead of retrying. Every OTHER failure — a 5xx, a
 * timeout, an unparseable body — throws {@link VimeoOembedError}, because those
 * say nothing about the video.
 */
import { getLog } from "../logging.ts";
import { extractVimeoVideoId, vimeoWatchUrl } from "./url.ts";

const log = getLog("vimeo", "oembed");

/** Whole-operation budget. oEmbed is one small GET; 10 s is generous. */
export const VIMEO_OEMBED_TIMEOUT_MS = 10_000;

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

/** The video is not reachable without credentials — private, deleted, or walled. */
export interface VimeoNotPublic {
  readonly notPublic: true;
  /** The status that said so, for the log line the caller writes. */
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
 * Fetch a video's metadata. `idOrUrl` may be a bare numeric id or any URL shape
 * `extractVimeoVideoId` accepts — an unlisted video's private hash is carried
 * through to oEmbed, which 404s without it.
 */
export async function fetchVimeoOembed(
  idOrUrl: string,
  opts: VimeoOembedOptions = {},
): Promise<VimeoOembedResult> {
  const watchUrl = resolveWatchUrl(idOrUrl);
  const base = (opts.baseUrl ?? vimeoOembedBaseUrl()).replace(/\/+$/, "");
  const endpoint = `${base}/api/oembed.json?url=${encodeURIComponent(watchUrl)}`;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? VIMEO_OEMBED_TIMEOUT_MS);

  let res: Response;
  try {
    res = await doFetch(endpoint, { signal: controller.signal, redirect: "follow" });
  } catch (err) {
    const timedOut = controller.signal.aborted;
    throw new VimeoOembedError(
      timedOut
        ? `Vimeo oEmbed timed out after ${opts.timeoutMs ?? VIMEO_OEMBED_TIMEOUT_MS}ms for ${watchUrl}`
        : `Vimeo oEmbed request failed for ${watchUrl}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 403 || res.status === 404) {
    log.info("Vimeo oEmbed says not public ({status}) for {watchUrl}", { status: res.status, watchUrl });
    return { notPublic: true, status: res.status };
  }
  if (!res.ok) {
    throw new VimeoOembedError(`Vimeo oEmbed returned HTTP ${res.status} for ${watchUrl}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new VimeoOembedError(`Vimeo oEmbed returned an unparseable body for ${watchUrl}`, { cause: err });
  }
  return toMetadata(body, watchUrl);
}

function resolveWatchUrl(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  if (/^\d+$/.test(trimmed)) return `https://vimeo.com/${trimmed}`;
  const ref = extractVimeoVideoId(trimmed);
  if (!ref) throw new VimeoOembedError(`Not a Vimeo video URL: ${trimmed}`);
  return vimeoWatchUrl(ref);
}

function toMetadata(body: unknown, watchUrl: string): VimeoMetadata {
  if (!body || typeof body !== "object") {
    throw new VimeoOembedError(`Vimeo oEmbed returned a non-object body for ${watchUrl}`);
  }
  const raw = body as Record<string, unknown>;
  const duration = typeof raw.duration === "number" ? raw.duration : Number(raw.duration);
  return {
    title: typeof raw.title === "string" ? raw.title : "",
    author: typeof raw.author_name === "string" ? raw.author_name : "",
    durationSec: Number.isFinite(duration) ? duration : 0,
    uploadDate: typeof raw.upload_date === "string" ? raw.upload_date : "",
    thumbnailUrl: typeof raw.thumbnail_url === "string" ? raw.thumbnail_url : "",
  };
}
