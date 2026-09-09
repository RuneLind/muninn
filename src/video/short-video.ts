/**
 * ONE short-video capture job — TikTok and X video over the same download,
 * transcript, keyframe and summarize pipeline.
 *
 * `src/tiktok/summarizer.ts` and `src/x-article/video.ts` were measured
 * copy-paste twins: the same nine steps in the same order, differing only in
 * values. Every one of those values is a field of {@link ShortVideoSpec} — the
 * duration cap (60 min vs 3 h), the work-dir prefix, the log category and noun,
 * the trace source, how the canonical url and the id are derived, the ingest
 * path and the drafter's collection, and whether the tail warns about degraded
 * frame Reads. Nothing was deleted: a difference that used to be two lines of
 * code is now one line of data, and the two verticals still declare their own.
 *
 * **The job STORE stays each vertical's own.** `src/tiktok/state.ts` and
 * `src/x-article/state.ts` are separate registries — the x-article one is
 * shared with the TEXT path, so `/api/x-articles/jobs` must keep listing video
 * jobs beside article ones — and merging them would change what each endpoint
 * answers. The spec carries the seven store functions this job calls, which is
 * also what keeps `src/video/` from importing either vertical: the dependency
 * points the right way, vertical → engine.
 *
 * The two exported wrappers live in the verticals (`summarizeTikTok`,
 * `summarizeXVideo`), so every route, importer and test that names them is
 * unchanged.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import type { RunMeta, SimilarArticle } from "../summaries/job-store.ts";
import { getLog } from "../logging.ts";
import { ingestSummary, runCaptureOneShot } from "../summaries/summarizer-shared.ts";
import { appendTranscriptSection } from "../summaries/transcript-appendix.ts";
import { captureBotConfigFor, type CapturePreset } from "../summaries/presets.ts";
import {
  buildShortVideoSystemPrompt,
  buildShortVideoUserPrompt,
  type ShortVideoPromptSpec,
} from "./short-video-prompt.ts";
import { finishShortVideoSummary, type ShortVideoFinishSpec } from "./short-video-finish.ts";
import { SHORT_VIDEO_THINKING } from "./short-video-kinds.ts";
import { triggerSourceDraftFromCapture } from "../gardener/source-drafter-run.ts";
import {
  downloadVideo,
  transcribeVideo,
  extractKeyframes,
  summarizeTimeoutFor,
  type Keyframe,
} from "./media.ts";

/**
 * A download budget both verticals have always shared: a 60-min TikTok and a
 * gigabyte-scale X upload both outrun the media module's 120 s short-clip
 * default, and neither ever wanted a different number.
 */
const DOWNLOAD_TIMEOUT_MS = 600_000;

/**
 * The statuses this job moves a card through. Both verticals' stores declare
 * the same eight-value union, of which these five are the ones a short-video
 * capture writes (`pending` is the store's own initial value, and the two
 * terminal ones are `completeJob`/`failJob`'s).
 */
export type ShortVideoStatus =
  | "downloading"
  | "transcribing"
  | "extracting_frames"
  | "summarizing"
  | "ingesting";

/** The job-store writes this job makes — the vertical's own registry, passed in. */
export interface ShortVideoStore {
  attachRun(jobId: string, meta: RunMeta): void;
  updateStatus(jobId: string, status: ShortVideoStatus): void;
  appendText(jobId: string, text: string): void;
  setCategory(jobId: string, category: string): void;
  setSimilar(jobId: string, similar: SimilarArticle[]): void;
  completeJob(jobId: string, summary: string, category: string): void;
  failJob(jobId: string, error: string): void;
}

