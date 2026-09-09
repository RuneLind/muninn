import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { getLog } from "../logging.ts";
import { resolveServingProfile } from "../config.ts";
import {
  CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS,
  ingestSummary,
  runCaptureOneShot,
} from "../summaries/summarizer-shared.ts";
import { buildVimeoSystemPrompt, buildVimeoUserPrompt } from "./prompt.ts";
import { finishVimeoSummary } from "./finish.ts";
import {
  captureBotConfigFor,
  captureThinkingFor,
  type CapturePreset,
} from "../summaries/presets.ts";
import { langFromCaptionTag, resolveOutputLang, type CaptureLang } from "../summaries/language.ts";
import { getSummarySource } from "../summaries/sources.ts";
import { triggerSourceDraftFromCapture } from "../gardener/source-drafter-run.ts";
import { createQueue } from "../wiki/queue.ts";
import { summarizeTimeoutFor } from "../video/media.ts";
import { canonicalVimeoUrl } from "./url.ts";
import { fetchVimeoManifest as realFetchManifest, type VimeoManifest } from "./media.ts";
import { extractCadenceFrames as realExtractFrames } from "./frames.ts";
import { type CaptureFrame } from "../summaries/frames.ts";
import {
  chooseTrack,
  downloadVtt as realDownloadVtt,
  harvestVimeoCaptions,
  VIMEO_HARVEST_TIMEOUT_MS,
  VIMEO_MANIFEST_WAIT_MS,
  type VimeoCaptions,
} from "./captions.ts";
import { detectCaptionKind, segmentsToMarkdown, vttToSegments, DEFAULT_WINDOW_SEC } from "./vtt.ts";
import {
  transcribeOpusRendition,
  whisperUnavailableReason,
  VimeoTranscriptionError,
  WHISPER_CAPTION_KIND,
  looksSpeechless,
  type WhisperTranscript,
} from "./whisper.ts";
import {
  attachRun,
  updateStatus,
  appendText,
  setCategory,
  setSimilar,
  completeJob,
  failJob,
} from "./state.ts";

const log = getLog("vimeo", "summarizer");

/**
 * The collection this vertical ingests into (huginn's `--vimeo-collection`).
 *
 * Derived from the summary-source registry, never spelled again: the route
 * reads the same entry for its dedup listing, and two literals for one
 * collection name is a pair that can drift into a capture that ingests into one
 * collection and dedups against another.
 */
export const VIMEO_COLLECTION = getSummarySource("vimeo")!.collection;

/**
 * Longest video this vertical will capture: 3 hours.
 *
 * Enforced in the ROUTE (413), not here — the check needs oEmbed's duration,
 * which the route already has, and refusing before a job exists is what keeps an
 * over-cap paste from leaving an unsettled row at the top of /summaries.
 *
 * Re-exported from `./limits.ts`, which owns it: `/summaries` injects the same
 * number into the page and must not import this module (playwright-core and the
 * whole harvest pipeline) to read one integer.
 */
export { VIMEO_MAX_DURATION_SEC } from "./limits.ts";

/** Error code stored on a job whose video has captions we could not choose from. */
export const NO_CAPTIONS_ERROR = "no_captions";
/**
 * The Whisper fallback's three codes (v2 PR 5), each a sentence on the card:
 * no caption track AND this machine cannot transcribe (binary or model
 * missing — the operator's to fix); the pipeline failed on this video; the
 * audio came back with no speech in it.
 */
export const WHISPER_UNAVAILABLE_ERROR = "whisper_unavailable";
export const TRANSCRIPTION_FAILED_ERROR = "transcription_failed";
export const NO_SPEECH_ERROR = "no_speech";

/**
 * The prompt builders live in `./prompt.ts` — a module a dashboard view and the
 * re-run can import without playwright-core and the harvest pipeline behind it.
 * Re-exported here because this is the path every existing importer uses.
 */
export {
  AUTO_CAPTION_RIDER,
  buildVimeoSystemPrompt,
  buildVimeoUserPrompt,
  SUMMARIZE_INTRO,
} from "./prompt.ts";

