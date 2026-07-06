import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { executeClaudePrompt } from "../ai/executor.ts";
import { getLog } from "../logging.ts";
import { VALID_CATEGORIES, parseSummaryResponse } from "../utils/summary-parser.ts";
import { ingestSummary } from "../summaries/summarizer-shared.ts";
import {
  downloadVideo,
  transcribeVideo,
  extractKeyframes,
  type Keyframe,
} from "./media.ts";
import {
  updateStatus,
  appendText,
  setCategory,
  setSimilar,
  completeJob,
  failJob,
} from "./state.ts";

const log = getLog("tiktok", "summarizer");

// The summarizer reads each frame image before it writes the CATEGORY/SUMMARY —
// a multi-turn agentic session. The "no commentary" line is load-bearing: without
// it the model narrates ("let me look at frame 3…") between Read calls and that
// chatter leaks into the streamed shelf card.
const SUMMARIZE_SYSTEM_PROMPT = `You are a video content analyst. Summarize the following TikTok video, using BOTH its speech transcript and the extracted keyframe images.

Instructions:
1. Read ALL the frame images listed below (with the Read tool) FIRST, batching many Read tool calls into one turn (parallel tool calls) — do NOT read one frame per message. TikToks often carry most of their information on screen — capture diagrams, code, on-screen text, and visual demos.
2. Note explicitly when key information is visual-only (not spoken).
3. Start your response with EXACTLY this line: CATEGORY: <category>
   Choose from: ${VALID_CATEGORIES.join(", ")}
4. Then add a blank line, then SUMMARY: on its own line
5. Then write a structured summary with:
   - ### Section headers for key topics
   - Bullet points with emoji prefixes
   - **Bold** for key terms and takeaways
   - Keep it concise but comprehensive
6. CRITICAL: produce NO commentary — your only text output is the final CATEGORY/SUMMARY response. Do not narrate the frames as you read them.`;

export interface SummarizeOptions {
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
 * Cheap heuristic: did a frames-on summary actually mention any visual content?
 * If not, the frame Reads likely silently degraded (permissions / --add-dir
 * regression) and we lost the whole visual-summary value — surface a warning.
 */
function mentionsVisualContent(summary: string): boolean {
  return /\b(frame|image|visual|screen|on-screen|diagram|slide|chart|shown|display|graphic|caption|text overlay)\b/i.test(
    summary,
  );
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
    const dl = await downloadVideo(url, workDir);

    // 2. Transcribe (empty transcript is fine — music/visual-only TikToks).
    updateStatus(jobId, "transcribing");
    const transcript = await transcribeVideo(dl.videoPath, config);

    // 3. Extract keyframes (unless disabled). A failure here degrades to a
    //    transcript-only summary rather than killing a job whose speech is good.
    let frames: Keyframe[] = [];
    if (framesEnabled) {
      updateStatus(jobId, "extracting_frames");
      try {
        frames = await extractKeyframes(dl.videoPath, workDir, {
          durationSeconds: dl.duration,
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

    // 4. Summarize with Claude. The botConfig clone (a) grants Read access to the
    //    tmp frame dir via --add-dir (non-interactive claude auto-denies paths
    //    outside the bot dir otherwise), and (b) raises the timeout — the
    //    multi-turn frame-reading session easily outruns the default 120s.
    updateStatus(jobId, "summarizing");

    const ingestTitle = title !== url ? title : dl.title || dl.canonicalUrl;

    const systemPrompt = `${SUMMARIZE_SYSTEM_PROMPT}

Video title: ${ingestTitle}
Video URL: ${dl.canonicalUrl}
Author: ${dl.uploader}`;

    const transcriptSection = transcript
      ? `Transcript:\n${transcript}`
      : "No speech detected — summarize from the frames.";
    const framesSection =
      frames.length > 0
        ? `\n\nKeyframes (read each image before summarizing):\n${frameListBlock(frames)}`
        : "";
    const userPrompt = `${transcriptSection}${framesSection}`;

    const tiktokBotConfig: BotConfig = {
      ...botConfig,
      spawnArgs: [...(botConfig.spawnArgs ?? []), "--add-dir", workDir],
      // 600s floor: a live 72s/25-frame run blew through 300s on a slow bot
      // (opus + thinking) — this is a background job, nothing blocks on it.
      timeoutMs: Math.max(botConfig.timeoutMs ?? config.claudeTimeoutMs, 600_000),
    };

    const onProgress: StreamProgressCallback = (event) => {
      if (event.type === "text_delta") {
        appendText(jobId, event.text);
      }
    };

    const result = await executeClaudePrompt(
      userPrompt,
      config,
      tiktokBotConfig,
      systemPrompt,
      onProgress,
    );

    // 5. Parse response.
    const { category, summary } = parseSummaryResponse(result.result);
    setCategory(jobId, category);

    if (frames.length > 0 && !mentionsVisualContent(summary)) {
      log.warn("Frames-on TikTok summary for job {jobId} mentions no visual content — frame Reads may have degraded", {
        jobId,
        videoId: dl.id,
      });
    }

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
    });

    // 7. Complete.
    completeJob(jobId, summary, category);
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