/** Everything that differs between the TikTok and X-video captures. */
export interface ShortVideoSpec extends ShortVideoPromptSpec, ShortVideoFinishSpec {
  /**
   * Longest video this vertical downloads.
   *
   * TikTok's 60 min is its platform maximum — long-form tutorials and
   * walkthroughs are exactly the captures worth keeping, and the media module's
   * old 10-min short-clip default rejected a 10:19 Claude Code tutorial. X
   * carries genuinely long recordings (2 h+ workshops, talks, interviews), so
   * its cap is 3 h; the first real capture, a 2:21 h Anthropic workshop, tripped
   * the original 20-min one. Raising a cap alone just moves the failure from
   * yt-dlp to whisper, which is why every subprocess timeout below scales with
   * the clip's duration.
   */
  readonly maxDurationSeconds: number;
  /** `muninn-tiktok-<jobId>` / `muninn-x-video-<jobId>` under `tmpdir()`. */
  readonly workDirPrefix: string;
  /** huginn's push endpoint for this vertical. */
  readonly ingestPath: string;
  /** The huginn collection the source-page draft is filed against. */
  readonly collection: string;
  /**
   * The url everything downstream keys on, from yt-dlp's answer and the
   * submitted url. TikTok takes yt-dlp's canonical `/video/<id>` URL as-is; X
   * strips the `/video/N` media-slot suffix yt-dlp's `webpage_url` keeps, since
   * a suffixed url stored on the document would defeat dedup against the same
   * post captured from another media slot.
   */
  readonly canonicalUrl: (dlCanonicalUrl: string, submittedUrl: string) => string;
  /** The id the completion log line names, from the canonical url and yt-dlp's id. */
  readonly idFor: (canonicalUrl: string, dlId: string) => string;
  /**
   * The structured-log KEY that id is recorded under — `videoId` for TikTok,
   * `statusId` for X video.
   *
   * A spec field for the reason `logCategory` is one: the JSONL sink is searched
   * by FIELD, so `statusId` is part of what the X vertical shipped and a merge
   * that quietly renamed it to the neighbour's spelling would change what a
   * saved search matches, with nothing else to notice. Pinned per spec in
   * `short-video.test.ts`.
   */
  readonly idLogKey: string;
  readonly store: ShortVideoStore;
}

export interface ShortVideoOptions {
  /** When false, skip keyframe extraction (transcript-only summary). Default true. */
  frames?: boolean;
  /**
   * The summary KIND this capture writes, resolved by the ROUTE against the
   * summarizer bot's preset set (`findCapturePreset` — an unknown id is a 400
   * there, so a job that gets here carries a real preset).
   *
   * REQUIRED, the YouTube and Vimeo precedent (`src/youtube/summarizer.ts`,
   * `src/vimeo/summarizer.ts`), and for the same measured reason: a default
   * resolved here reads `SHIPPED_CAPTURE_PRESETS`, so a bot whose
   * `prompts/captureSummary.standard.md` overrides the standard kind would have
   * that file silently ignored on any preset-less call — while
   * `/summaries/prompts` shows the override as present. Every caller resolves a
   * preset already; there is nobody for the default to serve.
   *
   * It decides the structure bullets in the system prompt and the model the
   * call runs on (`captureBotConfigFor`). It does NOT decide the thinking
   * budget here — see the `thinkingMaxTokens` note at the model call.
   */
  preset: CapturePreset;
}