/**
 * ONE Chromium at a time, process-wide.
 *
 * `harvestVimeoCaptions` launches a browser per harvest. Two concurrent pastes
 * are two legitimate jobs, but they must not be two concurrent Chromiums on a
 * laptop that is also running the dev server, the bots and huginn. A queue (not
 * a try-lock) because neither job may be dropped: the second one waits, then
 * runs, and its own 60 s budget starts when it does.
 */
const harvestQueue = createQueue();
const HARVEST_QUEUE_KEY = "vimeo-harvest";

/** What the route already knows by the time it creates a job. */
export interface VimeoJobMeta {
  readonly videoId: string;
  readonly hash?: string;
  /** The canonical url — the dedup and ingest key. */
  readonly url: string;
  readonly title: string;
  readonly durationSec: number;
  /**
   * oEmbed's `upload_date`, written on the document as `upload_date` — kept
   * apart from `date`, which is the CAPTURE day the shelf buckets on.
   */
  readonly uploadDate: string;
  /** oEmbed's `author_name` — the uploading account ("JavaZone"). */
  readonly author: string;
  /** oEmbed's `thumbnail_url` — the poster frame the shelf card shows. */
  readonly thumbnailUrl: string;
  /** Derived by the route from a conference account's title convention
   *  (`speakerFromTitle`); absent for every other uploader. */
  readonly speaker?: string;
  /**
   * The summary KIND the reader picked, resolved by the route against the
   * summarizer bot's preset set (`findCapturePreset` — an unknown id is a 400
   * there, so this is always a real preset).
   */
  readonly preset: CapturePreset;
  /**
   * The output language the reader picked — `talk` (the default) resolves
   * against the chosen caption track's tag once the harvest has run, which is
   * why this is the PICK and not the resolved language.
   */
  readonly lang: CaptureLang;
  /**
   * Slides on: pull one 720p frame per cadence tick through the media seam,
   * hand them to the model via `extraDirs`, and let the summary quote them
   * inline (v2 PR 4). The route pre-flights the connector's
   * `supportsExtraDirs` and 503s BEFORE a job exists, so a job that gets here
   * with `frames: true` runs on a connector that can read files.
   */
  readonly frames: boolean;
}

export type HarvestFn = (
  videoId: string,
  opts: { hash?: string; timeoutMs?: number; awaitManifestMs?: number; awaitManifestNoCaptionsMs?: number },
) => Promise<VimeoCaptions>;

export type DownloadVttFn = (url: string) => Promise<string>;

export type FetchManifestFn = (manifestUrl: string) => Promise<VimeoManifest>;
export type ExtractFramesFn = (input: {
  manifestUrl: string;
  manifest: VimeoManifest;
  durationSec: number;
  workDir: string;
}) => Promise<CaptureFrame[]>;

/**
 * The Whisper half (PR 5). `unavailableReason` is the pre-flight (null ⇒ go);
 * `transcribeAudio` is the whole download → decode → whisper pipeline.
 */
export type WhisperUnavailableFn = (config: Config) => string | null;
export type TranscribeAudioFn = (
  input: { manifestUrl: string; manifest: VimeoManifest; durationSec: number; workDir: string },
  hooks: { onTranscribing: () => void },
  config: Config,
) => Promise<WhisperTranscript>;

export interface VimeoSummarizerDeps {
  harvest: HarvestFn;
  downloadVtt: DownloadVttFn;
  /** The frames half (PR 4): the manifest fetch and the cadence extraction. */
  fetchManifest: FetchManifestFn;
  extractFrames: ExtractFramesFn;
  /** The Whisper half (PR 5): the no-captions fallback. */
  whisperUnavailable: WhisperUnavailableFn;
  transcribeAudio: TranscribeAudioFn;
  /** Where quoted frames are kept (test seam); default `framesRootDir()`. */
  framesRoot?: string;
}

