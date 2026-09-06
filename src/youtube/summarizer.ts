import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, unlink } from "node:fs/promises";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { getLog } from "../logging.ts";
import { VALID_CATEGORIES, parseSummaryResponse } from "../utils/summary-parser.ts";
import { buildSummarySystemPrompt, ingestSummary, runCaptureOneShot } from "../summaries/summarizer-shared.ts";
import { triggerSourceDraftFromCapture } from "../gardener/source-drafter-run.ts";
import { connectorCapabilities } from "../ai/one-shot.ts";
import {
  YOUTUBE_FRAME_SOURCE,
  extractCadenceFramesFromFile,
  framesPromptSection,
  keepReferencedFrames,
  type CaptureFrame,
} from "../summaries/frames.ts";
import {
  downloadVideo as realDownloadVideo,
  probeVideoInfo as realProbeVideoInfo,
  summarizeTimeoutFor,
  type DownloadOptions,
  type DownloadResult,
  type YtDlpInfo,
} from "../video/media.ts";
import {
  YOUTUBE_FRAMES_MAX_DURATION_SEC,
  YOUTUBE_FRAME_FORMAT_SELECTOR,
  YOUTUBE_FRAME_HEIGHT,
  YOUTUBE_SUMMARIZE_TIMEOUT_MS,
  appendTranscriptSection,
  decideYouTubeFrames,
  transcriptUrl,
  youtubeDownloadTimeoutFor,
  youtubeWatchUrl,
  type YouTubeFramesReason,
} from "./frames.ts";
import {
  attachRun,
  updateStatus,
  appendText,
  setCategory,
  setSimilar,
  completeJob,
  failJob,
} from "./state.ts";

const log = getLog("youtube", "summarizer");

const SUMMARIZE_SYSTEM_PROMPT = buildSummarySystemPrompt(
  "You are a video content analyst. Summarize the following YouTube video transcript.",
  VALID_CATEGORIES,
);

/**
 * The rider added when the transcript came back WINDOWED (`?timestamps=1`, the
 * frames path). Copied from the Vimeo prompt verbatim, because the shape is the
 * same one huginn emits for both: a slide can only be placed beside its passage
 * if the model knows the headings are positions.
 */
const WINDOWED_TRANSCRIPT_RIDER =
  "\n\nThe transcript is grouped into windows, each opened by a `### [HH:MM:SS]` heading " +
  "carrying its absolute position in the video; those headings are positions, not content — " +
  "never quote one as if it were speech.";

/** Told once, on a SUCCESSFUL ingest, with huginn's stored doc id — the Vimeo hook. */
export type YouTubeIngestedHook = (videoId: string, documentId: string) => void;

/**
 * What the trace records about this capture's slides: every DECISION
 * `decideYouTubeFrames` can reach, plus the one outcome it cannot — a pass that
 * was decided `on` and then threw (yt-dlp rot, a download timeout, an ffmpeg
 * error). Kept apart from `off`, which means the reader never asked.
 */
type FramesOutcome = YouTubeFramesReason | "failed";

export interface YouTubeSummarizerDeps {
  /** yt-dlp metadata probe — the duration everything on the frames path is sized from. */
  probeVideoInfo: (url: string, opts: { timeoutMs?: number }) => Promise<YtDlpInfo | null>;
  downloadVideo: (url: string, workDir: string, opts: DownloadOptions) => Promise<DownloadResult>;
  /** One JPEG per cadence tick out of the downloaded file. */
  extractFrames: (input: {
    file: string;
    durationSec: number;
    outDir: string;
  }) => Promise<CaptureFrame[]>;
  /** Where quoted frames are kept (test seam); default `framesRootDir()`. */
  framesRoot?: string;
}

const REAL_DEPS: YouTubeSummarizerDeps = {
  probeVideoInfo: (url, opts) => realProbeVideoInfo(url, opts),
  downloadVideo: (url, workDir, opts) => realDownloadVideo(url, workDir, opts),
  extractFrames: ({ file, durationSec, outDir }) =>
    extractCadenceFramesFromFile(file, durationSec, outDir, { height: YOUTUBE_FRAME_HEIGHT }),
};

