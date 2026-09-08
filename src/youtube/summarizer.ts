import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, unlink } from "node:fs/promises";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { getLog } from "../logging.ts";
import { VALID_CATEGORIES, parseSummaryResponse } from "../utils/summary-parser.ts";
import type { Tracer } from "../tracing/tracer.ts";
import {
  CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS,
  CAPTURE_THINKING_MAX_TOKENS,
  buildSummarySystemPrompt,
  createCaptureTracer,
  ingestSummary,
  runCaptureOneShot,
  windowedTranscriptRider,
} from "../summaries/summarizer-shared.ts";
import {
  captureBotConfigFor,
  captureThinkingFor,
  type CapturePreset,
} from "../summaries/presets.ts";
import { triggerSourceDraftFromCapture } from "../gardener/source-drafter-run.ts";
import { connectorCapabilities } from "../ai/one-shot.ts";
import { createQueue } from "../wiki/queue.ts";
import {
  CAPTURE_FRAME_HEIGHT,
  YOUTUBE_FRAME_SOURCE,
  extractCadenceFramesFromFile,
  framesPromptSection,
  keepReferencedFrames,
  type CaptureFrame,
} from "../summaries/frames.ts";
import {
  DEFAULT_VISUAL_DETAIL,
  dropFrameReferences,
  enforceVisualReferences,
  visualDetailCaps,
  visualDetailPolicy,
  type VisualDetail,
} from "../summaries/visual-detail.ts";
import {
  SELECTION_SYSTEM_PROMPT,
  capScanCandidates,
  dedupeScanSamples,
  parseSelectionManifest,
  resolveFrameScanMode,
  scanTimeoutFor,
  selectionLimitFor,
  selectionPrompt,
  selectionTimeoutFor,
  splitTwoPassBudget,
  twoPassBudgetFor,
  YOUTUBE_FRAME_SCAN_ENV,
  type ContactSheetPlan,
  type ScanCandidate,
  type SelectionEntry,
} from "./scan.ts";
import {
  buildContactSheets as realBuildContactSheets,
  regrabFrames as realRegrabFrames,
  runDenseScan as realRunDenseScan,
  type DenseScanResult,
} from "./scan-run.ts";
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
  YOUTUBE_TRANSCRIPT_MAX_BYTES,
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

const SUMMARIZE_INTRO =
  "You are a video content analyst. Summarize the following YouTube video transcript.";

/**
 * The rider added when huginn ANSWERED with a windowed transcript. The sentence
 * is the seam's, shared with the Vimeo prompt (which says "talk"): a slide can
 * only be placed beside its passage if the model knows the headings are
 * positions.
 */
const WINDOWED_TRANSCRIPT_RIDER = `\n\n${windowedTranscriptRider("video")}`;

/**
 * ONE yt-dlp download and one ffmpeg pass at a time, process-wide.
 *
 * N POSTs of N DISTINCT videos are N legitimate captures — the route's dedup
 * only holds back a second capture of the SAME video — but they must not be N
 * concurrent 50 MiB downloads and N ffmpeg fan-outs on a laptop also running
 * the dev server, the bots and huginn. A queue rather than a try-lock, for the
 * Vimeo harvest's reason: neither capture may be dropped, so the second waits
 * and then runs with its own budget.
 *
 * The section is entered TWICE and never held across the transcript fetch: the
 * probe decides which transcript to ask for, so a single section spanning both
 * would serialize a 30 s network wait that spends no CPU and no disk. What the
 * key guarantees is what it is for — one yt-dlp / ffmpeg at a time.
 */
const framesQueue = createQueue();
const FRAMES_QUEUE_KEY = "youtube-frames";

/** Told once, on a SUCCESSFUL ingest, with huginn's stored doc id — the Vimeo hook. */
export type YouTubeIngestedHook = (videoId: string, documentId: string) => void;

/**
 * What the trace records about this capture's slides: every DECISION
 * `decideYouTubeFrames` can reach, plus the one outcome it cannot — a pass that
 * was decided `on` and then threw (yt-dlp rot, a download timeout, an ffmpeg
 * error). Kept apart from `off`, which means the reader never asked.
 */
type FramesOutcome = YouTubeFramesReason | "failed";

/**
 * WHICH sampler produced this capture's frames, and where a dense attempt gave
 * up. Stamped on the trace as `frameScan` beside `frames`, and the reason the
 * two are separate: `frames: on` says the reader asked and the video was usable,
 * this says what was actually done with it.
 */
export type YouTubeScanOutcome =
  /** No frames at all — the reader did not ask, or the pre-flight said no. */
  | "off"
  /** The cadence extractor ran, because the switch says so. */
  | "cadence"
  /** The dense scan, the selection pass and the re-grab all ran. */
  | "dense"
  /**
   * Slides were asked for and the frames path threw before any sampler produced
   * a frame — the download, the work dirs, or the fallback extractor itself.
   * Kept apart from `off`, which means the reader never asked.
   */
  | "prep_failed"
  /** The scan itself failed (ffmpeg, the timeout) — cadence ran on the same download. */
  | "scan_failed"
  /** The scan worked and the TILING did not — cadence ran on the same download. */
  | "sheets_failed"
  /** The selection pass threw or answered nothing parseable — cadence ran on the same download. */
  | "selection_failed"
  /**
   * The selection pass answered an EMPTY manifest — it read the sheets and
   * chose nothing. Not a failure and not a fallback (there is nothing the
   * cadence sampler would know that this pass did not), but never `dense`
   * either: a slides capture that ships no slides is a zero-slide outcome and
   * says so, here and in a warn.
   */
  | "selection_empty"
  /** The re-grab of the selected seconds failed — cadence ran on the same download. */
  | "regrab_failed";

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
  /** One decode pass over the whole file — 320 px thumbnails plus a dedup signature each. */
  scanVideo: (input: { file: string; scanDir: string; timeoutMs: number }) => Promise<DenseScanResult>;
  /** The tiled JPEGs the selection pass reads. */
  buildSheets: (input: {
    candidates: readonly ScanCandidate[];
    thumbPathFor: (tSeconds: number) => string;
    outDir: string;
    scratchDir: string;
    timeoutMs: number;
  }) => Promise<ContactSheetPlan[]>;
  /** The selected seconds, re-grabbed at full frame height out of the still-present video. */
  regrabFrames: (input: {
    file: string;
    seconds: readonly number[];
    outDir: string;
    height: number;
  }) => Promise<CaptureFrame[]>;
  /** Where quoted frames are kept (test seam); default `framesRootDir()`. */
  framesRoot?: string;
  /**
   * Fire the per-article source-page drafter on a successful capture. Default
   * ON — the route never passes it.
   *
   * It sits in `deps` rather than beside `frames`/`preset` because it is not a
   * property of the capture: `false` is the replay harness
   * (`scripts/replay-youtube.ts`), which re-runs real captures against a stub
   * huginn to compare kinds, where a draft proposal per run would be N
   * proposals in the summarizer bot's wiki gate about a document that was never
   * ingested.
   */
  sourceDraft?: boolean;
}