/**
 * Told once, on a SUCCESSFUL ingest, with huginn's stored doc id.
 *
 * Deliberately NOT a field on {@link VimeoSummarizerDeps}: passing any `deps` at
 * all means "this caller brings its own harvest", which skips the
 * `VIMEO_HARVEST_STUB` resolution entirely — so a route handing over a callback
 * through that channel would silently disable the stub.
 *
 * The route uses it to close the window between "ingested" and "listed by
 * huginn": nothing else in the process knows that instant, because huginn's
 * `/documents` listing is derived from an index the background reindex rebuilds
 * later. It is called only when huginn returned a `file_path`, so a failed or
 * older-huginn ingest records nothing rather than recording a document id that
 * does not resolve.
 */
export type VimeoIngestedHook = (videoId: string, documentId: string) => void;

/**
 * `VIMEO_HARVEST_STUB` — an absolute path to a `.vtt` file that stands in for
 * the whole browser half, so an acceptance run can drive the vertical end to
 * end with no Chromium and no live Vimeo.
 *
 * It is a BACKDOOR by construction: it makes the process summarize a file off
 * local disk while reporting a capture of a public video. Three gates, all
 * required, and every refusal is a warn rather than a throw — the operator's
 * intent was to capture, and a real harvest is the correct thing to fall back
 * to:
 *
 *  - `resolveServingProfile() === "default"` — never on a serving deployment;
 *  - the path is ABSOLUTE — a relative one resolves against whatever cwd the
 *    process happens to have;
 *  - the file EXISTS — a typo'd path would otherwise fail deep inside the job
 *    as an empty transcript.
 *
 * The resolution is memoized on the two variables it reads (see
 * {@link harvestStub}), so a long-running dev server stats the fixture once —
 * but the WARN is per capture, in {@link summarizeVimeo}, naming the job: a
 * once-per-process line is a line nobody sees on the capture they are looking
 * at. The document itself says so too, via `caption_kind: "stub"`.
 */
export async function resolveHarvestStubDeps(
  env: Record<string, string | undefined> = process.env,
): Promise<VimeoSummarizerDeps | null> {
  const raw = env.VIMEO_HARVEST_STUB?.trim();
  if (!raw) return null;

  const profile = resolveServingProfile(env);
  if (profile !== "default") {
    log.warn(
      "VIMEO_HARVEST_STUB is ignored on serving profile {profile} — running a real harvest",
      { profile },
    );
    return null;
  }
  if (!raw.startsWith("/")) {
    log.warn(
      "VIMEO_HARVEST_STUB={path} is not an absolute path — ignored, running a real harvest",
      { path: raw },
    );
    return null;
  }
  const file = Bun.file(raw);
  if (!(await file.exists())) {
    log.warn(
      "VIMEO_HARVEST_STUB={path} does not exist — ignored, running a real harvest",
      { path: raw },
    );
    return null;
  }

  const vttUrl = `https://captions.vimeo.com/captions/stub.vtt`;
  return {
    harvest: async (videoId) => ({
      videoId,
      title: "",
      durationSec: 0,
      tracks: [{ lang: "en-x-autogen", label: "English (auto-generated)", vttUrl }],
      // No manifestUrl: a stubbed capture has no video to pull frames from, so
      // a `frames: true` job under the stub degrades to transcript-only with
      // the same warn a live harvest that saw no manifest gets.
    }),
    downloadVtt: async () => await file.text(),
    fetchManifest: REAL_DEPS.fetchManifest,
    extractFrames: REAL_DEPS.extractFrames,
    // Unreachable under the stub (its harvest always lists one track), kept
    // real so the deps object is the full shape.
    whisperUnavailable: REAL_DEPS.whisperUnavailable,
    transcribeAudio: REAL_DEPS.transcribeAudio,
  };
}

/**
 * The memoized form {@link summarizeVimeo} uses: ONE resolution (one profile
 * parse, one stat) per distinct configuration, instead of one per capture.
 *
 * Keyed on BOTH variables `resolveHarvestStubDeps` reads, so a process that
 * changes either is not served a stale answer — and a THROW is not memoized, so
 * a transient failure (a permission error on the stat) is retried rather than
 * pinned for the lifetime of the process.
 */
