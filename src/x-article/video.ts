import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { getLog } from "../logging.ts";
import { VALID_CATEGORIES, parseSummaryResponse } from "../utils/summary-parser.ts";
import { ingestSummary, runCaptureOneShot, SUMMARY_STRUCTURE_BULLETS } from "../summaries/summarizer-shared.ts";
import { triggerSourceDraftFromCapture } from "../gardener/source-drafter-run.ts";
import {
  downloadVideo,
  transcribeVideo,
  extractKeyframes,
  canonicalXStatusUrl,
  extractXStatusId,
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

const log = getLog("x-article", "video");

// X carries genuinely long recordings (2h+ workshop uploads, talks, interviews)
// and those are exactly the high-value captures, so the cap is 3 hours rather
// than TikTok's 10 min. Every subprocess timeout scales with duration below
// instead of riding the media module's short-clip defaults; the first real
// capture (a 2:21h Anthropic workshop) tripped the original 20-min cap.
const MAX_DURATION_SECONDS = 10800;

// Gigabyte-scale downloads outrun the 120s short-clip default.
const DOWNLOAD_TIMEOUT_MS = 600_000;

// Mirrors the TikTok prompt — the "no commentary" line is load-bearing (see
// src/tiktok/summarizer.ts): without it the model narrates between frame Reads
// and the chatter leaks into the streamed shelf card.
const SUMMARIZE_SYSTEM_PROMPT = `You are a video content analyst. Summarize the following X/Twitter video, using BOTH its speech transcript and the extracted keyframe images.

Instructions:
1. Read ALL the frame images listed below (with the Read tool) FIRST, batching many Read tool calls into one turn (parallel tool calls) — do NOT read one frame per message. X videos often carry key information on screen — capture slides, charts, code, captions, and visual demos.
2. Note explicitly when key information is visual-only (not spoken).
3. Start your response with EXACTLY this line: CATEGORY: <category>
   Choose from: ${VALID_CATEGORIES.join(", ")}
4. Then add a blank line, then SUMMARY: on its own line
5. Then write a structured summary with:
   ${SUMMARY_STRUCTURE_BULLETS.join("\n   ")}
6. CRITICAL: produce NO commentary — your only text output is the final CATEGORY/SUMMARY response. Do not narrate the frames as you read them.`;

export interface SummarizeVideoOptions {
  /** When false, skip keyframe extraction (transcript-only summary). Default true. */
  frames?: boolean;
}

/** Format a timestamp (seconds) as `M:SS` for the frame list. */
function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/** Build the `t=M:SS <path>` frame list block for the user prompt. */
function frameListBlock(frames: Keyframe[]): string {
  return frames.map((f) => `t=${formatTimestamp(f.tSeconds)} ${f.path}`).join("\n");
}

/**
 * Summarize an X/Twitter video post: yt-dlp download → whisper transcript →
 * keyframes → frame-reading Claude one-shot → ingest into the `x-articles`
 * collection (so it shelves under the X badge next to article captures).
 */
export async function summarizeXVideo(
  jobId: string,
  url: string,
  title: string,
  config: Config,
  botConfig: BotConfig,
  opts: SummarizeVideoOptions = {},
): Promise<void> {
  const framesEnabled = opts.frames !== false;
  const workDir = join(tmpdir(), `muninn-x-video-${jobId}`);

  try {
    await mkdir(workDir, { recursive: true });

    // 1. Download (yt-dlp supports X natively). Gives duration, uploader, title.
    updateStatus(jobId, "downloading");
    const dl = await downloadVideo(url, workDir, {
      maxDurationSeconds: MAX_DURATION_SECONDS,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });

    // Key ingest + dedup on the bare status URL, not yt-dlp's /video/1-suffixed
    // webpage_url (media-slot suffixes would defeat URL dedup on the shelf).
    const canonicalUrl = canonicalXStatusUrl(dl.canonicalUrl) ?? canonicalXStatusUrl(url) ?? url;

    // 2. Transcribe. Empty transcript is fine (music/caption-only clips).
    //    Timeouts scale with the clip: whisper gets ~1× realtime (base.en runs
    //    ~10×, so this is generous headroom), the wav extract ~0.2× realtime.
    updateStatus(jobId, "transcribing");
    const transcript = await transcribeVideo(dl.videoPath, config, {
      whisperTimeoutMs: Math.max(120_000, Math.round(dl.duration * 1000)),
      audioTimeoutMs: Math.max(60_000, Math.round(dl.duration * 200)),
    });

    // 3. Keyframes (unless disabled) — a failure degrades to transcript-only.
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

    if (!transcript && frames.length === 0) {
      failJob(
        jobId,
        framesEnabled
          ? "Nothing to summarize: no speech detected and no keyframes could be extracted"
          : "Nothing to summarize: no speech detected and frames are disabled",
      );
      return;
    }

    // 4. Summarize. Same seam + knobs as TikTok: extraDirs grants frame Read
    //    access, the 600s floor covers the multi-turn frame session, and the
    //    bot's own thinking budget is kept (frame reading IS the reasoning).
    updateStatus(jobId, "summarizing");

    const ingestTitle = title !== url ? title : dl.title || canonicalUrl;

    const systemPrompt = `${SUMMARIZE_SYSTEM_PROMPT}

Video title: ${ingestTitle}
Video URL: ${canonicalUrl}
Author: ${dl.uploader}`;

    const transcriptSection = transcript
      ? `Transcript:\n${transcript}`
      : "No speech detected — summarize from the frames.";
    const framesSection =
      frames.length > 0
        ? `\n\nKeyframes (read each image before summarizing):\n${frameListBlock(frames)}`
        : "";
    const userPrompt = `${transcriptSection}${framesSection}`;

    const onProgress: StreamProgressCallback = (event) => {
      if (event.type === "text_delta") {
        appendText(jobId, event.text);
      }
    };

    const result = await runCaptureOneShot({
      source: "x-video",
      jobId,
      title: ingestTitle,
      url: canonicalUrl,
      prompt: userPrompt,
      systemPrompt,
      config,
      botConfig,
      attachRun,
      onProgress,
      extraDirs: [workDir],
      timeoutMs: Math.max(botConfig.timeoutMs ?? config.claudeTimeoutMs, 600_000),
      thinkingMaxTokens: null,
    });

    // 5. Parse response.
    const { category, summary } = parseSummaryResponse(result.result);
    setCategory(jobId, category);

    log.info("Summarized X video {statusId}: category={category}, {frames} frames, {tokens} output tokens", {
      statusId: extractXStatusId(canonicalUrl) ?? dl.id,
      category,
      frames: frames.length,
      tokens: result.outputTokens,
    });

    // 6. Ingest into the x-articles collection (best-effort) under the bare
    //    status URL so it dedups against future captures of the same post.
    updateStatus(jobId, "ingesting");

    let ingestedDocId: string | undefined;
    await ingestSummary({
      knowledgeApiUrl: config.knowledgeApiUrl,
      ingestPath: "/api/x-articles/ingest",
      body: {
        title: ingestTitle,
        url: canonicalUrl,
        author: dl.uploader,
        summary,
        category,
        date: new Date().toISOString().split("T")[0],
      },
      onSimilar: (similar) => setSimilar(jobId, similar),
      onIngested: (info) => {
        ingestedDocId = info.filePath;
      },
    });

    // 7. Complete.
    completeJob(jobId, summary, category);

    // 8. Fire-and-forget source-page draft, same as the article path.
    triggerSourceDraftFromCapture(botConfig, {
      collection: "x-articles",
      docId: ingestedDocId ?? dl.id,
      url: canonicalUrl,
      body: summary,
      sourceTitle: ingestTitle,
      category,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("X video summarization failed for job {jobId}: {error}", { jobId, error: msg });
    failJob(jobId, msg);
  } finally {
    // Frames must outlive the Claude call — clean up only after summarization.
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
