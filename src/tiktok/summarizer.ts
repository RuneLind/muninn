import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { getLog } from "../logging.ts";
import { ingestSummary, runCaptureOneShot } from "../summaries/summarizer-shared.ts";
import { buildTikTokSystemPrompt, buildTikTokUserPrompt } from "./prompt.ts";
import { finishTikTokSummary } from "./finish.ts";
import { triggerSourceDraftFromCapture } from "../gardener/source-drafter-run.ts";
import {
  downloadVideo,
  transcribeVideo,
  extractKeyframes,
  summarizeTimeoutFor,
  type Keyframe,
} from "../video/media.ts";
import {
  attachRun,
  updateStatus,
  appendText,
  setCategory,
  setSimilar,
  completeJob,
  failJob,
} from "./state.ts";

const log = getLog("tiktok", "summarizer");

// TikTok's own platform maximum is 60 min, and long-form uploads (tutorials,
// walkthroughs) are exactly the captures worth keeping — the media module's
// 10-min short-clip default rejected a 10:19 Claude Code tutorial. Every
// subprocess timeout below scales with duration for the same reason X video
// does (src/x-article/video.ts): raising the cap alone just moves the failure
// from yt-dlp to whisper.
const MAX_DURATION_SECONDS = 3600;

// A 60-min download outruns the 120s short-clip default.
const DOWNLOAD_TIMEOUT_MS = 600_000;

export interface SummarizeOptions {
  /** When false, skip keyframe extraction (transcript-only summary). Default true. */
  frames?: boolean;
}

export async function summarizeTikTok(
  jobId: string,
  url: string,
  title: string,
  config: Config,
  botConfig: BotConfig,
  opts: SummarizeOptions = {},
): Promise<void> {
  const framesEnabled = opts.frames !== false;
  const workDir = join(tmpdir(), `muninn-tiktok-${jobId}`);

  try {
    await mkdir(workDir, { recursive: true });

    // 1. Download the video (yt-dlp). Gives the canonical /video/<id> URL,
    //    uploader, duration and title.
    updateStatus(jobId, "downloading");
    const dl = await downloadVideo(url, workDir, {
      maxDurationSeconds: MAX_DURATION_SECONDS,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });

    // 2. Transcribe (empty transcript is fine — music/visual-only TikToks).
    //    Timeouts scale with the clip: whisper gets 1x realtime, the wav extract
    //    0.2x. Deliberate slack, not a fit — measured on this machine, base.en
    //    transcribed the 619s clip in 12.6s and a 3716s one in 41.8s (~50-90x
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
    //    session easily outruns the default 120s. `extraDirs` is CLI-only; the
    //    tiktok route pre-flights the connector's supportsExtraDirs capability
    //    before kicking this expensive job.
    updateStatus(jobId, "summarizing");

    const ingestTitle = title !== url ? title : dl.title || dl.canonicalUrl;

    // Both compositions are `./prompt.ts`, so the re-run and `/summaries/prompts`
    // send and show exactly what this call does.
    const systemPrompt = buildTikTokSystemPrompt({
      title: ingestTitle,
      url: dl.canonicalUrl,
      author: dl.uploader,
    });
    const userPrompt = buildTikTokUserPrompt({ transcript, frames });

    const onProgress: StreamProgressCallback = (event) => {
      if (event.type === "text_delta") {
        appendText(jobId, event.text);
      }
    };

    const result = await runCaptureOneShot({
      source: "tiktok",
      jobId,
      title: ingestTitle,
      url: dl.canonicalUrl,
      prompt: userPrompt,
      systemPrompt,
      config,
      botConfig,
      attachRun,
      onProgress,
      extraDirs: [workDir],
      timeoutMs: summarizeTimeoutFor(frames.length, botConfig.timeoutMs ?? config.claudeTimeoutMs),
      // Keep the bot's own thinking budget (the other verticals cap it):
      // reading the keyframes (up to FRAME_BUDGET_MAX of them) IS the reasoning
      // here, and as a background job with no reader waiting on the first token
      // there's no dead-air to buy back.
      thinkingMaxTokens: null,
    });

    // 5. The post-model tail, in ONE function (`./finish.ts`) so a re-run cannot
    //    drop the degraded-frame-Reads warn.
    const { category, summary } = finishTikTokSummary({
      raw: result.result,
      jobId,
      videoId: dl.id,
      frameCount: frames.length,
      onCategory: (c) => setCategory(jobId, c),
    });

    log.info("Summarized TikTok {videoId}: category={category}, {frames} frames, {tokens} output tokens", {
      videoId: dl.id,
      category,
      frames: frames.length,
      tokens: result.outputTokens,
    });

    // 6. Ingest into the knowledge base (best-effort). Always use the canonical
    //    /video/<id> URL — a raw short link stored here yields no id and silently
    //    defeats dedup.
    updateStatus(jobId, "ingesting");

    let ingestedDocId: string | undefined;
    await ingestSummary({
      knowledgeApiUrl: config.knowledgeApiUrl,
      ingestPath: "/api/tiktok/ingest",
      body: {
        title: ingestTitle,
        url: dl.canonicalUrl,
        summary,
        category,
        date: new Date().toISOString().split("T")[0],
        author: dl.uploader,
      },
      onSimilar: (similar) => setSimilar(jobId, similar),
      onIngested: (info) => {
        ingestedDocId = info.filePath;
      },
    });

    // 7. Complete.
    completeJob(jobId, summary, category);

    // 8. Fire-and-forget: draft a per-article source page from this summary. Prefer
    //    huginn's stored doc id; fall back to the videoId when ingest returned no
    //    file_path. Skips silently when the bot has no wikiDir; never fails the job.
    triggerSourceDraftFromCapture(botConfig, {
      collection: "tiktok-summaries",
      docId: ingestedDocId ?? dl.id,
      url: dl.canonicalUrl,
      body: summary,
      sourceTitle: ingestTitle,
      category,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("TikTok summarization failed for job {jobId}: {error}", { jobId, error: msg });
    failJob(jobId, msg);
  } finally {
    // Frames must outlive the Claude call (unlike stt.ts's immediate cleanup),
    // so the work dir is only removed here, after summarization.
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