export async function summarizeShortVideo(
  spec: ShortVideoSpec,
  jobId: string,
  url: string,
  title: string,
  config: Config,
  botConfig: BotConfig,
  opts: ShortVideoOptions,
): Promise<void> {
  const log = getLog(spec.logCategory[0], spec.logCategory[1]);
  const { updateStatus, appendText, setSimilar, setCategory, completeJob, failJob, attachRun } =
    spec.store;
  const framesEnabled = opts.frames !== false;
  const { preset } = opts;
  const workDir = join(tmpdir(), `${spec.workDirPrefix}${jobId}`);

  try {
    await mkdir(workDir, { recursive: true });

    // 1. Download the video (yt-dlp). Gives the canonical URL, uploader,
    //    duration and title.
    updateStatus(jobId, "downloading");
    const dl = await downloadVideo(url, workDir, {
      maxDurationSeconds: spec.maxDurationSeconds,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });

    const canonicalUrl = spec.canonicalUrl(dl.canonicalUrl, url);

    // 2. Transcribe (empty transcript is fine — music/visual-only clips).
    //    Timeouts scale with the clip: whisper gets 1x realtime, the wav extract
    //    0.2x. Deliberate slack, not a fit — measured on this machine, base.en
    //    transcribed a 619s clip in 12.6s and a 3716s one in 41.8s (~50-90x
    //    realtime), so the budget is ~two orders of magnitude of headroom.
    updateStatus(jobId, "transcribing");
    const transcript = await transcribeVideo(dl.videoPath, config, {
      whisperTimeoutMs: Math.max(120_000, Math.round(dl.duration * 1000)),
      audioTimeoutMs: Math.max(60_000, Math.round(dl.duration * 200)),
    });

    // 3. Extract keyframes (unless disabled). A failure here degrades to a
    //    transcript-only summary rather than killing a job whose speech is good.
    let frames: Keyframe[] = [];
    if (framesEnabled) {
      updateStatus(jobId, "extracting_frames");
      try {
        frames = await extractKeyframes(dl.videoPath, workDir, {
          durationSeconds: dl.duration,
          frameTimeoutMs: Math.max(60_000, Math.round(dl.duration * 500)),
        });
      } catch (err) {
        log.warn("Keyframe extraction failed for job {jobId} — falling back to transcript-only: {error}", {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Nothing to summarize: no speech AND no frames.
    if (!transcript && frames.length === 0) {
      failJob(
        jobId,
        framesEnabled
          ? "Nothing to summarize: no speech detected and no keyframes could be extracted"
          : "Nothing to summarize: no speech detected and frames are disabled",
      );
      return;
    }

    // 4. Summarize with Claude. Via executeOneShot's opts we (a) grant Read
    //    access to the tmp frame dir via `extraDirs` → CLI `--add-dir`
    //    (non-interactive claude auto-denies paths outside the bot dir
    //    otherwise), and (b) raise the timeout — the multi-turn frame-reading
    //    session easily outruns the default 120s. `extraDirs` is CLI-only; both
    //    routes pre-flight the connector's supportsExtraDirs capability before
    //    kicking this expensive job.
    updateStatus(jobId, "summarizing");

    const ingestTitle = title !== url ? title : dl.title || canonicalUrl;

    // Both prompts are composed by `./short-video-prompt.ts` — one module, so a
    // second caller (the prompts page today, a re-run later) can compose the
    // same bytes from the same inputs.
    //
    // `frames` is one of those inputs and is stated from what this run actually
    // has, never from `framesEnabled`: the list is empty on a frames-off capture
    // AND on a capture whose extraction failed above, and the frames-present
    // prompt over an empty list orders the model to read images the user prompt
    // does not list, says it is using BOTH, and asks it to mark what is
    // visual-only.
    const systemPrompt = buildShortVideoSystemPrompt(spec, {
      preset,
      title: ingestTitle,
      url: canonicalUrl,
      author: dl.uploader,
      frames: frames.length > 0,
    });
    const userPrompt = buildShortVideoUserPrompt({ transcript, frames });

    const onProgress: StreamProgressCallback = (event) => {
      if (event.type === "text_delta") {
        appendText(jobId, event.text);
      }
    };

    const result = await runCaptureOneShot({
      source: spec.id,
      jobId,
      title: ingestTitle,
      url: canonicalUrl,
      prompt: userPrompt,
      systemPrompt,
      config,
      // `deep` swaps the model BEFORE the seam, which is what stamps the
      // requested model onto the /agents card and the trace span.
      botConfig: captureBotConfigFor(botConfig, preset),
      attachRun,
      onProgress,
      extraDirs: [workDir],
      timeoutMs: summarizeTimeoutFor(frames.length, botConfig.timeoutMs ?? config.claudeTimeoutMs),
      // The bot's OWN thinking budget, on every kind — this vertical's answer
      // since before the picker existed, and unchanged by it.
      //
      // Reading the keyframes (up to `FRAME_BUDGET_MAX` of them) IS the
      // reasoning in a short-video capture, and as a background job with no
      // reader waiting on the first token there is no dead-air to buy back. The
      // 8k knee `CAPTURE_THINKING_MAX_TOKENS` names was measured on a TEXT-ONLY
      // YouTube transcript (2.3k words, jarvis/claude-sdk); nothing has measured
      // it against a multi-turn frame-reading session, which is the only work
      // this call does. Routing `standard` through the cap would have moved every
      // ordinary capture here onto an unmeasured budget, and no kind would have
      // reproduced the old default — `deep` swaps the MODEL to opus as well, so
      // it is a different call, not the previous one under another name.
      //
      // A named constant (`./short-video-kinds.ts`) rather than the literal,
      // because `/summaries/prompts` shows this budget as a chip and would
      // otherwise read it off the PRESET — which says `capped`.
      thinkingMaxTokens: SHORT_VIDEO_THINKING,
    });

    // 5. The post-model tail, in ONE function (`./short-video-finish.ts`) so a
    //    re-run cannot drop the degraded-frame-Reads warn — nor acquire it on
    //    the vertical that never had it.
    const { category, summary } = finishShortVideoSummary(spec, {
      raw: result.result,
      jobId,
      videoId: spec.idFor(canonicalUrl, dl.id),
      frameCount: frames.length,
      onCategory: (c) => setCategory(jobId, c),
    });

    log.info(
      `Summarized ${spec.noun} {${spec.idLogKey}}: category={category}, kind={kind}, {frames} frames, {tokens} output tokens`,
      {
        [spec.idLogKey]: spec.idFor(canonicalUrl, dl.id),
        category,
        kind: preset.id,
        frames: frames.length,
        tokens: result.outputTokens,
      },
    );

    // 6. Ingest into the knowledge base (best-effort). Always the canonical URL
    //    — a raw short link or a media-slot suffix stored here silently defeats
    //    dedup.
    updateStatus(jobId, "ingesting");

    // The transcript rides the SUMMARY string: neither huginn ingest has a
    // `transcript_markdown` field, so the summary IS the document body. FLAT,
    // because whisper's answer has no `### [HH:MM:SS]` windows to keep whole —
    // the window capper would throw a one-paragraph transcript away entirely.
    // `completeJob`, the shelf card and the source draft get the summary alone.
    const ingestBody = transcript ? appendTranscriptSection(summary, transcript, undefined, false) : null;
    if (ingestBody?.truncated) {
      // The one consumer of the cap's own answer: without it, a capture whose
      // transcript did not fit is invisible outside the stored file.
      log.warn(
        "{noun} capture {jobId}: transcript truncated ({transcriptBytes} bytes in, {keptBytes} kept)",
        {
          noun: spec.noun,
          jobId,
          transcriptBytes: ingestBody.inputBytes,
          keptBytes: ingestBody.keptBytes,
        },
      );
    }

    let ingestedDocId: string | undefined;
    await ingestSummary({
      knowledgeApiUrl: config.knowledgeApiUrl,
      ingestPath: spec.ingestPath,
      body: {
        title: ingestTitle,
        url: canonicalUrl,
        author: dl.uploader,
        summary: ingestBody?.text ?? summary,
        category,
        date: new Date().toISOString().split("T")[0],
        // The SUMMARY's own provenance — which kind wrote this body — on the
        // same key and with the same meaning as every other vertical's. Sent
        // always, `standard` included, so *absent* keeps meaning "written
        // before kinds existed". huginn's tiktok/x-articles ingest models do
        // not declare the field yet and pydantic drops it; the YouTube ingest
        // learned it in huginn #130 and these two are the follow-up.
        summary_kind: preset.id,
      },
      onSimilar: (similar) => setSimilar(jobId, similar),
      onIngested: (info) => {
        ingestedDocId = info.filePath;
      },
    });

    // 7. Complete.
    completeJob(jobId, summary, category);

    // 8. Fire-and-forget: draft a per-article source page from this summary.
    //    Prefer huginn's stored doc id; fall back to the videoId when the ingest
    //    returned no file_path. Skips silently when the bot has no wikiDir;
    //    never fails the job.
    triggerSourceDraftFromCapture(botConfig, {
      collection: spec.collection,
      docId: ingestedDocId ?? dl.id,
      url: canonicalUrl,
      body: summary,
      sourceTitle: ingestTitle,
      category,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`${spec.noun} summarization failed for job {jobId}: {error}`, { jobId, error: msg });
    failJob(jobId, msg);
  } finally {
    // Frames must outlive the Claude call (unlike stt.ts's immediate cleanup),
    // so the work dir is only removed here, after summarization.
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