let stubCache: { key: string; value: Promise<VimeoSummarizerDeps | null> } | null = null;

/**
 * The memo key for one `(VIMEO_HARVEST_STUB, MUNINN_PROFILE)` pair.
 *
 * The separator is **NUL, spelled as an escape** — the one byte a filesystem
 * path cannot contain. It cannot be a SPACE, because a path may hold one:
 * `/tmp/x nais` with no profile and `/tmp/x` with `MUNINN_PROFILE=nais` would
 * both spell `"/tmp/x nais"`, so the second configuration is served the first's
 * cached answer and a `nais` process runs the stub it exists to refuse. And it
 * is an ESCAPE rather than the raw byte it shipped as, which no reader, diff or
 * review can see — it renders as a space in every one of them, i.e. as exactly
 * the bug it is there to prevent.
 *
 * Exported because that property is otherwise untestable: the memo is a private
 * wrapper and the collision needs two configurations inside ONE process, which
 * only a test arranges.
 */
export function stubCacheKey(env: Record<string, string | undefined>): string {
  return `${env.VIMEO_HARVEST_STUB?.trim() ?? ""}\u0000${env.MUNINN_PROFILE ?? ""}`;
}

async function harvestStub(
  env: Record<string, string | undefined> = process.env,
): Promise<{ deps: VimeoSummarizerDeps; path: string } | null> {
  const path = env.VIMEO_HARVEST_STUB?.trim() ?? "";
  const key = stubCacheKey(env);
  if (!stubCache || stubCache.key !== key) {
    stubCache = { key, value: resolveHarvestStubDeps(env) };
  }
  const cached = stubCache;
  try {
    const deps = await cached.value;
    return deps ? { deps, path } : null;
  } catch (err) {
    if (stubCache === cached) stubCache = null;
    throw err;
  }
}

const REAL_DEPS: VimeoSummarizerDeps = {
  harvest: (videoId, opts) => harvestVimeoCaptions(videoId, opts),
  downloadVtt: (url) => realDownloadVtt(url),
  fetchManifest: (manifestUrl) => realFetchManifest(manifestUrl),
  whisperUnavailable: (config) => whisperUnavailableReason(config.vimeoWhisperModelPath),
  transcribeAudio: (input, hooks, config) =>
    transcribeOpusRendition(input, { modelPath: config.vimeoWhisperModelPath, onTranscribing: hooks.onTranscribing }),
  extractFrames: (input) => realExtractFrames(input),
};

/**
 * Run one Vimeo capture: harvest → download → window → summarize → ingest →
 * source-draft.
 *
 * `meta` is oEmbed's answer, which the ROUTE already fetched — this function
 * never asks again. Failures land on the job (`failJob`) rather than throwing,
 * and the huginn ingest is best-effort exactly as in the other verticals.
 */
