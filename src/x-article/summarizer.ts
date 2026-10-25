import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { getLog } from "../logging.ts";
import { parseSummaryResponse } from "../utils/summary-parser.ts";
import { ingestSummary, runCaptureOneShot } from "../summaries/summarizer-shared.ts";
import { appendLinksSection, prepareLinksAnswer } from "../summaries/links-section.ts";
import { finishTextLinks, linkTraceAttrs, prepareTextLinks, type TextLinksDeps } from "../summaries/text-links-run.ts";
import { textLinksPromptSection } from "../summaries/text-links.ts";
import { buildXArticleSystemPrompt } from "./prompt.ts";
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

export async function summarizeArticle(
  jobId: string,
  articleId: string,
  title: string,
  url: string,
  author: string,
  articleText: string,
  config: Config,
  botConfig: BotConfig,
  /** Test seam for the links' network half (`t.co` lookups, repo lines). */
  linkDeps: TextLinksDeps = {},
): Promise<void> {
  try {
    // 1. Summarize with Claude
    updateStatus(jobId, "summarizing");

    // The composition is `./prompt.ts` — not `./video-prompt.ts`, which is the
    // hand-rolled frame-reading envelope of the X-VIDEO path.
    // The text's links (plan muninn-summary-links, PR 2): every `t.co` URL
    // resolved under one shared budget and spelled as its target, then the
    // candidates numbered for the model's `LINKS:` pick. With none, both
    // prompts are byte-identical to before links existed.
    // A link to the post's own address is not listed.
    const textLinks = await prepareTextLinks(articleText, linkDeps, url || undefined);
    const linksStep = textLinks.links.length > 0;
    const systemPrompt = buildXArticleSystemPrompt({ title, author, url, ...(linksStep ? { linksStep } : {}) });

    const onProgress: StreamProgressCallback = (event) => {
      if (event.type === "text_delta") {
        appendText(jobId, event.text);
      }
    };

    const result = await runCaptureOneShot({
      toolSurface: "none",
      source: "x-article",
      jobId,
      title,
      url,
      prompt: textLinks.text + textLinksPromptSection(textLinks.links),
      systemPrompt,
      config,
      botConfig,
      attachRun,
      onProgress,
      extraTraceAttrs: linkTraceAttrs(textLinks),
    });

    // 2. Parse response. The `LINKS:` line comes out before the envelope
    //    parse, wherever the model put it; the section is the summary's last
    //    block, built only from the ids the model picked (no by-rule placement
    //    for a text — plan muninn-summary-links, PR 2).
    const prepared = prepareLinksAnswer(result.result);
    const { category, summary: parsed } = parseSummaryResponse(prepared.text);
    setCategory(jobId, category);
    const finishedLinks = await finishTextLinks(textLinks.links, prepared.pick, linkDeps);
    const summary = appendLinksSection(parsed, finishedLinks.section);
    if (finishedLinks.unknownIds.length > 0) {
      log.warn("The LINKS line for job {jobId} named id(s) {ids} the list does not have — dropped", {
        jobId,
        ids: finishedLinks.unknownIds.join(", "),
      });
    }

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
