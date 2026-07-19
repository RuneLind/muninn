import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { getLog } from "../logging.ts";
import { VALID_CATEGORIES, parseSummaryResponse } from "../utils/summary-parser.ts";
import { buildSummarySystemPrompt, ingestSummary, runCaptureOneShot } from "../summaries/summarizer-shared.ts";
import {
  attachRun,
  updateStatus,
  appendText,
  setCategory,
  setSimilar,
  completeJob,
  failJob,
} from "./state.ts";

const log = getLog("article", "summarizer");

const SUMMARIZE_SYSTEM_PROMPT = buildSummarySystemPrompt(
  "You are a content analyst. Summarize the following article.",
  VALID_CATEGORIES,
);

export async function summarizeArticle(
  jobId: string,
  title: string,
  url: string,
  author: string,
  articleText: string,
  config: Config,
  botConfig: BotConfig,
): Promise<void> {
  try {
    // 1. Summarize with Claude
    updateStatus(jobId, "summarizing");

    // Only surface the context lines we actually have — a pasted article may
    // carry no url and no author.
    const contextLines = [
      `Article title: ${title}`,
      ...(author ? [`Article author: ${author}`] : []),
      ...(url ? [`Article URL: ${url}`] : []),
    ];
    const systemPrompt = `${SUMMARIZE_SYSTEM_PROMPT}

${contextLines.join("\n")}`;

    const onProgress: StreamProgressCallback = (event) => {
      if (event.type === "text_delta") {
        appendText(jobId, event.text);
      }
    };

    const result = await runCaptureOneShot({
      source: "article",
      jobId,
      title,
      url, // required string on the trace; "" when no URL was pasted
      prompt: articleText,
      systemPrompt,
      config,
      botConfig,
      attachRun,
      onProgress,
    });

    // 2. Parse response
    const { category, summary } = parseSummaryResponse(result.result);
    setCategory(jobId, category);

    log.info("Summarized article {title}: category={category}, {tokens} output tokens", {
      title,
      category,
      tokens: result.outputTokens,
    });

    // 3. Ingest into knowledge base (best-effort). url/author are optional at
    // the huginn `/api/articles/ingest` endpoint — omit them when absent so a
    // URL-less doc forks rather than being keyed on an empty url.
    updateStatus(jobId, "ingesting");

    await ingestSummary({
      knowledgeApiUrl: config.knowledgeApiUrl,
      ingestPath: "/api/articles/ingest",
      body: {
        title,
        summary,
        category,
        ...(url ? { url } : {}),
        ...(author ? { author } : {}),
        date: new Date().toISOString().split("T")[0],
      },
      onSimilar: (similar) => setSimilar(jobId, similar),
    });

    // 4. Complete
    completeJob(jobId, summary, category);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Article summarization failed for job {jobId}: {error}", { jobId, error: msg });
    failJob(jobId, msg);
  }
}