export async function summarizeVimeo(
  jobId: string,
  meta: VimeoJobMeta,
  config: Config,
  botConfig: BotConfig,
  deps?: Partial<VimeoSummarizerDeps>,
  onIngested?: VimeoIngestedHook,
): Promise<void> {
  // The frames' work dir — created only when frames are on, removed in the
  // `finally` whatever happened, AFTER the kept frames have been copied out.
  const workDir = join(tmpdir(), `muninn-vimeo-${jobId}`);
  let frames: CaptureFrame[] = [];
  try {
    // 0. Resolve the deps INSIDE the try. `resolveServingProfile` throws on an
    //    unrecognised MUNINN_PROFILE and the stat can throw on a permission
    //    error; outside the try that escaped into the route's fire-and-forget
    //    `.catch` and left the job `pending` for the whole 12 h in-flight grace.
    //
    //    A caller that brought its own deps never consults the stub at all: it
    //    would only be overridden, and every unit-test capture was paying for a
    //    resolution it then threw away.
    let resolved: VimeoSummarizerDeps;
    let stubbed = false;
    if (deps) {
      resolved = { ...REAL_DEPS, ...deps };
    } else {
      const stub = await harvestStub();
      stubbed = stub !== null;
      resolved = stub ? stub.deps : REAL_DEPS;
      if (stub) {
        // EVERY stubbed capture says so, not the first one of the process: this
        // is the line that tells the reader of a job that its "capture" never
        // touched vimeo.com.
        log.warn(
          "VIMEO_HARVEST_STUB active for job {jobId} ({videoId}): harvesting NOTHING, serving captions from {path}",
          { jobId, videoId: meta.videoId, path: stub.path },
        );
      }
    }

    // 1. Harvest the signed caption URL and download it, serialized against
    //    every other harvest in this process. The status moves INSIDE the queued
    //    closure: announced before the queue, a job waiting its turn reported a
    //    Chromium that was not running — for as long as every harvest ahead of
    //    it took.
    // The whisper pre-flight runs BEFORE the harvest so its answer is in hand
    // when the track question is; the harvest still waits for the manifest on
    // a track-less video either way (10 s, on such videos only), because the
    // card must say which of two facts holds — "nothing to transcribe from"
    // (no manifest) or "this machine cannot transcribe" — and without the
    // wait the first would shadow the second on every whisper-less machine.
    const whisperUnavailable = resolved.whisperUnavailable(config);

    const captions = await harvestQueue.run(HARVEST_QUEUE_KEY, () => {
      updateStatus(jobId, "harvesting_captions");
      return resolved.harvest(meta.videoId, {
        ...(meta.hash ? { hash: meta.hash } : {}),
        timeoutMs: VIMEO_HARVEST_TIMEOUT_MS,
        // Only the frames path waits for the manifest: a transcript-only
        // capture closes the browser the moment it has the captions.
        awaitManifestMs: meta.frames ? VIMEO_MANIFEST_WAIT_MS : 0,
        // ALWAYS: a video with no caption track is transcribed from its
        // manifest (PR 5), and nothing knows before the harvest whether the
        // track exists. Costs nothing on a captioned video — the harvest only
        // waits on this when the player lists no track.
        awaitManifestNoCaptionsMs: VIMEO_MANIFEST_WAIT_MS,
      });
    });

    // The manifest is fetched at most ONCE per job, whichever of the two
    // consumers (Whisper, frames) asks first.
    let manifest: VimeoManifest | undefined;
    const getManifest = async (manifestUrl: string) => (manifest ??= await resolved.fetchManifest(manifestUrl));

    // 1a. The transcript: the chosen caption track, or — with NO usable track
    //     and a manifest in hand — the talk's own audio through Whisper (PR 5).
    //     `track` is null on the Whisper path; everything downstream reads the
    //     three fields below instead of the track.
    const track = chooseTrack(captions.tracks);
    let transcriptVtt: string;
    /** The tag the language is resolved from: the track's, or whisper's detection. */
    let captionLang: string;
    /** What the DOCUMENT records: `manual` / `auto` / `whisper` (`stub` overrides below). */
    let captionKindOnDocument: string;
    if (track) {
      transcriptVtt = await resolved.downloadVtt(track.vttUrl);
      captionLang = track.lang;
      captionKindOnDocument = detectCaptionKind(track.lang);
    } else if (!captions.manifestUrl) {
      // A legitimate answer about the video, not a failure of the mechanism:
      // no caption track, and the player asked for no playlist inside the
      // wait, so there is no audio to fall back to either — on ANY machine.
      log.info("Vimeo video {videoId} has no usable caption track and no manifest — nothing to transcribe", {
        videoId: meta.videoId,
      });
      failJob(jobId, NO_CAPTIONS_ERROR);
      return;
    } else if (whisperUnavailable !== null) {
      // There is a manifest to try and this machine cannot transcribe: the
      // pre-flight's answer, before the manifest fetch and the download (40 MB
      // of audio for a machine that cannot transcribe it is the wrong order).
      // Whether that manifest carries an AUDIO rendition is only known after
      // the fetch this branch skips — a video-only manifest answers here where
      // a whisper-capable machine would answer transcription_failed.
      log.warn("Vimeo video {videoId} has no caption track and this machine cannot transcribe it: {reason}", {
        videoId: meta.videoId,
        reason: whisperUnavailable,
      });
      failJob(jobId, WHISPER_UNAVAILABLE_ERROR);
      return;
    } else {
      updateStatus(jobId, "downloading");
      let whisper: WhisperTranscript;
      try {
        await mkdir(workDir, { recursive: true });
        const m = await getManifest(captions.manifestUrl);
        whisper = await resolved.transcribeAudio(
          { manifestUrl: captions.manifestUrl, manifest: m, durationSec: meta.durationSec, workDir },
          { onTranscribing: () => updateStatus(jobId, "transcribing") },
          config,
        );
      } catch (err) {
        // A stable code on the job, the detail in the log: the card turns the
        // code into a sentence, and a raw ffmpeg tail is not one.
        log.error("Vimeo video {videoId}: transcription failed — {error}", {
          videoId: meta.videoId,
          error: err instanceof Error ? err.message : String(err),
          step: err instanceof VimeoTranscriptionError ? "pipeline" : "unexpected",
        });
        failJob(jobId, TRANSCRIPTION_FAILED_ERROR);
        return;
      }
      transcriptVtt = whisper.vtt;
      captionLang = whisper.lang;
      captionKindOnDocument = WHISPER_CAPTION_KIND;
      log.info("Vimeo video {videoId}: transcribed from audio ({bytes} bytes of Opus), language {lang}", {
        videoId: meta.videoId,
        bytes: whisper.audioBytes,
        lang: whisper.lang,
      });
    }

    const segments = vttToSegments(transcriptVtt, DEFAULT_WINDOW_SEC);
    if (track && segments.length === 0) {
      failJob(jobId, NO_CAPTIONS_ERROR);
      return;
    }
    if (!track && looksSpeechless(segments, meta.durationSec)) {
      // A whisper run that heard nothing is its own answer — and "nothing" is
      // a FLOOR, not zero cues: whisper hallucinates a word on silence.
      log.info("Vimeo video {videoId}: the audio transcribed to {n} window(s) below the speech floor — no speech", {
        videoId: meta.videoId,
        n: segments.length,
      });
      failJob(jobId, NO_SPEECH_ERROR);
      return;
    }
    const transcript = segmentsToMarkdown(segments);
    // The prompt's proper-noun rider is about the TEXT: a whisper transcript
    // garbles names exactly the way an auto-caption does (measured: "Jepro"
    // for a company name on the first live run), so it gets the same rider.
    const captionKind: "manual" | "auto" = captionKindOnDocument === "manual" ? "manual" : "auto";

    log.info(
      "Harvested {videoId}: {lang} ({kind}), {cues} windows, {chars} chars",
      {
        videoId: meta.videoId,
        lang: captionLang,
        kind: captionKindOnDocument,
        cues: segments.length,
        chars: transcript.length,
      },
    );

    // 1b. Frames (PR 4): one 720p frame per cadence tick, through the media
    //     seam, into the work dir the model reads. A failure here degrades the
    //     capture to transcript-only with a WARN (the TikTok precedent) — the
    //     reader asked for a summary and a summary without slides is still one;
    //     but it is never silent, and the trace attribute says which happened.
    let framesOutcome: "off" | "on" | "no_manifest" | "failed" = "off";
    if (meta.frames) {
      if (!captions.manifestUrl) {
        framesOutcome = "no_manifest";
        log.warn("Vimeo capture {jobId}: frames requested but the player requested no manifest — transcript only", {
          jobId,
          videoId: meta.videoId,
        });
      } else {
        updateStatus(jobId, "extracting_frames");
        try {
          await mkdir(workDir, { recursive: true });
          const m = await getManifest(captions.manifestUrl);
          frames = await resolved.extractFrames({
            manifestUrl: captions.manifestUrl,
            manifest: m,
            durationSec: meta.durationSec,
            workDir,
          });
          framesOutcome = "on";
          log.info("Vimeo capture {jobId}: {n} cadence frames extracted", { jobId, n: frames.length });
        } catch (err) {
          framesOutcome = "failed";
          frames = [];
          log.warn("Vimeo capture {jobId}: frame extraction failed — transcript only: {error}", {
            jobId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 2. Summarize — in the KIND the reader picked, in the language they
    //    picked or the talk's own. The language is resolved HERE, not in the
    //    route: `talk` needs the chosen track's tag, which exists only now.
    updateStatus(jobId, "summarizing");

    // `talk` reads the TRANSCRIPT first and the caption tag second: the tag
    // is not a reliable signal (Vimeo tagged a Norwegian talk `en-x-autogen`,
    // measured), the text cannot be mis-tagged. Named on the log line when the
    // two disagree, so a surprising summary language is explicable afterwards.
    const outputLang = resolveOutputLang(meta.lang, captionLang, transcript);
    if (meta.lang === "talk" && outputLang !== langFromCaptionTag(captionLang)) {
      log.info("Vimeo video {videoId}: the transcript reads as {outputLang} while the caption language {captionLang} ({source}) says otherwise — the text wins", {
        source: track ? "track tag" : "whisper detection",
        videoId: meta.videoId,
        outputLang,
        captionLang,
      });
    }
    const systemPrompt = buildVimeoSystemPrompt({
      preset: meta.preset,
      title: meta.title,
      url: meta.url,
      captionKind,
      outputLang,
    });
    const runBot = captureBotConfigFor(botConfig, meta.preset);
    if (meta.preset.run.model === "opus" && runBot === botConfig) {
      // Honest about what ran: the kind promised the bigger model and this
      // connector's namespace cannot name it. The thinking half still applies.
      log.warn(
        "Vimeo capture {jobId}: kind {kind} asks for the opus model, but connector {connector} keeps its own ({model})",
        {
          jobId,
          kind: meta.preset.id,
          connector: botConfig.connector ?? "claude-cli",
          model: botConfig.model ?? "default",
        },
      );
    }

    const onProgress: StreamProgressCallback = (event) => {
      if (event.type === "text_delta") {
        appendText(jobId, event.text);
      }
    };

    const result = await runCaptureOneShot({
      source: "vimeo",
      jobId,
      title: meta.title,
      url: meta.url,
      // The frame list rides on the USER prompt after the transcript (the
      // TikTok shape); the system prompt is the kind + riders and says nothing
      // about frames, so a transcript-only capture's prompt is byte-identical
      // to before. The composition is `./prompt.ts`.
      prompt: buildVimeoUserPrompt(transcript, { videoId: meta.videoId, frames }),
      systemPrompt,
      config,
      botConfig: runBot,
      attachRun,
      onProgress,
      // `--add-dir` only when there is something to read: an empty extraDirs
      // would still flip the connector's file-access mode for nothing.
      ...(frames.length > 0 ? { extraDirs: [workDir] } : {}),
      timeoutMs: summarizeTimeoutFor(frames.length, CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS),
      ...(captureThinkingFor(meta.preset) === null ? { thinkingMaxTokens: null } : {}),
      extraTraceAttrs: {
        captionLang,
        captionKind: captionKindOnDocument,
        summaryKind: meta.preset.id,
        summaryLang: outputLang,
        frames: framesOutcome,
        frameCount: String(frames.length),
      },
    });

    // The post-model tail, in ONE function (`./finish.ts`) so a re-run cannot do
    // it differently — see its header for the step this vertical deliberately
    // does NOT have.
    const { category, summary, kept: keptFrames } = await finishVimeoSummary({
      raw: result.result,
      jobId,
      videoId: meta.videoId,
      frames,
      ...(resolved.framesRoot !== undefined ? { framesRoot: resolved.framesRoot } : {}),
      onCategory: (c) => setCategory(jobId, c),
    });

    log.info("Summarized {videoId}: category={category}, {tokens} output tokens, {frames} frames read, {kept} quoted", {
      videoId: meta.videoId,
      category,
      tokens: result.outputTokens,
      frames: frames.length,
      kept: keptFrames.length,
    });

    // 3. Ingest (best-effort — the summary already streamed to the client).
    updateStatus(jobId, "ingesting");

    let ingestedDocId: string | undefined;
    await ingestSummary({
      knowledgeApiUrl: config.knowledgeApiUrl,
      ingestPath: "/api/vimeo/ingest",
      body: {
        title: meta.title,
        url: canonicalVimeoUrl(meta.videoId),
        summary,
        category,
        // The CAPTURE date, the same expression youtube/tiktok/article stamp
        // (anthropic alone prefers the source's own publish date): `date` is what
        // the /summaries shelf buckets and sorts on, and stamping oEmbed's
        // upload_date instead filed a talk captured today under the week it was
        // uploaded, below the fold. UTC day, like the siblings — a capture in the
        // first two CEST hours lands under "Yesterday"; shared, not fixed here.
        date: new Date().toISOString().split("T")[0],
        transcript_markdown: transcript,
        caption_lang: captionLang,
        // A stubbed capture is marked ON THE DOCUMENT. The prompt still gets the
        // kind the track claims (the rider is about the text), but a document
        // written off a local .vtt must never be indistinguishable in the corpus
        // from one harvested off vimeo.com.
        caption_kind: stubbed ? "stub" : captionKindOnDocument,
        duration_sec: meta.durationSec,
        // The summary's OWN provenance, beside the caption's: the kind that
        // wrote it and the language it was written in — the RESOLVED one, so a
        // `talk` pick on a Norwegian track lands as `nb`. A Norwegian summary
        // of an English talk is a legitimate document, so neither is
        // derivable from `caption_lang`.
        summary_kind: meta.preset.id,
        summary_lang: outputLang,
        // What oEmbed knew (v2 PR 2). Sent only when non-empty, so an empty
        // string is never on the wire: huginn's own writer skips an empty
        // value too (`if req.author:`), and this side says the same thing
        // rather than relying on it.
        ...(meta.author ? { author: meta.author } : {}),
        ...(meta.uploadDate ? { upload_date: meta.uploadDate } : {}),
        ...(meta.speaker ? { speaker: meta.speaker } : {}),
        ...(meta.thumbnailUrl ? { thumbnail_url: meta.thumbnailUrl } : {}),
      },
      onSimilar: (similar) => setSimilar(jobId, similar),
      onIngested: (info) => {
        ingestedDocId = info.filePath;
      },
    });

    // Tell the caller a document now exists, BEFORE `completeJob` — the job
    // event is what a client reacts to, and a re-POST racing that event must
    // find the claim already recorded. Its own try/catch for the same reason
    // the source-draft trigger below has one: a throw in a caller's hook must
    // not turn a finished capture into an error.
    if (ingestedDocId && onIngested) {
      try {
        onIngested(meta.videoId, ingestedDocId);
      } catch (err) {
        log.error("Vimeo onIngested hook threw for job {jobId} (the capture stands): {error}", {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    completeJob(jobId, summary, category);

    // 4. Fire-and-forget source-page draft, keyed on huginn's stored doc id so a
    //    later run-now click cannot mint a duplicate proposal (same rule as the
    //    youtube vertical).
    //
    //    Its OWN try/catch, and that is load-bearing: this runs after
    //    `completeJob`, its first statements are synchronous (`isWikiReadonly`,
    //    `isReadonlyWikiRoot`), and the job store has no guard against a second
    //    terminal transition — so a throw here reached the catch below and
    //    turned a finished capture's card from complete into error.
    try {
      triggerSourceDraftFromCapture(botConfig, {
        collection: VIMEO_COLLECTION,
        docId: ingestedDocId ?? meta.videoId,
        url: meta.url,
        body: summary,
        sourceTitle: meta.title,
        category,
      });
    } catch (err) {
      log.error("Vimeo source-draft trigger failed for job {jobId} (the capture stands): {error}", {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Vimeo summarization failed for job {jobId}: {error}", { jobId, error: msg });
    failJob(jobId, msg);
  } finally {
    // Segments and unquoted frames. Only ever created by this job, under a
    // name only this job uses; an rm of a dir that was never made is a no-op.
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
