import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { executeClaudePrompt } from "../ai/executor.ts";
import { getLog } from "../logging.ts";
import { VALID_CATEGORIES, parseSummaryResponse } from "../utils/summary-parser.ts";
import {
  updateStatus,
  appendText,
  setCategory,
  setSimilar,
  completeJob,
  failJob,
} from "./state.ts";

const log = getLog("x-article", "summarizer");

const SUMMARIZE_SYSTEM_PROMPT = `You are a content analyst. Summarize the following X/Twitter article.

Instructions:
1. Start your response with EXACTLY this line: CATEGORY: <category>
   Choose from: ${VALID_CATEGORIES.join(", ")}
2. Then add a blank line, then SUMMARY: on its own line
3. Then write a structured summary with:
   - ### Section headers for key topics
   - Bullet points with emoji prefixes
   - **Bold** for key terms and takeaways
   - Keep it concise but comprehensive`;

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

    const result = await executeClaudePrompt(
      articleText,
      config,
      botConfig,
      systemPrompt,
      onProgress,
    );

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

    try {
      const ingestUrl = `${config.knowledgeApiUrl}/api/x-articles/ingest`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const ingestRes = await fetch(ingestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          url,
          author,
          summary,
          category,
          date: new Date().toISOString().split("T")[0],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (ingestRes.ok) {
        const ingestData = await ingestRes.json() as { similar?: Array<{ title: string; url: string; snippet?: string }> };
        if (ingestData.similar && ingestData.similar.length > 0) {
          setSimilar(jobId, ingestData.similar);
        }
      } else {
        log.warn("Knowledge API ingest returned {status}", { status: ingestRes.status });
      }
    } catch (err) {
      log.warn("Knowledge API ingest failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 4. Complete
    completeJob(jobId, summary, category);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("X article summarization failed for job {jobId}: {error}", { jobId, error: msg });
    failJob(jobId, msg);
  }
}
