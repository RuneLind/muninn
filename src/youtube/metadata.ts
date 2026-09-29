/**
 * The three frontmatter fields a YouTube capture states about the VIDEO rather
 * than about the summary: `author`, `upload_date`, `duration_sec` — the keys
 * the Vimeo vertical already writes, so both sources read alike in the header
 * and the export (huginn #139 accepts them on `/api/youtube/ingest`).
 *
 * Sources, in order:
 *   - the yt-dlp probe, which runs only on a frames-on capture. Its sentinels
 *     count as absent: `parseYtDlpJson` maps a missing duration to `0` and a
 *     missing uploader to `""`, and yt-dlp omits `upload_date` for live and
 *     upcoming videos.
 *   - YouTube oEmbed, for `author` alone, when the probe did not run or named
 *     nobody. Bounded at 5 s, and a failure omits the field — never the capture.
 *
 * Nothing estimated is stored: `duration_sec` means an EXACT length here, as it
 * does for Vimeo. A caption-end estimate stays a display-only reader pill.
 */
import { readBounded } from "../utils/bounded-fetch.ts";
import type { YtDlpInfo } from "../video/media.ts";

/** oEmbed is one small GET; a capture never waits on it longer than this. */
export const YOUTUBE_OEMBED_TIMEOUT_MS = 5_000;
/** A real answer is ~1 KB. */
const YOUTUBE_OEMBED_MAX_BYTES = 64 * 1024;

export interface YouTubeVideoFields {
  author?: string;
  /** `YYYY-MM-DD`. huginn does not format-check it, so this is the one place the shape is set. */
  upload_date?: string;
  /** Rounded — huginn's model is an int and answers 422 on a fraction. */
  duration_sec?: number;
}

/** yt-dlp's `YYYYMMDD` as `YYYY-MM-DD`; anything else (absent, `NA`, a partial) is `undefined`. */
export function normalizeUploadDate(raw: string | undefined): string | undefined {
  if (raw === undefined || !/^\d{8}$/.test(raw)) return undefined;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/** The probe's uploader, trimmed, or `undefined` for the `""` sentinel. */
export function probeAuthor(probe: YtDlpInfo | null): string | undefined {
  const name = probe?.uploader.trim();
  return name ? name : undefined;
}

/**
 * The fields to put on the ingest body. `oembedAuthor` is consulted only when
 * the probe named nobody; every key is left OFF rather than sent empty.
 */
export function youtubeVideoFields(
  probe: YtDlpInfo | null,
  oembedAuthor: string | undefined,
): YouTubeVideoFields {
  const fields: YouTubeVideoFields = {};
  const author = probeAuthor(probe) ?? (oembedAuthor?.trim() || undefined);
  if (author !== undefined) fields.author = author;
  if (probe !== null) {
    const day = normalizeUploadDate(probe.uploadDate);
    if (day !== undefined) fields.upload_date = day;
    if (Number.isFinite(probe.duration) && probe.duration > 0) {
      const rounded = Math.round(probe.duration);
      if (rounded > 0) fields.duration_sec = rounded;
    }
  }
  return fields;
}

/**
 * One oEmbed answer, classified. `unavailable` is a fact about the VIDEO —
 * 401 (private, or embedding off) and 404 (deleted) — and `error` is everything
 * that says nothing about it (a timeout, a 5xx, a 429, a malformed body), which
 * is the class the backfill counts toward its consecutive-failure abort.
 */
export type YouTubeOembedResult =
  | { readonly kind: "ok"; readonly author: string }
  | { readonly kind: "unavailable"; readonly status: number }
  | { readonly kind: "error"; readonly error: string };

export interface YouTubeOembedOptions {
  /** Test seam — production uses the global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Default `https://www.youtube.com`. */
  baseUrl?: string;
}

/** Ask oEmbed who uploaded `videoId`. Never throws; bounded in time AND bytes. */
export async function fetchYouTubeOembed(
  videoId: string,
  opts: YouTubeOembedOptions = {},
): Promise<YouTubeOembedResult> {
  const base = (opts.baseUrl ?? "https://www.youtube.com").replace(/\/+$/, "");
  const watch = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const endpoint = `${base}/oembed?format=json&url=${encodeURIComponent(watch)}`;
  const budgetMs = opts.timeoutMs ?? YOUTUBE_OEMBED_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Raced, not only aborted: the abort bounds a fetch that honours its signal,
  // the race bounds the CALLER whatever the body does.
  const expired = new Promise<YouTubeOembedResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "error", error: `timeout after ${budgetMs}ms` });
    }, budgetMs);
  });
  const attempt = (async (): Promise<YouTubeOembedResult> => {
    const res = await doFetch(endpoint, { signal: controller.signal, redirect: "follow" });
    if (res.status === 401 || res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return { kind: "unavailable", status: res.status };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { kind: "error", error: `HTTP ${res.status}` };
    }
    const text = await readBounded(res, YOUTUBE_OEMBED_MAX_BYTES, endpoint);
    const parsed = JSON.parse(text) as { author_name?: unknown };
    const author = typeof parsed.author_name === "string" ? parsed.author_name.trim() : "";
    if (!author) return { kind: "error", error: "no author_name in the answer" };
    return { kind: "ok", author };
  })().catch((err: unknown): YouTubeOembedResult => ({
    kind: "error",
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  }));
  try {
    return await Promise.race([attempt, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** The capture's form: the author, or `undefined` on ANY failure. */
export async function fetchYouTubeOembedAuthor(
  videoId: string,
  opts: YouTubeOembedOptions = {},
): Promise<string | undefined> {
  const result = await fetchYouTubeOembed(videoId, opts);
  return result.kind === "ok" ? result.author : undefined;
}