const REAL_DEPS: YouTubeSummarizerDeps = {
  probeVideoInfo: (url, opts) => realProbeVideoInfo(url, opts),
  downloadVideo: (url, workDir, opts) => realDownloadVideo(url, workDir, opts),
  extractFrames: ({ file, durationSec, outDir }) =>
    extractCadenceFramesFromFile(file, durationSec, outDir, { height: CAPTURE_FRAME_HEIGHT }),
  scanVideo: (input) => realRunDenseScan(input),
  buildSheets: (input) => realBuildContactSheets(input),
  regrabFrames: (input) => realRegrabFrames(input),
};

/**
 * Label each re-grabbed frame with what the selection pass said it is.
 *
 * `<category>: <reason>`, or the category alone where the pass gave no reason —
 * a bare colon reads as a truncated sentence. A frame with no matching entry
 * keeps no note at all rather than an empty one, so the prompt line is exactly
 * what it was before notes existed.
 */
function attachSelectionNotes(
  frames: readonly CaptureFrame[],
  selection: readonly SelectionEntry[],
): CaptureFrame[] {
  const bySecond = new Map(selection.map((e) => [e.tSeconds, e] as const));
  return frames.map((frame) => {
    const entry = bySecond.get(frame.tSeconds);
    if (entry === undefined) return frame;
    const note = entry.reason === "" ? entry.category : `${entry.category}: ${entry.reason}`;
    return { ...frame, note };
  });
}

/**
 * A two-pass capture whose SELECTION pass left too little of the stated budget
 * for the summary call to finish inside it.
 *
 * Its own class because it is the one frames-path failure that must NOT degrade
 * to a transcript-only capture: nothing here can abort an in-flight connector
 * call (`executeOneShot` takes a `timeoutMs` and no signal), so a deadline is
 * arithmetic — and a job that quietly ran a second model call past the budget it
 * announced is exactly what the gate exists to make visible. Both frames catches
 * re-throw it.
 */
class TwoPassBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwoPassBudgetError";
  }
}

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
  /**
   * The summary KIND this capture writes, resolved by the ROUTE against the
   * summarizer bot's preset set (`findCapturePreset` — an unknown id is a 400
   * there, so a job that gets here carries a real preset).
   *
   * REQUIRED, the Vimeo precedent: a default here would be `standard` picked
   * positionally out of `SHIPPED_CAPTURE_PRESETS`, so reordering that array
   * would silently change what a caller who named no kind gets. Every caller —
   * the route, the replay harness, the tests — resolves a preset already.
   *
   * It decides three things: the structure bullets in the system prompt, the
   * model the call runs on (`captureBotConfigFor`) and whether the 8k capture
   * thinking cap applies (`captureThinkingFor`).
   */
  preset: CapturePreset;
  /**
   * How much of the video the summary may SHOW — the reader's Selected/Detailed
   * choice, consulted only where slides actually ran.
   *
   * Optional where `preset` is required, and the difference is real rather than
   * inconsistent: a missing preset would be `standard` picked POSITIONALLY out
   * of `SHIPPED_CAPTURE_PRESETS`, so reordering that array would change what a
   * caller who named nothing gets, while a missing policy is the NAMED constant
   * {@link DEFAULT_VISUAL_DETAIL} and cannot move under anyone. The route
   * validates the body and always passes one.
   */
  visualDetail?: VisualDetail;
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
 *
 * **With `YOUTUBE_FRAME_SCAN=dense` (the default) the frames path is TWO model
 * calls**: a dense 5 s scan of the whole video, deduped and capped into contact
 * sheets, a SELECTION pass that answers with a JSON manifest of which frames are
 * worth looking at, a re-grab of exactly those at full height, and only then the
 * summary. Both calls hang off ONE trace root and one `/agents` run, which this
 * function owns rather than the shared seam — see `parentTracer` in
 * `summarizer-shared.ts`. Every dense-stage failure below the budget gate falls
 * back to the cadence extractor on the video already on disk, so the fallback
 * costs no second download; the gate itself fails the job, because a summary
 * call that cannot finish inside the announced budget is not something to run
 * quietly.
 *
 * It takes no `url`: everything that names this video — the yt-dlp target, the
 * ingest body, the system prompt, the source draft — is built from the id the
 * route validated ({@link youtubeWatchUrl}). A caller-supplied url reached four
 * of those, and a POST naming video X with a url for video Y put Y's address on
 * X's document.
 */
