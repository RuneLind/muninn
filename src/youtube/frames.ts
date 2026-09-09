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
 * It holds the transcript URL rule too, and that is deliberate rather than
 * misfiled: `?timestamps=1` exists ONLY because frames exist — it is asked for
 * exactly when a slide has to be placed beside the passage it illustrates. The
 * `## Transcript` append is no longer this module's: it is source-neutral now
 * (`src/summaries/transcript-appendix.ts`), because the short-video verticals
 * file their whisper transcript the same way and `src/video/` may not import
 * `src/youtube/`. The names are re-exported below, so no importer moved.
 *
 * No I/O, and its only import is the dependency-free
 * `src/summaries/transcript-appendix.ts` leaf — so it is unit-tested in the
 * shared chunk, with no `mock.module` and no yt-dlp.
 */

import { TRANSCRIPT_MAX_BYTES } from "../summaries/transcript-appendix.ts";

/**
 * The yt-dlp format selector for a frames download.
 *
 * What it GUARANTEES, in every tier: a VIDEO-ONLY rendition at most 720 tall.
 * Video-only is the point — the transcript comes from huginn's caption API, so
 * this download exists solely to be decoded into JPEGs, and every byte of audio
 * in it would be paid for and thrown away. `bv` is also what keeps the fallback
 * honest: `b` (a muxed stream) at `height<=720` exists on most uploads but is
 * strictly larger, and the shared `YTDLP_FORMAT_SELECTOR` in
 * `src/video/media.ts` cannot express "no audio" at all. There is deliberately
 * NO uncapped tail: an upload with no ≤720p video-only rendition degrades to a
 * transcript-only capture rather than pulling 1080p to scale it down.
 *
 * What it PREFERS, tier by tier, each dropping one preference:
 *
 *  1. `[ext=mp4][vcodec^=avc1]` — H.264 in mp4, the cheapest thing ffmpeg can
 *     seek into, and the codec every hardware decoder has.
 *  2. `[ext=mp4]` — an mp4 in whatever codec YouTube offers (AV1, VP9).
 *  3. bare `[height<=720]` — any container, for an upload whose only ≤720p
 *     video-only rendition is WebM.
 *
 * **The codec tier is the fix, and mp4 alone was not it:** mp4 is a CONTAINER.
 * Measured on `SkVqJ1SGeL0`, `bv[height<=720][ext=mp4]` resolved to format 398
 * (`av01`) on a video that also offered 136 (`avc1`) — so every one of the ~36
 * ffmpeg seeks paid for an AV1 decode, which on this laptop has no hardware
 * path. The preference is a preference: tiers 2 and 3 drop it, so a video with
 * no H.264 rendition still gets frames.
 *
 * The `720` is `CAPTURE_FRAME_HEIGHT` spelled out: this module imports nothing
 * by design (see the file header), and the seam's constant is what the
 * extractor actually scales to.
 */
export const YOUTUBE_FRAME_FORMAT_SELECTOR =
  "bv[height<=720][ext=mp4][vcodec^=avc1]/bv[height<=720][ext=mp4]/bv[height<=720]";

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
 * A DURATION cut, and the reason is what a short video IS, not what the budget
 * would spend on it: nothing under a minute is a slide deck. A clip's
 * transcript already says everything, and the frames would be a talking head.
 *
 * Note the density it admits rather than refuses: `frameBudgetFor` hands out 15
 * ticks up to 60 s and **25** up to 180 s, so the cut sits immediately below its
 * DENSEST sampling — a 61 s video, the shortest this admits, is measured at 25
 * frames, one every ~2.4 s. That is deliberate (a two-minute conference
 * lightning talk does have slides) and it is why the cut is stated as an
 * editorial rule rather than as a spend bound.
 */
export const YOUTUBE_FRAMES_MIN_DURATION_SEC = 60;

/**
 * The transcript cap, under its old name.
 *
 * The constant, the two cappers and the `## Transcript` append moved to the
 * source-neutral `src/summaries/transcript-appendix.ts` when the short-video
 * verticals became a second caller (`src/video/` may not import `src/youtube/`).
 * Re-exported here under the spelling every existing importer already uses.
 */
export const YOUTUBE_TRANSCRIPT_MAX_BYTES = TRANSCRIPT_MAX_BYTES;

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
 * comes down in 8.6 s against the 430.5 s this gives it. It bounds a HANG;
 * nothing waits on the job.
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
 * The truncation note, re-exported so every existing importer of this module
 * keeps its import: it moved to the dependency-free
 * `src/summaries/truncation.ts` when the stored prompt snapshot became a second
 * caller (`src/db` may not import a vertical).
 */
export { TRANSCRIPT_TRUNCATION_NOTE } from "../summaries/truncation.ts";

/**
 * The transcript cappers and the `## Transcript` append, re-exported.
 *
 * They live in `src/summaries/transcript-appendix.ts` now — source-neutral,
 * because the short-video verticals file their whisper transcript the same way
 * and a vertical never imports another vertical. Every importer of this module
 * keeps its import.
 */
export {
  appendTranscriptSection,
  capFlatTranscript,
  capTranscriptWindows,
  type CappedTranscript,
} from "../summaries/transcript-appendix.ts";