export interface SummarizeVideoOptions {
  /**
   * Slides on: probe, download a ≤720p video-only rendition, pull one frame per
   * cadence tick and hand them to the model via `extraDirs` (v2 PR 2). Off by
   * default, so every existing caller is byte-identical. The ROUTE pre-flights
   * the connector's `supportsExtraDirs` and 503s before a job exists, so a job
   * arriving here with `frames: true` runs on a connector that can read files —
   * `decideYouTubeFrames` re-checks it anyway, as a second line.
   */
  frames?: boolean;
  /** Told when huginn has stored a document, BEFORE `completeJob`. */
  onIngested?: YouTubeIngestedHook;
  /** Test seams; production passes none. */
  deps?: Partial<YouTubeSummarizerDeps>;
}

/**
 * Run one YouTube capture: transcript → (frames) → summarize → ingest →
 * source-draft.
 *
 * With `frames` off this is the capture that has always run, plus one status
 * enum and one prompt that is byte-identical. With frames on it opens with a
 * yt-dlp PROBE, because nothing else in the process knows how long the video is
 * — not the route, not the job, not huginn's transcript endpoint — and the
 * duration is what the 3 h cap, the frame budget, the download budget and the
 * summarize budget are all sized from. `downloadVideo`'s own `--print-json`
 * line arrives after the download it would have to bound.
 *
 * Every frames failure — a probe that says nothing, a live stream, yt-dlp rot,
 * an ffmpeg error — is a WARN plus today's transcript-only capture, never a
 * failed job (the TikTok precedent). The outcome rides the trace as `frames`.
 */