export async function summarizeVideo(
  jobId: string,
  videoId: string,
  title: string,
  config: Config,
  botConfig: BotConfig,
  opts: SummarizeVideoOptions,
): Promise<void> {
  const resolved: YouTubeSummarizerDeps = { ...REAL_DEPS, ...opts.deps };
  // TWO roots, and the split is what keeps a 90 MB mp4 and 350 scan thumbnails
  // out of the model's reach.
  //
  // `workDir` is what the SUMMARY call is handed as `--add-dir`: the re-grabbed
  // (or cadence) frames, nothing else. `mediaDir` is the downloaded video, the
  // scan's intermediates and the contact sheets — one subdirectory of it goes to
  // the selection pass and the root itself is named in no `extraDirs` — the
  // video used to live in the dir the turn could read, which is why it had to be
  // unlinked the instant ffmpeg was done with it. On the dense path it cannot
  // be: the re-grab happens AFTER a model call, so the file has to survive one.
  // Putting it somewhere the model cannot see is what makes that safe. Both are
  // removed in the job's `finally`, whatever happened.
  const workDir = join(tmpdir(), `muninn-youtube-${jobId}`);
  const mediaDir = join(tmpdir(), `muninn-youtube-media-${jobId}`);
  /** Where the re-grabbed / cadence frames land — inside `workDir`, so the model reads them. */
  const framesDir = join(workDir, "frames");
  /**
   * The contact sheets, and the ONLY thing the selection pass is given.
   *
   * Under `mediaDir`, so that `workDir` — the dir the SUMMARY call is handed as
   * `--add-dir` — holds the frames and nothing else. A sheet dir inside it would
   * put ten contact sheets of a scan in front of the second pass, and in front
   * of a CADENCE fallback that was never told about a scan at all. `mediaDir`
   * itself is still named in no `extraDirs`; this one subdirectory of it is
   * handed to the selection pass alone.
   */
  const selectDir = join(mediaDir, "select");
  // The ONE url this capture states, built from the id the route validated.
  // Never the caller's `url`: a POST naming video X with a url for video Y
  // would otherwise put Y's address on X's document and make every later
  // capture of Y a `duplicate` of X (the same rule the yt-dlp target follows).
  const videoUrl = youtubeWatchUrl(videoId);
  const preset = opts.preset;
  const visualDetail = opts.visualDetail ?? DEFAULT_VISUAL_DETAIL;
  let frames: CaptureFrame[] = [];

  /**
   * The trace root of a TWO-PASS capture, owned here rather than by the shared
   * seam, and finished exactly once.
   *
   * `Tracer.finish` has no idempotence guard, so "exactly once" is enforced by
   * the closure below nulling the field: every exit path calls `finishParent`
   * and only the first one writes. It stays null on every single-pass capture —
   * frames off, cadence, and every dense attempt that fell back — where the seam
   * owns its own root as it always has.
   */
  let parentTracer: Tracer | null = null;
  const finishParent = (status: "ok" | "error", attrs: Record<string, unknown>): void => {
    const tracer = parentTracer;
    if (tracer === null) return;
    parentTracer = null;
    tracer.finish(status, attrs);
  };
  /** Both passes' spend, summed for the root's own attributes. */
  const passUsage = { inputTokens: 0, outputTokens: 0, numTurns: 0, toolCount: 0, costUsd: 0 };
  const addUsage = (r: {
    inputTokens?: number;
    outputTokens?: number;
    numTurns?: number;
    toolCalls?: unknown[];
    costUsd?: number;
  }): void => {
    passUsage.inputTokens += r.inputTokens ?? 0;
    passUsage.outputTokens += r.outputTokens ?? 0;
    passUsage.numTurns += r.numTurns ?? 0;
    passUsage.toolCount += r.toolCalls?.length ?? 0;
    passUsage.costUsd += r.costUsd ?? 0;
  };

  try {
    // 0. The frames pre-flight, BEFORE the transcript, because its answer
    //    decides which transcript is asked for: `?timestamps=1` is the windowed
    //    form a slide can be placed against (huginn #129), and asking for it
    //    unconditionally would change every frames-off capture's prompt.
    //
    //    The status moves FIRST so the card is never left at `pending` through
    //    a yt-dlp spawn and a transcript fetch. ⚠️ `fetching_transcript` is
    //    what a SECOND capture then shows for as long as the first one holds
    //    the frames queue: the probe below is inside that section (a probe is a
    //    yt-dlp process too), so its ~3 s is a wait of minutes whenever another
    //    capture is in its download. Accepted rather than labelled — the
    //    statuses this vertical has are the ones the card renders, and
    //    `downloading` here would be a false label on the transcript fetch that
    //    follows the probe.
    updateStatus(jobId, "fetching_transcript");
    let framesOutcome: FramesOutcome = "off";
    let durationSec = 0;
    if (opts.frames === true) {
      // In the frames queue: a probe is a yt-dlp process too.
      const probe = await framesQueue.run(FRAMES_QUEUE_KEY, () =>
        resolved.probeVideoInfo(videoUrl, {}),
      );
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

    // 1. Fetch transcript
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let transcriptText: string;
    /**
     * Whether the transcript came back WINDOWED — huginn's own answer, not our
     * request.
     *
     * `?timestamps=1` is asked for exactly when frames will run, but a pre-#129
     * huginn ignores the parameter and answers a plain transcript with no
     * `timestamps` key (127.0.0.1:8321 as this lands). Deriving this from the
     * frames decision put a `### [HH:MM:SS]` rider on a prompt whose transcript
     * has no headings at all, and filed a flat wall of text under
     * `## Transcript` as if it were windowed.
     *
     * It also settles the frames-FAILURE case, for free: the transcript is
     * windowed whether or not any frame came out of the video, so the section
     * and the rider stay and only the slides go away.
     */
    let timestamped = false;
    try {
      const res = await fetch(transcriptUrl(config.knowledgeApiUrl, videoId, framesOutcome === "on"), {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        failJob(jobId, `Transcript API returned ${res.status}`);
        return;
      }
      const data = await res.json() as { transcript?: string; timestamps?: boolean };
      transcriptText = data.transcript ?? "";
      timestamped = data.timestamps === true;
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

    // The model the kind asks for — `deep` swaps in `CAPTURE_DEEP_MODEL`, every
    // other kind keeps the bot's own. Resolved BEFORE `runCaptureOneShot`, which
    // is what stamps the requested model onto the `/agents` card and the trace
    // span, so an in-flight Deep run says "opus" from its first frame. Resolved
    // before the FRAMES path too, since the selection pass is a model call of
    // its own and runs on the same resolved config as the summary.
    const runBot = captureBotConfigFor(botConfig, preset);
    if (preset.run.model === "opus" && runBot === botConfig) {
      // Honest about what ran: the kind promised the bigger model and this
      // connector's namespace cannot name it. Defence only — the route resolves
      // its kind set with `requireThinkingControl`, which drops `deep` on every
      // connector that would land here.
      log.warn(
        "YouTube capture {jobId}: kind {kind} asks for the opus model, but connector {connector} keeps its own ({model})",
        {
          jobId,
          kind: preset.id,
          connector: botConfig.connector ?? "claude-cli",
          model: botConfig.model ?? "default",
        },
      );
    }

    // 1b. Frames: download the ≤720p video-only rendition, then either the
    //     cadence extractor (one JPEG per `frameBudgetFor` tick, what shipped
    //     before) or the DENSE path — a 5 s scan, a selection pass, a re-grab.
    //     The video is unlinked as soon as the last thing that needs it is done.
    /** The downloaded rendition while it is still needed; null once released. */
    let videoPath: string | null = null;
    let scanOutcome: YouTubeScanOutcome = "off";
    /** What the selection pass asked for, for the completion line and the harness. */
    let selection: SelectionEntry[] = [];
    /** Numbers only the dense path has, reported on the completion line. */
    let scanSamples = 0;
    let scanCandidates = 0;
    let scanSheets = 0;
    /** The summary call's budget. On the dense path it is what is LEFT of the whole one. */
    let synthesisTimeoutMs: number | null = null;
    if (framesOutcome === "on") {
      const scan = resolveFrameScanMode();
      if (scan.unrecognized !== null) {
        log.warn(
          "YouTube capture {jobId}: {env}=\"{value}\" is not a scan mode — falling back to the cadence sampler " +
            "(expected dense or cadence)",
          { jobId, env: YOUTUBE_FRAME_SCAN_ENV, value: scan.unrecognized },
        );
      }
      /** Set when a dense stage gave up and the cadence extractor took over. */
      let denseFallback: { stage: YouTubeScanOutcome; error: string } | null = null;

      /**
       * The cadence extractor over the already-downloaded file, releasing the
       * video afterwards. Both the plain cadence path and every dense fallback
       * end here, which is why it is a closure rather than two copies: the
       * fallback must never cost a second download.
       */
      const cadenceFrames = async (file: string): Promise<CaptureFrame[]> =>
        framesQueue.run(FRAMES_QUEUE_KEY, async () => {
          updateStatus(jobId, "extracting_frames");
          try {
            return await resolved.extractFrames({ file, durationSec, outDir: framesDir });
          } finally {
            await unlink(file).catch(() => {});
            videoPath = null;
          }
        });

      try {
        // Section 1: the download, and — on the dense path — the scan and the
        // sheets. One yt-dlp and one ffmpeg at a time, process-wide. The MODEL
        // calls are deliberately OUTSIDE every section: they spend no local CPU,
        // run for minutes, and holding the queue across one would make two
        // captures strictly serial end to end. Nothing below ever calls
        // `framesQueue.run` from inside a held section.
        const prepared = await framesQueue.run(FRAMES_QUEUE_KEY, async () => {
          updateStatus(jobId, "downloading");
          // The sibling verticals all create the work dir first. yt-dlp would
          // create its own, but everything after does not: the frames and the
          // sheets are written under `workDir`, which is what the model reads.
          await mkdir(workDir, { recursive: true });
          await mkdir(mediaDir, { recursive: true });
          const dl = await resolved.downloadVideo(videoUrl, mediaDir, {
            // The cap is enforced a SECOND time here, by yt-dlp's own
            // `--break-match-filters` (exit 101): the probe above sized this
            // capture, and a video that grew between the two calls — a stream
            // that ended, a re-upload — must not be downloaded past the cap.
            maxDurationSeconds: YOUTUBE_FRAMES_MAX_DURATION_SEC,
            timeoutMs: youtubeDownloadTimeoutFor(durationSec),
            format: YOUTUBE_FRAME_FORMAT_SELECTOR,
          });
          videoPath = dl.videoPath;
          if (scan.mode !== "dense") return null;
          updateStatus(jobId, "extracting_frames");
          // Which PREP stage is running, so a failure names the one that failed.
          // Reported as `scan_failed` with `samples=0`, a tiling error said the
          // decode produced nothing — a different diagnosis and a different fix.
          let prepStage: YouTubeScanOutcome = "scan_failed";
          try {
            const scanned = await resolved.scanVideo({
              file: dl.videoPath,
              scanDir: join(mediaDir, "scan"),
              timeoutMs: scanTimeoutFor(durationSec),
            });
            // Stamped as they become known, so a later stage's failure still
            // reports what the earlier ones really produced.
            scanSamples = scanned.samples.length;
            const candidates = capScanCandidates(
              dedupeScanSamples(scanned.signatures, scanned.samples.map((s) => s.tSeconds)),
            );
            scanCandidates = candidates.length;
            const thumbs = new Map(scanned.samples.map((s) => [s.tSeconds, s.path] as const));
            prepStage = "sheets_failed";
            const sheets = await resolved.buildSheets({
              candidates,
              thumbPathFor: (sec) => {
                const path = thumbs.get(sec);
                if (path === undefined) throw new Error(`No scan thumbnail for second ${sec}`);
                return path;
              },
              outDir: selectDir,
              scratchDir: join(mediaDir, "cells"),
              // ONE budget for every sheet, not one each: `buildContactSheets`
              // spends what is left of it per sheet.
              timeoutMs: scanTimeoutFor(durationSec),
            });
            scanSheets = sheets.length;
            return { candidates, sheets };
          } catch (err) {
            // The scan is an optimisation over the cadence sampler, not a
            // prerequisite for it — and the video is already here.
            denseFallback = {
              stage: prepStage,
              error: err instanceof Error ? err.message : String(err),
            };
            return null;
          }
        });

        if (prepared === null) {
          // Read through its declared type: the assignment happens inside the
          // closure above, which TypeScript's control flow cannot see.
          const prep = denseFallback as { stage: YouTubeScanOutcome; error: string } | null;
          frames = await cadenceFrames(videoPath!);
          scanOutcome = prep === null ? "cadence" : prep.stage;
        } else {
          // Which dense stage is in progress, so the catch below can name the
          // one that failed. Derived from a flag rather than from
          // `frames.length`, which is 0 both before the re-grab and after one
          // that threw — the two stages this has to tell apart.
          let stage: YouTubeScanOutcome = "selection_failed";
          try {
            // Pass 1: the SELECTION call. One trace root for both passes, opened
            // here because this is the first moment a second call is certain.
            parentTracer = createCaptureTracer("youtube", runBot);
            const limit = selectionLimitFor(visualDetailCaps(visualDetail).maxTotal);
            const wholeBudgetMs = twoPassBudgetFor(
              prepared.sheets.length,
              limit,
              CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS,
            );
            updateStatus(jobId, "selecting_frames");
            const startedAt = Date.now();
            const picked = await runCaptureOneShot({
              source: "youtube",
              jobId,
              title,
              url: videoUrl,
              // Not `claude`: `/models`' observed-model query and the traces
              // fast path both join on that label, and two spans under one root
              // sharing it would clobber each other in the tracer's own map.
              pass: "claude:select",
              parentTracer,
              prompt: selectionPrompt({
                title,
                durationSec,
                sheets: prepared.sheets,
                sheetDir: selectDir,
                limit,
              }),
              systemPrompt: SELECTION_SYSTEM_PROMPT,
              config,
              botConfig: runBot,
              attachRun,
              // No `onProgress`: this pass answers with JSON, and streaming it
              // into the job's text would put a manifest on the reader's card.
              // The status is the whole progress signal it has.
              //
              // The sheets and NOTHING else. The re-grabbed frames do not exist
              // yet and the video is in `mediaDir`, so this is the one call in
              // the job that cannot reach either.
              extraDirs: [selectDir],
              timeoutMs: selectionTimeoutFor(prepared.sheets.length),
              // No `thinkingMaxTokens`, i.e. the seam's 8k capture cap — even on
              // `deep`, whose full budget is for the SUMMARY. This pass ranks
              // pictures against a rubric; it is not the reasoning the kind sells.
              extraTraceAttrs: {
                summaryKind: preset.id,
                visualDetail,
                scanSamples: String(scanSamples),
                candidates: String(prepared.candidates.length),
                sheets: String(prepared.sheets.length),
                selectionLimit: String(limit),
              },
            });
            addUsage(picked);
            const manifest = parseSelectionManifest(
              picked.result,
              prepared.candidates.map((c) => c.tSeconds),
              limit,
            );
            if (manifest === null) {
              throw new Error("the selection pass answered no parseable JSON manifest");
            }
            if (manifest.dropped.length > 0 || manifest.droppedOverCap > 0) {
              log.warn(
                "YouTube capture {jobId}: the selection pass named {invalid} second(s) this scan never sampled " +
                  "({seconds}) and {overCap} past the {limit}-frame limit — dropped",
                {
                  jobId,
                  videoId,
                  invalid: manifest.dropped.length,
                  seconds: manifest.dropped.join(", "),
                  overCap: manifest.droppedOverCap,
                  limit,
                },
              );
            }
            selection = manifest.entries;
            log.info(
              "YouTube capture {jobId}: selection pass chose {n} of {candidates} candidates " +
                "(model={model}, {inputTokens} in / {outputTokens} out, {toolCount} reads, {elapsedMs}ms)",
              {
                jobId,
                event: "selection_complete",
                videoId,
                n: selection.length,
                candidates: prepared.candidates.length,
                sheets: prepared.sheets.length,
                scanSamples,
                model: picked.model ?? "unknown",
                inputTokens: picked.inputTokens,
                outputTokens: picked.outputTokens,
                costUsd: picked.costUsd ?? 0,
                numTurns: picked.numTurns ?? 0,
                toolCount: picked.toolCalls?.length ?? 0,
                elapsedMs: Date.now() - startedAt,
                selectedSeconds: selection.map((e) => e.tSeconds).join(","),
                manifest: JSON.stringify(selection),
              },
            );

            if (selection.length === 0) {
              // Not a failure — the pass read the sheets and answered — but a
              // slides capture that ships no slides is a zero-slide outcome and
              // is reported as one, rather than completing as an ordinary dense
              // capture that happens to quote nothing.
              log.warn(
                "YouTube capture {jobId}: the selection pass chose no frames at all out of {candidates} " +
                  "candidate(s) on {sheets} sheet(s) — the summary has no slides",
                {
                  jobId,
                  videoId,
                  candidates: prepared.candidates.length,
                  sheets: prepared.sheets.length,
                },
              );
            }

            // The launch gate. Nothing can abort an in-flight connector call, so
            // the second pass either starts with enough budget to finish or does
            // not start: a summary call launched on a spent budget does not stop
            // early, it runs its own timeout and the job silently overruns the
            // number it announced.
            const split = splitTwoPassBudget({
              wholeMs: wholeBudgetMs,
              selectionElapsedMs: Date.now() - startedAt,
              frameCount: selection.length,
              floorMs: CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS,
            });
            if (!split.launch) {
              throw new TwoPassBudgetError(
                `the selection pass left ${split.remainingMs}ms of this capture's ${wholeBudgetMs}ms budget, ` +
                  `which is under the summary call's own floor — refusing to start it`,
              );
            }
            synthesisTimeoutMs = split.synthesisTimeoutMs;

            // Pass 1b: the re-grab, in its OWN queue section, taken after the
            // model call returned rather than held across it.
            stage = "regrab_failed";
            updateStatus(jobId, "extracting_frames");
            const regrabbed = await framesQueue.run(FRAMES_QUEUE_KEY, () =>
              resolved.regrabFrames({
                file: videoPath!,
                seconds: selection.map((e) => e.tSeconds),
                outDir: framesDir,
                height: CAPTURE_FRAME_HEIGHT,
              }),
            );
            // The selection pass's own answer, carried into the summary prompt:
            // it has already looked at every one of these and said what it is
            // and why it chose it, and a bare list of paths threw that away. The
            // note is attached HERE rather than inside the re-grab, so the
            // extractor stays a file operation and the manifest stays this
            // vertical's business.
            frames = attachSelectionNotes(regrabbed, selection);
            // Early release, and deliberately NOT in a `finally` around the
            // re-grab: a re-grab that threw falls back to the cadence extractor,
            // which needs the same file. It unlinks the video itself, and the
            // job's own `finally` removes `mediaDir` whole on every path that
            // reaches neither.
            await unlink(videoPath!).catch(() => {});
            videoPath = null;
            scanOutcome = selection.length === 0 ? "selection_empty" : "dense";
          } catch (err) {
            if (err instanceof TwoPassBudgetError) throw err;
            // The scan produced sheets but the pass over them did not produce
            // frames. The video is still here, so the cadence sampler is the
            // fallback — and the root this job opened for two passes is finished
            // now, because the summary call below opens its own.
            const error = err instanceof Error ? err.message : String(err);
            denseFallback = { stage, error };
            finishParent("error", { source: "youtube", error, ...passUsage });
            // Back on the CADENCE path's own budget. The split above was sized
            // for the frames the selection pass picked; the summary call below
            // reads what the cadence extractor produces instead, and keeping
            // the two-pass number would hand a different frame list a longer
            // hang than a single-pass capture of it ever gets.
            synthesisTimeoutMs = null;
            // A re-grab that threw may have written some of its frames into the
            // very dir the cadence extractor is about to fill — and that dir is
            // what the summary call reads as `--add-dir`. A leftover is a frame
            // in the prompt's directory that no frame list names.
            await rm(framesDir, { recursive: true, force: true }).catch(() => {});
            frames = await cadenceFrames(videoPath!);
            scanOutcome = stage;
          }
        }

        if (denseFallback !== null) {
          const fallback: { stage: YouTubeScanOutcome; error: string } = denseFallback;
          log.warn(
            "YouTube capture {jobId}: the dense scan path gave up at {stage} ({error}) — " +
              "the cadence sampler produced {n} frame(s) instead",
            { jobId, videoId, stage: fallback.stage, error: fallback.error, n: frames.length },
          );
        } else {
          log.info(
            "YouTube capture {jobId}: {n} frame(s) from the {mode} sampler on a {durationSec}s video",
            { jobId, n: frames.length, mode: scanOutcome, durationSec },
          );
        }
      } catch (err) {
        if (err instanceof TwoPassBudgetError) throw err;
        framesOutcome = "failed";
        // NOT `off`, which means the reader never asked: they did, and the path
        // threw before any sampler produced a frame.
        scanOutcome = "prep_failed";
        frames = [];
        // Whatever the split decided is void — there are no frames to read.
        synthesisTimeoutMs = null;
        log.warn("YouTube capture {jobId}: frames failed — transcript only: {error}", {
          jobId,
          videoId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2. Summarize with Claude, in the KIND the reader picked.
    updateStatus(jobId, "summarizing");

    // Built per capture rather than as a module constant: the structure bullets
    // are the PRESET's now, and a constant could only ever carry one kind's.
    const systemPrompt = `${buildSummarySystemPrompt(SUMMARIZE_INTRO, VALID_CATEGORIES, preset.instruction)}${
      timestamped ? WINDOWED_TRANSCRIPT_RIDER : ""
    }

Video title: ${title}
Video URL: ${videoUrl}`;

    // Whether this call INHERITS the bot's own thinking budget instead of the
    // 8k capture cap. Two independent reasons, either of which is enough:
    //
    //  - the KIND says so (`deep`: "full thinking" means no capture override,
    //    not an infinite budget). It holds with slides off, on, skipped or
    //    failed — `preset` is not touched by the frames path, so a frame pass
    //    that threw cannot reapply the cap;
    //  - FRAMES came out, which is where TikTok opts out of the cap: reading
    //    them IS the reasoning. That is exactly today's `standard` rule and is
    //    kept byte-identical.
    const inheritThinking = captureThinkingFor(preset) === null || frames.length > 0;
    // What the trace and the completion line say the budget actually was. The
    // seam forces `null` on a connector that does not honour the field at all
    // (openai-compat reuses it as `max_tokens`), so naming the cap there would
    // be a number nothing applied.
    const thinkingLabel = !connectorCapabilities(runBot).supportsThinkingBudget
      ? "connector-default"
      : inheritThinking
        ? `inherit:${runBot.thinkingMaxTokens ?? "bot-default"}`
        : `capped:${CAPTURE_THINKING_MAX_TOKENS}`;

    const onProgress: StreamProgressCallback = (event) => {
      if (event.type === "text_delta") {
        appendText(jobId, event.text);
      }
    };

    const result = await runCaptureOneShot({
      source: "youtube",
      jobId,
      title,
      url: videoUrl,
      // The frame list rides the USER prompt after the transcript (the TikTok
      // and Vimeo shape); with no frames it contributes "" and the prompt is
      // byte-identical to the one that shipped before slides existed.
      //
      // The POLICY is built only where frames came out, deliberately: building
      // it needs an ADDRESS (`frameQuoteTemplate`), and `framesPromptSection`'s
      // contract is that a frames-off capture never asks the id gate anything.
      prompt:
        transcriptText +
        (frames.length > 0
          ? framesPromptSection(
              YOUTUBE_FRAME_SOURCE,
              videoId,
              frames,
              visualDetailPolicy(visualDetail, YOUTUBE_FRAME_SOURCE, videoId),
            )
          : ""),
      systemPrompt,
      config,
      botConfig: runBot,
      attachRun,
      onProgress,
      // `--add-dir` only when there is something to read: an empty extraDirs
      // would still flip the connector's file-access mode for nothing.
      ...(frames.length > 0 ? { extraDirs: [workDir] } : {}),
      // On the dense path this is what is LEFT of the whole two-pass budget the
      // job announced; everywhere else it is the single call's own budget, as
      // before.
      timeoutMs: synthesisTimeoutMs ?? summarizeTimeoutFor(frames.length, CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS),
      ...(inheritThinking ? { thinkingMaxTokens: null } : {}),
      // Only on the two-pass path — everywhere else the seam opens and finishes
      // its own root, exactly as it always has.
      ...(parentTracer ? { parentTracer } : {}),
      extraTraceAttrs: {
        frames: framesOutcome,
        frameCount: String(frames.length),
        transcriptWindows: String(timestamped),
        // The connector and the requested model are stamped by the shared seam
        // (`tracedOneShot`), and the RETURNED model + elapsed time at its end;
        // these two are the parts only this vertical knows.
        summaryKind: preset.id,
        thinking: thinkingLabel,
        visualDetail,
        // Which sampler produced the frames above, and — where it was the dense
        // one — what it cost to get there.
        frameScan: scanOutcome,
        scanSamples: String(scanSamples),
        scanCandidates: String(scanCandidates),
        scanSheets: String(scanSheets),
      },
    });
    addUsage(result);
    // The root this job owns, finished on its SUCCESS path — with both passes'
    // spend summed, so a two-pass trace does not report the summary call's cost
    // as the whole job's. A no-op on every single-pass capture, where
    // `parentTracer` was never set and the seam has already finished its own.
    finishParent("ok", { source: "youtube", model: result.model, ...passUsage });

    // 3. Parse response, then hold its frame references to this capture's own
    //    manifest and this policy's caps.
    //
    //    The summary STREAMED to the job card delta by delta while the model
    //    wrote it, so this rewrite happens after the reader has already seen the
    //    unrewritten text. That is what `completeReplacesText` +
    //    `completeCarriesSummary` are for (`state.ts`, `youtube-routes.ts`): the
    //    terminal event carries the rewritten body, so the live card swaps it in
    //    and an SSE replay after a reload serves it too. Everything downstream —
    //    the ingest body, the source draft, `completeJob` — is built from
    //    `summary` below and never from `parsed`.
    const { category, summary: parsed } = parseSummaryResponse(result.result);
    setCategory(jobId, category);

    const enforced = enforceVisualReferences({
      summary: parsed,
      source: YOUTUBE_FRAME_SOURCE,
      videoId,
      extracted: frames.map((f) => f.tSeconds),
      detail: visualDetail,
    });
    let summary = enforced.text;

    // The frames the summary QUOTES are copied out of the work dir to the
    // served root before the work dir dies; the rest go with it. The list is
    // the enforcement pass's OWN answer, not a second reading of the text: the
    // pass has just decided which quotes may be served, and a re-parse is how
    // the two come to disagree. Inside its own try: a copy failure must not fail
    // a capture whose text is already on the reader's screen — and the copy is
    // per file, so one missing frame costs its own reference and no other.
    let keptFrames: number[] = [];
    let copyFailed = false;
    if (frames.length > 0) {
      try {
        keptFrames = await keepReferencedFrames(
          summary,
          YOUTUBE_FRAME_SOURCE,
          videoId,
          frames,
          resolved.framesRoot,
          enforced.referenced,
        );
      } catch (err) {
        copyFailed = true;
        log.error("YouTube capture {jobId}: keeping quoted frames failed: {error}", {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // The copy is the last thing between a reference and a served file, so
    // whatever it did NOT keep is a promise of a picture the route will 404 —
    // including the case where it threw and kept nothing at all. The text is
    // made true before it is stored, ingested or drafted from.
    const unserved = enforced.referenced.filter((sec) => !keptFrames.includes(sec));
    if (unserved.length > 0) {
      const repaired = dropFrameReferences(summary, YOUTUBE_FRAME_SOURCE, videoId, unserved);
      summary = repaired.text;
      log.warn(
        "YouTube capture {jobId}: {n} quoted frame(s) were not copied ({seconds}) — their references were " +
          "removed from the stored summary{because}",
        {
          jobId,
          videoId,
          n: repaired.removed,
          seconds: unserved.join(", "),
          because: copyFailed ? " (the copy failed)" : "",
        },
      );
    }

    // The one line that says what actually ran. `model` is the connector's own
    // answer (`ClaudeExecResult.model`) rather than what was asked for, which is
    // why both are here: a kind that promises opus and a run that reports
    // something else is the failure this campaign has to be able to see, and a
    // connector that reports no model at all must read as unknown rather than
    // as the request echoed back. It is also what `scripts/replay-youtube.ts`
    // reads for its `run.json`.
    //
    // The four frame counts are separate on purpose, and each answers a
    // different question: `extracted` is what the model was shown, `selected`
    // what it chose, `referenced` what survived the caps and the manifest, and
    // `retained` what is on disk to serve. Collapsed into one number, a policy
    // that over-quotes and a model that under-selects are indistinguishable.
    log.info(
      "Summarized {videoId}: kind={summaryKind}, visual={visualDetail}, category={category}, model={model} (requested {requestedModel}), thinking={thinking}, {tokens} output tokens, scan={frameScan} samples={scanSamples} candidates={scanCandidates} sheets={scanSheets}, frames extracted={frames} selected={selected} referenced={referenced} retained={kept}",
      {
        videoId,
        // A MARKER, not a description: this vertical now writes a second line
        // carrying a `model` (the selection pass's), so a reader looking for
        // "the record with a model and a summaryKind" would find whichever came
        // last. `scripts/replay-youtube.ts` matches on this.
        event: "capture_complete",
        summaryKind: preset.id,
        frameScan: scanOutcome,
        scanSamples,
        scanCandidates,
        scanSheets,
        // The whole job's spend, both passes summed, so the harness never has to
        // add two log lines together.
        totalInputTokens: passUsage.inputTokens,
        totalOutputTokens: passUsage.outputTokens,
        totalCostUsd: passUsage.costUsd,
        totalToolCount: passUsage.toolCount,
        synthesisTimeoutMs: synthesisTimeoutMs ?? null,
        visualDetail,
        category,
        model: result.model ?? "unknown",
        requestedModel: runBot.model ?? "bot-default",
        thinking: thinkingLabel,
        tokens: result.outputTokens,
        frames: frames.length,
        selected: enforced.selected.length,
        referenced: enforced.referenced.length,
        kept: keptFrames.length,
        // Not in the message, and the one part that is not a count: WHICH
        // seconds the model chose. `selected` minus what the stored text ends up
        // quoting is exactly the set the caps refused, which is the question a
        // policy is tuned on — a count alone cannot say whether the frame the
        // reader wanted was never chosen or was chosen and trimmed.
        selectedSeconds: enforced.selected.join(","),
        // What the SELECTION pass asked for, as JSON — a superset of the above
        // on a dense capture, empty on every other path. It is the only place a
        // rejected pick is inspectable: `selectedSeconds` is what the summary
        // quoted, and the difference between the two is what the summary turned
        // down after reading the frames properly.
        selectionManifest: JSON.stringify(selection),
      },
    );

    // 4. Ingest into knowledge base (best-effort)
    updateStatus(jobId, "ingesting");

    // Capture huginn's stored doc id (`file_path` = <category>/<title-slug>.md) so
    // the source-draft trigger below keys off the SAME id the run-now drafter uses
    // (`newest.id`) — otherwise a run-now click on a just-auto-drafted video would
    // mint a duplicate proposal under a different topic_key.
    let ingestedDocId: string | undefined;
    // The windowed transcript rides the SUMMARY string, and only when huginn
    // answered with windows — its YouTube ingest has no `transcript_markdown`
    // field, so the summary IS the document body. See `appendTranscriptSection`;
    // `completeJob`, the shelf card and the source draft get the summary alone.
    const ingestSummaryBody = timestamped ? appendTranscriptSection(summary, transcriptText) : null;
    if (ingestSummaryBody?.truncated) {
      // The one consumer of the cap's own answer: without it, a talk whose
      // second half never reached the document is invisible outside the file.
      log.warn(
        "YouTube capture {jobId}: transcript truncated at the {maxBytes}-byte bound " +
          "({transcriptBytes} bytes in, {keptBytes} kept) — the document ends mid-talk",
        {
          jobId,
          videoId,
          maxBytes: YOUTUBE_TRANSCRIPT_MAX_BYTES,
          transcriptBytes: ingestSummaryBody.inputBytes,
          keptBytes: ingestSummaryBody.keptBytes,
        },
      );
    }
    await ingestSummary({
      knowledgeApiUrl: config.knowledgeApiUrl,
      ingestPath: "/api/youtube/ingest",
      body: {
        title,
        url: videoUrl,
        summary: ingestSummaryBody?.text ?? summary,
        category,
        date: new Date().toISOString().split("T")[0],
        // The SUMMARY's own provenance — which kind wrote this body — on the
        // same key and with the same meaning as the Vimeo vertical's. Sent
        // always, including for `standard`: "absent" has to keep meaning
        // "written before kinds existed" rather than "written as standard".
        summary_kind: preset.id,
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
    //    Skipped only by the replay harness (`deps.sourceDraft`), which
    //    ingests into a stub.
    if (opts.deps?.sourceDraft === false) return;
    triggerSourceDraftFromCapture(botConfig, {
      collection: "youtube-summaries",
      docId: ingestedDocId ?? videoId,
      url: videoUrl,
      body: summary,
      sourceTitle: title,
      category,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The root a two-pass capture opened, on its FAILURE path — including a
    // synthesis call that threw after the selection pass succeeded, and the
    // budget gate's own refusal. A no-op when the seam owns the root.
    finishParent("error", { source: "youtube", error: msg, ...passUsage });
    log.error("YouTube summarization failed for job {jobId}: {error}", { jobId, error: msg });
    failJob(jobId, msg);
  } finally {
    // BOTH roots, recursively. `workDir` holds the frames the summary did not
    // quote and the contact sheets; `mediaDir` holds the downloaded video and
    // the scan's several hundred thumbnails. The video is unlinked earlier on
    // every path that gets that far, but not on all of them — a selection pass
    // that threw before the re-grab, or a scan that failed before the fallback
    // — so this is what guarantees a 90 MB rendition never outlives the job.
    // Only ever created by this job, under names only this job uses; an rm of a
    // dir that was never made is a no-op.
    await Promise.all([
      rm(workDir, { recursive: true, force: true }).catch(() => {}),
      rm(mediaDir, { recursive: true, force: true }).catch(() => {}),
    ]);
  }
}
