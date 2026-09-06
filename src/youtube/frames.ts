/**
 * Slides in a YouTube summary — the vertical's own half, all of it PURE.
 *
 * Everything source-neutral lives in `src/summaries/frames.ts` (the cadence,
 * the served root, the URL shape, the prompt section, the id gate, the kept-
 * frame copy and removal, the ffmpeg grab, `extractCadenceFramesFromFile`).
 * Vimeo's half is a DASH manifest; YouTube's is the whole file on disk, which
 * the seam already covers — so what is left here is the DECIDING: whether
 * frames run at all, what yt-dlp is pointed at and asked for, how long each
 * step may take, and what the ingest body is allowed to carry.
 *
 * It holds the transcript rules too, and that is deliberate rather than
 * misfiled: both exist ONLY because frames exist. `?timestamps=1` is asked for
 * exactly when a slide has to be placed beside the passage it illustrates, and
 * the `## Transcript` append is the windowed transcript the same request
 * fetched. With frames off, nothing in this module is reached and the capture
 * is byte-identical to the one that shipped before it.
 *
 * No I/O and no imports at all — so it is unit-tested in the shared chunk, with
 * no `mock.module` and no yt-dlp.
 */

/**
 * The rendition frames are pulled from, and the height they are scaled to.
 *
 * 720p for the reason the Vimeo half states: a slide's text is legible there,
 * and 1080p is ~1.6× the bytes and ~2.25× the image tokens for the same
 * picture. The extractor's filter is `min(height, ih)`, so a source that is
 * SHORTER than this is never upscaled.
 */
export const YOUTUBE_FRAME_HEIGHT = 720;

/**
 * The yt-dlp format selector for a frames download: the best VIDEO-ONLY
 * rendition at most 720 tall, mp4 preferred.
 *
 * Video-only is the point. The transcript comes from huginn's caption API, so
 * this download exists solely to be decoded into JPEGs — every byte of audio in
 * it would be paid for and thrown away. `bv` is also what keeps the fallback
 * honest: `b` (a muxed stream) at `height<=720` exists on most uploads but is
 * strictly larger, and the shared {@link YTDLP_FORMAT_SELECTOR} cannot express
 * "no audio" at all.
 *
 * Two tiers rather than one: `ext=mp4` first because an H.264 mp4 is the
 * cheapest thing ffmpeg can seek into, then the same height cap with no
 * container preference, for an upload whose only ≤720p video-only rendition is
 * WebM/VP9. There is deliberately NO uncapped tail — a capture that cannot get
 * a ≤720p video stream degrades to transcript-only rather than pulling a 1080p
 * one it would immediately scale down.
 *
 * `YTDLP_FORMAT_SELECTOR` in `src/video/media.ts` is the shared muxed selector
 * the other verticals use; it has no way to say "no audio".
 */
export const YOUTUBE_FRAME_FORMAT_SELECTOR = "bv[height<=720][ext=mp4]/bv[height<=720]";

/**
 * Longest video this vertical will pull frames from: 3 hours, the X-video cap.
 *
 * It bounds the FRAMES path only. A transcript-only YouTube capture has never
 * had a duration cap (nothing on the route, the job or huginn's transcript
 * endpoint carries a duration), and this PR does not add one — the cap exists
 * because a download and an ffmpeg pass are being spent, and a capture that
 * asks for no frames spends neither.
 */
export const YOUTUBE_FRAMES_MAX_DURATION_SEC = 10_800;

/**
 * Shortest video worth pulling frames from.
 *
 * A DURATION cut, not a frame-count one: under a minute
 * {@link frameBudgetFor} still hands out 15 ticks, so the budget would happily
 * sample a 40-second clip every 2.7 seconds — a download, 15 ffmpeg runs and 15
 * image reads for a video whose transcript already says everything. Talks are
 * what slides pay for.
 */
export const YOUTUBE_FRAMES_MIN_DURATION_SEC = 60;