export async function summarizeVideo(
  jobId: string,
  videoId: string,
  title: string,
  url: string,
  config: Config,
  botConfig: BotConfig,
  opts: SummarizeVideoOptions = {},
): Promise<void> {
  const resolved: YouTubeSummarizerDeps = { ...REAL_DEPS, ...opts.deps };
  // Created only on the frames path, removed in the `finally` whatever
  // happened — AFTER the quoted frames have been copied out.
  const workDir = join(tmpdir(), `muninn-youtube-${jobId}`);
  let frames: CaptureFrame[] = [];

  try {
    // 0. The frames pre-flight, BEFORE the transcript, because its answer
    //    decides which transcript is asked for: `?timestamps=1` is the windowed
    //    form a slide can be placed against (huginn #129), and asking for it
    //    unconditionally would change every frames-off capture's prompt.
    let framesOutcome: FramesOutcome = "off";
    let durationSec = 0;
    if (opts.frames === true) {
      // The yt-dlp target is derived from the VIDEO ID, never from the caller's
      // `url`: this route is CORS-`*` with `MUNINN_AUTH=off` and the origin
      // check is mounted only in authenticating modes, so a client-supplied URL
      // here would let any page spawn yt-dlp against an arbitrary host.
      const probe = await resolved.probeVideoInfo(youtubeWatchUrl(videoId), {});
      durationSec = probe?.duration ?? 0;
      framesOutcome = decideYouTubeFrames({
        framesRequested: true,
        supportsExtraDirs: connectorCapabilities(botConfig).supportsExtraDirs,
        durationSec: probe === null ? null : probe.duration,
      }).reason;
      if (framesOutcome !== "on") {
        log.warn("YouTube capture {jobId}: slides skipped ({reason}, duration {durationSec}s) — transcript only", {
          jobId,
          videoId,
          reason: framesOutcome,
          durationSec,
        });
      }
    }
    // What the TRANSCRIPT is: windowed exactly when the frames pass will run.
    // A frames pass that then FAILS keeps the windowed transcript — it is a
    // better document either way, and re-fetching the plain form to undo a
    // decision would be a second round-trip for a worse result.
    const timestamped = framesOutcome === "on";

    // 1. Fetch transcript
    updateStatus(jobId, "fetching_transcript");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let transcriptText: string;
    try {
      const res = await fetch(transcriptUrl(config.knowledgeApiUrl, videoId, timestamped), {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        failJob(jobId, `Transcript API returned ${res.status}`);
        return;
      }
      const data = await res.json() as { transcript?: string };
      transcriptText = data.transcript ?? "";
      if (!transcriptText) {
        failJob(jobId, "Empty transcript returned");
        return;
      }
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      failJob(jobId, `Failed to fetch transcript: ${msg}`);
      return;
    }

    log.info("Fetched transcript for {videoId}, {length} chars (windowed: {timestamped})", {
      videoId,
      length: transcriptText.length,
      timestamped,
    });

    // 1b. Frames: download the ≤720p video-only rendition, pull one JPEG per
    //     cadence tick, and unlink the video the moment ffmpeg is done with it
    //     — it must not sit on disk through a ten-minute model turn.
    if (framesOutcome === "on") {
      try {
        updateStatus(jobId, "downloading");
        const dl = await resolved.downloadVideo(youtubeWatchUrl(videoId), workDir, {
          // The cap is enforced a SECOND time here, by yt-dlp's own
          // `--break-match-filters` (exit 101): the probe above sized this
          // capture, and a video that grew between the two calls — a stream
          // that ended, a re-upload — must not be downloaded past the cap.
          maxDurationSeconds: YOUTUBE_FRAMES_MAX_DURATION_SEC,
          timeoutMs: youtubeDownloadTimeoutFor(durationSec),
          format: YOUTUBE_FRAME_FORMAT_SELECTOR,
        });
        updateStatus(jobId, "extracting_frames");
        try {
          frames = await resolved.extractFrames({
            file: dl.videoPath,
            durationSec,
            outDir: join(workDir, "frames"),
          });
        } finally {
          // Whether the pass succeeded or threw: the model is handed `workDir`
          // as `--add-dir`, and a 90 MB mp4 sitting in it is bytes the turn can
          // read and nothing wants it to.
          await unlink(dl.videoPath).catch(() => {});
        }
        log.info("YouTube capture {jobId}: {n} cadence frames extracted from a {durationSec}s video", {
          jobId,
          n: frames.length,
          durationSec,
        });
      } catch (err) {
        framesOutcome = "failed";
        frames = [];
        log.warn("YouTube capture {jobId}: frames failed — transcript only: {error}", {
          jobId,
          videoId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2. Summarize with Claude
    updateStatus(jobId, "summarizing");

    const systemPrompt = `${SUMMARIZE_SYSTEM_PROMPT}${timestamped ? WINDOWED_TRANSCRIPT_RIDER : ""}

Video title: ${title}
Video URL: ${url}`;

    const onProgress: StreamProgressCallback = (event) => {
      if (event.type === "text_delta") {
        appendText(jobId, event.text);
      }
    };

    const result = await runCaptureOneShot({
      source: "youtube",
      jobId,
      title,
      url,
      // The frame list rides the USER prompt after the transcript (the TikTok
      // and Vimeo shape); with no frames it contributes "" and the prompt is
      // byte-identical to the one that shipped before this PR.
      prompt: transcriptText + framesPromptSection(YOUTUBE_FRAME_SOURCE, videoId, frames),
      systemPrompt,
      config,
      botConfig,
      attachRun,
      onProgress,
      // `--add-dir` only when there is something to read: an empty extraDirs
      // would still flip the connector's file-access mode for nothing.
      ...(frames.length > 0 ? { extraDirs: [workDir] } : {}),
      timeoutMs: summarizeTimeoutFor(frames.length, YOUTUBE_SUMMARIZE_TIMEOUT_MS),
      // Frame reading IS the reasoning, so the 8k capture cap is opted out of
      // exactly where TikTok opts out of it. A transcript-only capture keeps it.
      ...(frames.length > 0 ? { thinkingMaxTokens: null } : {}),
      extraTraceAttrs: {
        frames: framesOutcome,
        frameCount: String(frames.length),
        transcriptWindows: String(timestamped),
      },
    });

    // 3. Parse response
    const { category, summary } = parseSummaryResponse(result.result);
    setCategory(jobId, category);

    // The frames the summary QUOTES are copied out of the work dir to the
    // served root before the work dir dies; the rest go with it. Inside its own
    // try: a copy failure must not fail a capture whose text is already on the
    // reader's screen.
    let keptFrames: number[] = [];
    if (frames.length > 0) {
      try {
        keptFrames = await keepReferencedFrames(summary, YOUTUBE_FRAME_SOURCE, videoId, frames, resolved.framesRoot);
      } catch (err) {
        log.error("YouTube capture {jobId}: keeping quoted frames failed: {error}", {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info("Summarized {videoId}: category={category}, {tokens} output tokens, {frames} frames read, {kept} quoted", {
      videoId,
      category,
      tokens: result.outputTokens,
      frames: frames.length,
      kept: keptFrames.length,
    });

    // 4. Ingest into knowledge base (best-effort)
    updateStatus(jobId, "ingesting");

    // Capture huginn's stored doc id (`file_path` = <category>/<title-slug>.md) so
    // the source-draft trigger below keys off the SAME id the run-now drafter uses
    // (`newest.id`) — otherwise a run-now click on a just-auto-drafted video would
    // mint a duplicate proposal under a different topic_key.
    let ingestedDocId: string | undefined;
    await ingestSummary({
      knowledgeApiUrl: config.knowledgeApiUrl,
      ingestPath: "/api/youtube/ingest",
      body: {
        title,
        url,
        // The windowed transcript rides the SUMMARY string, and only on the
        // frames path — huginn's YouTube ingest has no `transcript_markdown`
        // field, so the summary IS the document body. See
        // `appendTranscriptSection`; everything else below gets the summary
        // alone.
        summary: timestamped ? appendTranscriptSection(summary, transcriptText) : summary,
        category,
        date: new Date().toISOString().split("T")[0],
      },
      onSimilar: (similar) => setSimilar(jobId, similar),
      onIngested: (info) => {
        ingestedDocId = info.filePath;
      },
    });

    // Tell the caller a document now exists, BEFORE `completeJob` — the job
    // event is what a client reacts to, and a re-POST racing that event must
    // find the claim already recorded. Its own try/catch for the same reason
    // the source-draft trigger has one: a throw in a caller's hook must not
    // turn a finished capture into an error.
    if (ingestedDocId && opts.onIngested) {
      try {
        opts.onIngested(videoId, ingestedDocId);
      } catch (err) {
        log.error("YouTube onIngested hook threw for job {jobId} (the capture stands): {error}", {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 5. Complete
    completeJob(jobId, summary, category);

    // 6. Fire-and-forget: draft a per-article source page from this summary
    //    IN-PROCESS (no huginn re-fetch — ingest above is best-effort and indexing
    //    may lag). Skips silently when the summarizer bot has no wikiDir; any
    //    failure is swallowed inside the trigger and never touches the capture job.
    //    Prefer huginn's stored doc id (identical to the run-now drafter's docId);
    //    fall back to videoId only when the ingest returned no file_path (older
    //    huginn / failed ingest — in which case the doc isn't listed anyway, so
    //    run-now can't draft a colliding duplicate).
    triggerSourceDraftFromCapture(botConfig, {
      collection: "youtube-summaries",
      docId: ingestedDocId ?? videoId,
      url,
      body: summary,
      sourceTitle: title,
      category,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("YouTube summarization failed for job {jobId}: {error}", { jobId, error: msg });
    failJob(jobId, msg);
  } finally {
    // The downloaded video (already unlinked on the success path) and the
    // frames the summary did not quote. Only ever created by this job, under a
    // name only this job uses; an rm of a dir that was never made is a no-op.
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
