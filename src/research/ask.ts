/**
 * Research Q&A orchestration — retrieve across the corpus, then synthesize one
 * cited answer.
 *
 * `streamResearchAnswer` runs `researchKnowledge` over the corpus, builds the
 * numbered citation list, then makes a single Claude call to synthesize a cited
 * prose answer, emitting events through an `emit` callback. The SSE route adapts
 * `emit` to `stream.writeSSE`; tests collect the events directly — so the wire
 * format stays out of the orchestration logic.
 */

import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { executeClaudePrompt } from "../ai/executor.ts";
import { researchKnowledge, type ResearchDecomposition, type SubQuestionTrace } from "../ai/research-knowledge.ts";
import { getLog } from "../logging.ts";
import { RESEARCH_COLLECTIONS } from "./corpus.ts";
import {
  assessCoverage,
  buildCitations,
  buildSynthesisUserPrompt,
  citedIndices,
  coverageMessage,
  DEFAULT_MAX_SOURCES,
  SYNTHESIS_SYSTEM_PROMPT,
  type Citation,
} from "./answer.ts";

const log = getLog("research", "ask");

/** Per-sub-question retrieval cap — keep the merged context bounded for synthesis. */
const PER_SEARCH_LIMIT = 6;

export type AnswerEvent =
  | { type: "phase"; phase: "searching" | "synthesizing" }
  | {
      type: "sources";
      citations: Citation[];
      decomposition: ResearchDecomposition;
      subSearches: SubQuestionTrace[];
      traceId: string;
    }
  | { type: "delta"; text: string }
  | { type: "done"; answer: string; noHits: boolean; lowConfidence: boolean; cited: number[] }
  | { type: "error"; message: string };

export interface ResearchAnswerOptions {
  question: string;
  config: Config;
  botConfig: BotConfig;
  /** Override the corpus (tests / future scoping). Defaults to RESEARCH_COLLECTIONS. */
  collections?: string[];
  maxSources?: number;
}

/**
 * Retrieve → synthesize, emitting events as it goes. Never throws: any failure
 * is reported as an `{ type: "error" }` event so the caller's stream closes
 * cleanly. On zero hits it emits the canned {@link NO_HITS_MESSAGE} and skips
 * the (expensive) Claude synthesis call entirely.
 */
export async function streamResearchAnswer(
  opts: ResearchAnswerOptions,
  emit: (event: AnswerEvent) => void | Promise<void>,
): Promise<void> {
  const { question, config, botConfig } = opts;
  const collections = opts.collections ?? RESEARCH_COLLECTIONS;
  const maxSources = opts.maxSources ?? DEFAULT_MAX_SOURCES;

  try {
    await emit({ type: "phase", phase: "searching" });

    const result = await researchKnowledge({
      question,
      collections,
      limit: PER_SEARCH_LIMIT,
      botName: botConfig.name,
      botDir: botConfig.dir,
      knowledgeApiUrl: config.knowledgeApiUrl,
      connector: botConfig.connector,
      haikuBackend: botConfig.haikuBackend,
    });

    const citations = buildCitations(result.results, maxSources);
    await emit({
      type: "sources",
      citations,
      decomposition: result.decomposition,
      subSearches: result.subSearches,
      traceId: result.traceId,
    });

    // Honest relevance floor: gate synthesis on Huginn's raw-score `lowConfidence`
    // signal, not the rank-based `relevance` value (see assessCoverage). On a
    // no-coverage / low-confidence verdict we decline rather than spend a Claude
    // call grounding an answer in weak nearest-neighbours. Weak sources still rode
    // out on the `sources` event above, so the reader can open and judge them.
    const coverage = assessCoverage({
      hitCount: result.results.length,
      subSearches: result.subSearches,
    });
    if (coverage !== "answer") {
      const message = coverageMessage(coverage);
      log.info("Research declined coverage={coverage} botName={botName} hits={hits}", {
        coverage,
        botName: botConfig.name,
        hits: result.results.length,
      });
      await emit({ type: "delta", text: message });
      await emit({
        type: "done",
        answer: message,
        noHits: true,
        lowConfidence: coverage === "low_confidence",
        cited: [],
      });
      return;
    }

    await emit({ type: "phase", phase: "synthesizing" });

    const userPrompt = buildSynthesisUserPrompt(question, citations);
    const onProgress: StreamProgressCallback = (event) => {
      if (event.type === "text_delta") {
        void emit({ type: "delta", text: event.text });
      }
    };

    const claude = await executeClaudePrompt(
      userPrompt,
      config,
      botConfig,
      SYNTHESIS_SYSTEM_PROMPT,
      onProgress,
    );

    const answer = (claude.result ?? "").trim();
    log.info("Research answer synthesized botName={botName} sources={sources} tokens={tokens}", {
      botName: botConfig.name,
      sources: citations.length,
      tokens: claude.outputTokens,
    });

    await emit({
      type: "done",
      answer,
      noHits: false,
      lowConfidence: false,
      cited: citedIndices(answer),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Research answer failed botName={botName} error={error}", {
      botName: botConfig.name,
      error: message,
    });
    await emit({ type: "error", message });
  }
}