/**
 * A transcript-only summarize call gets the 600 s floor `summarizeTimeoutFor`
 * gives a 30-frame TikTok; with frames ON it is scaled by the frame count
 * through that same function (24 s per frame past 30), because every frame is
 * one more image Read in the same session. The Vimeo constant, for the same
 * reason.
 *
 * This is a RAISE for the transcript-only path, which used to inherit the bot's
 * own `timeoutMs` — stated, because it is the one thing here a frames-off
 * capture notices. It is a ceiling on a background job that nothing waits on,
 * and the old default (120 s from `CLAUDE_TIMEOUT_MS`) is well under what a
 * long transcript takes.
 */
export const YOUTUBE_SUMMARIZE_TIMEOUT_MS = 600_000;

/**
 * The most bytes of windowed transcript the ingest body may carry — huginn's
 * own `VIMEO_TRANSCRIPT_MAX_BYTES`, restated here because the YouTube ingest
 * has no `transcript_markdown` field to validate it (see
 * {@link appendTranscriptSection}).
 */
export const YOUTUBE_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;

/** The watch URL yt-dlp is pointed at, built from a video id and nothing else. */
export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * The huginn transcript URL. `?timestamps=1` — never a blank value, which
 * huginn answers 422 — is appended ONLY on the frames path (huginn #129); the
 * frames-off URL is byte-identical to the one that shipped before this PR.
 */
export function transcriptUrl(knowledgeApiUrl: string, videoId: string, timestamps: boolean): string {
  const base = `${knowledgeApiUrl}/api/youtube/transcript/${videoId}`;
  return timestamps ? `${base}?timestamps=1` : base;
}

/** Why a capture is or is not pulling frames — one token, stamped on the trace. */
export type YouTubeFramesReason =
  /** The reader did not ask for slides. */
  | "off"
  /** Asked for, and running. */
  | "on"
  /** The summarizer's connector cannot read files (the route 503s first). */
  | "unsupported"
  /** yt-dlp would not say how long the video is — a live stream, or a probe that failed. */
  | "duration_unknown"
  /** Under {@link YOUTUBE_FRAMES_MIN_DURATION_SEC}. */
  | "too_short"
  /** Over {@link YOUTUBE_FRAMES_MAX_DURATION_SEC}. */
  | "too_long";

export interface YouTubeFramesDecision {
  /** Whether the download + extraction runs. */
  readonly frames: boolean;
  readonly reason: YouTubeFramesReason;
}

/**
 * Whether this capture pulls frames — the whole decision, over three facts and
 * nothing else, so the state space is a table rather than a call graph.
 *
 * `duration_unknown` is its own answer and is checked BEFORE the length cuts,
 * deliberately: `parseYtDlpJson` maps a missing `duration` to **0** (a live
 * stream reports none), and a probe that failed hands over `null` — both would
 * otherwise fall under the "too short" cut by accident and be reported as a
 * clip. A non-finite or negative duration is the same fact.
 *
 * `unsupported` is a second line, not the first: the route pre-flights the
 * connector and 503s before a job exists. It is kept because this function is
 * what the SUMMARIZER asks, and a job reaching it with `frames: true` on a
 * connector that cannot read files would otherwise spend a download and an
 * ffmpeg pass on images no model will ever open.
 */
export function decideYouTubeFrames(input: {
  framesRequested: boolean;
  supportsExtraDirs: boolean;
  durationSec: number | null;
}): YouTubeFramesDecision {
  if (!input.framesRequested) return { frames: false, reason: "off" };
  if (!input.supportsExtraDirs) return { frames: false, reason: "unsupported" };
  const d = input.durationSec;
  if (d === null || !Number.isFinite(d) || d <= 0) return { frames: false, reason: "duration_unknown" };
  if (d < YOUTUBE_FRAMES_MIN_DURATION_SEC) return { frames: false, reason: "too_short" };
  if (d > YOUTUBE_FRAMES_MAX_DURATION_SEC) return { frames: false, reason: "too_long" };
  return { frames: true, reason: "on" };
}

/**
 * How long the frames download may take, scaled by the video's length.
 *
 * The shared default is 120 s, sized for a TikTok clip; a 720p video-only
 * rendition of a long talk is two orders of magnitude bigger. Floor 5 min,
 * 0.3 s per second of talk, ceiling 30 min — slack by construction rather than
 * a fitted curve: measured on a 1435 s talk, the rendition is 51.5 MiB and
 * comes down in 8.6 s against a 360 s budget. It bounds a HANG; nothing waits
 * on the job.
 *
 * There is no BYTE cap, and that is stated rather than papered over:
 * `--max-filesize` has no exit code of its own, so a caller cannot tell an
 * over-size refusal from an ordinary failure. What binds is the duration cap
 * ({@link YOUTUBE_FRAMES_MAX_DURATION_SEC}, enforced twice — once by the probe
 * above and once by yt-dlp's own `--break-match-filters`, exit 101) and this
 * budget.
 */
export function youtubeDownloadTimeoutFor(durationSec: number): number {
  const scaled = Math.round(Math.max(0, durationSec) * 300);
  return Math.min(1_800_000, Math.max(300_000, scaled));
}

/**
 * The windowed transcript, trimmed to {@link YOUTUBE_TRANSCRIPT_MAX_BYTES} at a
 * WINDOW boundary.
 *
 * At a boundary rather than at a byte, because the windows are the contract: a
 * cut mid-window leaves a `### [HH:MM:SS]` heading over half a sentence, and
 * huginn's heading splitter would carry that timestamp into a chunk that ends
 * mid-word. A transcript over the cap keeps as many whole windows as fit and
 * says so in the text, so a reader of the stored document is never shown a
 * truncation as if it were the end of the talk.
 *
 * Pure. `truncated` is returned as well as noted, so a caller can log it.
 */
export function capTranscriptWindows(
  transcript: string,
  maxBytes: number = YOUTUBE_TRANSCRIPT_MAX_BYTES,
): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(transcript).length <= maxBytes) return { text: transcript, truncated: false };

  const windows = transcript.split("\n\n");
  const kept: string[] = [];
  let bytes = 0;
  for (const w of windows) {
    // +2 for the `\n\n` this window is joined on (the first one pays it too;
    // one separator of slack is not worth an off-by-one branch).
    const size = encoder.encode(w).length + 2;
    if (bytes + size > maxBytes) break;
    kept.push(w);
    bytes += size;
  }
  const note = "_(transcript truncated — the talk continues past this window.)_";
  return { text: [...kept, note].join("\n\n"), truncated: true };
}

/**
 * The ingest body's `summary` field with the windowed transcript appended under
 * a `## Transcript` heading.
 *
 * **Why the SUMMARY string and not a field of its own:** huginn's YouTube
 * ingest (`main/ingest/youtube.py`, `YouTubeIngestRequest`) has no
 * `transcript_markdown` — the Vimeo vertical's `body_suffix` route into
 * `write_summary` exists only for Vimeo — so the document body is exactly what
 * is posted as `summary`. Appending here is what puts the transcript in the
 * indexed document, which is what makes a hit inside a long talk citable to the
 * minute (huginn's `MarkdownHeadingSplitter` carries the nearest heading into
 * every chunk). A `transcript_markdown` field on the YouTube ingest is the
 * better shape and is filed as a follow-up.
 *
 * Only the INGEST body carries it: `completeJob`, the `similar` enrichment the
 * card shows and the source-page draft all get the summary alone.
 */
export function appendTranscriptSection(summary: string, transcript: string): string {
  const capped = capTranscriptWindows(transcript);
  return `${summary.trimEnd()}\n\n## Transcript\n\n${capped.text}\n`;
}
