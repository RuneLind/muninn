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

/** The line a truncated transcript ends on, so a reader never takes the cut for the end of the talk. */
export const TRANSCRIPT_TRUNCATION_NOTE =
  "_(transcript truncated — the talk continues past this point.)_";

/** What {@link capTranscriptWindows} did, in the two numbers a caller can log. */
export interface CappedTranscript {
  readonly text: string;
  readonly truncated: boolean;
  /** UTF-8 bytes of the transcript handed in. */
  readonly inputBytes: number;
  /**
   * UTF-8 bytes of {@link text}, the note included. Never above `maxBytes`
   * EXCEPT in the note-alone band: a budget too small for even the heading
   * answers with the note by itself, and the note is ~65 bytes.
   */
  readonly keptBytes: number;
}

/**
 * The longest prefix of `text` that fits in `maxBytes`, cut at a boundary a
 * reader can see and never inside a code point.
 *
 * **The window shape this has to survive is TWO lines**, not many:
 * huginn's `format_transcript_windows` emits `### [HH:MM:SS]\n<the window's
 * 120 s of speech as ONE unbroken line>`. So a cut taken at the last NEWLINE
 * finds only the newline under the heading, and the "head of the first window"
 * comes out as a timestamp with nothing beneath it — inert on the exact input
 * this function exists for. The rule is therefore:
 *
 *  - **A newline PAST the heading** ⇒ cut there, so no half-line survives. This
 *    is the many-line case (a whisper transcript, a hand-written fixture).
 *  - **Otherwise** ⇒ cut at the last SPACE inside the budget, keeping the
 *    heading line, so no half-WORD survives.
 *  - **No space either** — a CJK run has neither — ⇒ the byte cut stands, and
 *    the U+FFFD trim below is the only thing between it and a `�` in the stored
 *    document. That trim is load-bearing exactly here.
 *
 * Byte-safe by construction: the slice is decoded, and a multi-byte sequence
 * cut in half decodes to a single trailing U+FFFD, which is dropped.
 *
 * Returns `""` when the budget did not even reach the end of the transcript's
 * FIRST line — that line is the `### [HH:MM:SS]` heading, and a fragment of a
 * timestamp is not a head of the talk. The caller answers with the note alone.
 */
function headWithinBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const sliced = new TextDecoder().decode(new TextEncoder().encode(text).slice(0, maxBytes));
  const head = sliced.endsWith("�") ? sliced.slice(0, -1) : sliced;
  const firstNewline = head.indexOf("\n");
  if (firstNewline === -1 && text.includes("\n")) return "";
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline > firstNewline) return head.slice(0, lastNewline).trimEnd();
  const lastSpace = head.lastIndexOf(" ");
  return (lastSpace > firstNewline ? head.slice(0, lastSpace) : head).trimEnd();
}

/**
 * The windowed transcript, trimmed to `maxBytes` at a WINDOW boundary.
 *
 * At a boundary rather than at a byte, because the windows are the contract: a
 * cut mid-window leaves a `### [HH:MM:SS]` heading over half a sentence, and
 * huginn's heading splitter would carry that timestamp into a chunk that ends
 * mid-word. A transcript over the cap keeps as many whole windows as fit and
 * says so in the text.
 *
 * Two things the first cut of this got wrong, both stated because they are
 * invisible until a real 3-hour talk arrives:
 *
 *  - **The note's bytes come out of the budget.** It is part of what is
 *    returned, so a budget that ignores it hands the caller a string over the
 *    cap it asked for — and the cap exists to keep the ingest body under
 *    huginn's own bound.
 *  - **A first window over the cap keeps a HEAD of it, never the note alone.**
 *    huginn windows at 120 s, but nothing guarantees the first window fits an
 *    arbitrary `maxBytes`, and answering with only the truncation note is a
 *    document that says a talk exists and nothing about it. The head keeps the
 *    `### [HH:MM:SS]` heading and cuts at the last boundary a reader can see
 *    ({@link headWithinBytes} — a line where the window has more than one, a
 *    word where it does not, which is huginn's real shape).
 *
 * **A truncated answer ALWAYS carries the note.** Below roughly a hundred bytes
 * not even the heading fits, and there the note is what goes, alone — a head
 * with no note is a fragment of a three-hour talk that reads as the whole of
 * it, which is what this returned before. The note may then be longer than
 * `maxBytes`: the cap bounds a transcript, and at that budget there is no
 * transcript left to bound. Every budget that fits any of the talk at all keeps
 * the result inside the cap.
 *
 * Pure. `truncated` and the byte counts are returned so a caller can say so —
 * `summarizeVideo` warns with them; without a consumer, a talk whose second
 * half never reached the document was invisible outside the stored file.
 */
export function capTranscriptWindows(
  transcript: string,
  maxBytes: number = YOUTUBE_TRANSCRIPT_MAX_BYTES,
): CappedTranscript {
  const encoder = new TextEncoder();
  const inputBytes = encoder.encode(transcript).length;
  if (inputBytes <= maxBytes) {
    return { text: transcript, truncated: false, inputBytes, keptBytes: inputBytes };
  }

  // The note plus the `\n\n` it is joined on is reserved up front.
  const noteBytes = encoder.encode(TRANSCRIPT_TRUNCATION_NOTE).length + 2;
  const budget = maxBytes - noteBytes;

  const windows = transcript.split("\n\n");
  const kept: string[] = [];
  let bytes = 0;
  for (const w of windows) {
    // The separator is only paid for from the second window on.
    const size = encoder.encode(w).length + (kept.length === 0 ? 0 : 2);
    if (bytes + size > budget) break;
    kept.push(w);
    bytes += size;
  }

  // Not one whole window fits: keep a head of the first one instead. With no
  // room even for its heading, the note is what goes — alone, because a head
  // with no note reads as a complete transcript.
  const body = kept.length > 0 ? kept.join("\n\n") : headWithinBytes(transcript, budget);
  const text = body === "" ? TRANSCRIPT_TRUNCATION_NOTE : `${body}\n\n${TRANSCRIPT_TRUNCATION_NOTE}`;
  return { text, truncated: true, inputBytes, keptBytes: encoder.encode(text).length };
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
 * Only the INGEST body carries it: `completeJob`, the shelf card's text and the
 * source-page draft all get the summary alone. ⚠️ The `similar` list is NOT in
 * that group — huginn computes it from `result["summary"][:2000]`, i.e. from
 * the string this function returns, so a summary under 2 000 characters lets
 * the first transcript window into the similarity query (huginn
 * `main/ingest/registry.py`). It is a query, not stored content; the
 * `transcript_markdown` follow-up retires it.
 *
 * Returns what the cap did, so the caller can warn when a talk did not fit. The
 * byte counts describe the TRANSCRIPT (in, and what survived the cap) — not
 * `text`, which is the summary and the heading on top of it.
 */
export function appendTranscriptSection(
  summary: string,
  transcript: string,
  maxBytes: number = YOUTUBE_TRANSCRIPT_MAX_BYTES,
): CappedTranscript {
  const capped = capTranscriptWindows(transcript, maxBytes);
  return { ...capped, text: `${summary.trimEnd()}\n\n## Transcript\n\n${capped.text}\n` };
}
