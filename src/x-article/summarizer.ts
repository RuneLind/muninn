import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { getLog } from "../logging.ts";
import { VALID_CATEGORIES, parseSummaryResponse } from "../utils/summary-parser.ts";
import { buildSummarySystemPrompt, ingestSummary, runCaptureOneShot } from "../summaries/summarizer-shared.ts";
import { triggerSourceDraftFromCapture } from "../gardener/source-drafter-run.ts";
import {
  attachRun,
  updateStatus,
  appendText,
  setCategory,
  setSimilar,
  completeJob,
  failJob,
} from "./state.ts";

const log = getLog("x-article", "summarizer");

const SUMMARIZE_SYSTEM_PROMPT = buildSummarySystemPrompt(
  "You are a content analyst. Summarize the following X/Twitter article.",
  VALID_CATEGORIES,
);

export async function summarizeArticle(
  jobId: string,
  articleId: string,
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

    const systemPrompt = `${SUMMARIZE_SYSTEM_PROMPT}

Article title: ${title}
Article author: @${author}
Article URL: ${url}`;

    const onProgress: StreamProgressCallback = (event) => {
      if (event.type === "text_delta") {
        appendText(jobId, event.text);
      }
    };

    const result = await runCaptureOneShot({
      source: "x-article",
      jobId,
      title,
      url,
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

    log.info("Summarized X article {articleId}: category={category}, {tokens} output tokens", {
      articleId,
      category,
      tokens: result.outputTokens,
    });

    // 3. Ingest into knowledge base (best-effort)
    updateStatus(jobId, "ingesting");

    // Capture huginn's stored doc id (`file_path`) so the source-draft trigger keys
    // off the SAME id the run-now drafter uses — see the youtube vertical for why.
    let ingestedDocId: string | undefined;
    await ingestSummary({
      knowledgeApiUrl: config.knowledgeApiUrl,
      ingestPath: "/api/x-articles/ingest",
      body: {
        title,
        url,
        author,
        summary,
        category,
        date: new Date().toISOString().split("T")[0],
      },
      onSimilar: (similar) => setSimilar(jobId, similar),
      onIngested: (info) => {
        ingestedDocId = info.filePath;
      },
    });

    // 4. Complete
    completeJob(jobId, summary, category);

    // 5. Fire-and-forget: draft a per-article source page from this summary. Prefer
    //    huginn's stored doc id; fall back to the articleId when ingest returned no
    //    file_path. Skips silently when the bot has no wikiDir; never fails the job.
    triggerSourceDraftFromCapture(botConfig, {
      collection: "x-articles",
      docId: ingestedDocId ?? articleId,
      url,
      body: summary,
      sourceTitle: title,
      category,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("X article summarization failed for job {jobId}: {error}", { jobId, error: msg });
    failJob(jobId, msg);
  }
}
