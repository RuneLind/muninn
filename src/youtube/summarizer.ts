import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { executeClaudePrompt } from "../ai/executor.ts";
import { getLog } from "../logging.ts";
import { VALID_CATEGORIES, parseSummaryResponse } from "../utils/summary-parser.ts";
import { buildSummarySystemPrompt, ingestSummary } from "../summaries/summarizer-shared.ts";
import {
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

export async function summarizeVideo(
  jobId: string,
  videoId: string,
  title: string,
  url: string,
  config: Config,
  botConfig: BotConfig,
): Promise<void> {
  try {
    // 1. Fetch transcript
    updateStatus(jobId, "fetching_transcript");

    const transcriptUrl = `${config.knowledgeApiUrl}/api/youtube/transcript/${videoId}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let transcriptText: string;
    try {
      const res = await fetch(transcriptUrl, { signal: controller.signal });
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

    log.info("Fetched transcript for {videoId}, {length} chars", {
      videoId,
      length: transcriptText.length,
    });

    // 2. Summarize with Claude
    updateStatus(jobId, "summarizing");

    const systemPrompt = `${SUMMARIZE_SYSTEM_PROMPT}

Video title: ${title}
Video URL: ${url}`;

    const onProgress: StreamProgressCallback = (event) => {
      if (event.type === "text_delta") {
        appendText(jobId, event.text);
      }
    };

    const result = await executeClaudePrompt(
      transcriptText,
      config,
      botConfig,
      systemPrompt,
      onProgress,
    );

    // 3. Parse response
    const { category, summary } = parseSummaryResponse(result.result);
    setCategory(jobId, category);

    log.info("Summarized {videoId}: category={category}, {tokens} output tokens", {
      videoId,
      category,
      tokens: result.outputTokens,
    });

    // 4. Ingest into knowledge base (best-effort)
    updateStatus(jobId, "ingesting");

    await ingestSummary({
      knowledgeApiUrl: config.knowledgeApiUrl,
      ingestPath: "/api/youtube/ingest",
      body: {
        title,
        url,
        summary,
        category,
        date: new Date().toISOString().split("T")[0],
      },
      onSimilar: (similar) => setSimilar(jobId, similar),
    });

    // 5. Complete
    completeJob(jobId, summary, category);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("YouTube summarization failed for job {jobId}: {error}", { jobId, error: msg });
    failJob(jobId, msg);
  }
}
