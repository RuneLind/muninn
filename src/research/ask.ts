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
import { executeOneShot } from "../ai/one-shot.ts";
import { agentStatus, setConnectorInfo } from "../observability/agent-status.ts";
import { Tracer } from "../tracing/tracer.ts";
import { researchKnowledge, type ResearchDecomposition, type SubQuestionTrace } from "../ai/research-knowledge.ts";
import { persistResearchCitations } from "../db/research-citations.ts";
import { getLog } from "../logging.ts";
import { RESEARCH_COLLECTIONS } from "./corpus.ts";
import {
  assessCoverage,
  buildCitations,
  buildRetrievalQuestion,
  buildSynthesisUserPrompt,
  citedIndices,
  coverageMessage,
  DEFAULT_MAX_SOURCES,
  SYNTHESIS_SYSTEM_PROMPT,
  type Citation,
  type ResearchTurn,
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
  /**
   * Prior turns of this conversation, oldest→newest, for follow-ups. Carried
   * in-request (the page replays a compact, bounded slice each ask) — no server
   * state. Empty/omitted ⇒ the single-shot path, unchanged. See {@link ResearchTurn}.
   */
  history?: ResearchTurn[];
  /** Override the corpus (tests / future scoping). Defaults to RESEARCH_COLLECTIONS. */
  collections?: string[];
  maxSources?: number;
  /** Synthesis system prompt. Defaults to {@link SYNTHESIS_SYSTEM_PROMPT} (the
   *  Learning-Center framing); the wiki Ask route passes a per-wiki framing. */
  systemPrompt?: string;
  /** Injectable tracer (tests pass a recording one to avoid DB span writes). */
  tracer?: Tracer;
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
  const history = opts.history ?? [];
  const collections = opts.collections ?? RESEARCH_COLLECTIONS;
  const maxSources = opts.maxSources ?? DEFAULT_MAX_SOURCES;

  // AgentRun registry mirror (/agents dashboard) — one registration covers BOTH
  // /research and the wiki Ask tab (both call streamResearchAnswer). Phases mirror
  // the emitted searching → synthesizing arc; completed in the `finally` so it
  // settles on the done path AND every error/abort path.
  const reqId = agentStatus.startRequest(botConfig.name, "searching", undefined, {
    kind: "research",
    name: question.length > 60 ? `${question.slice(0, 57)}…` : question,
  });
  setConnectorInfo(reqId, botConfig, config.claudeModel);

  // ONE trace for the whole ask. Retrieval used to own the only trace:
  // `researchKnowledge` built its own root and FINISHED it before returning, so
  // the synthesis call — the expensive half — ran with no span under any trace at
  // all. Rooting here and handing `researchKnowledge` our context (a seam it
  // already supports) nests retrieval as a child and lets synthesis be its
  // sibling, so one trace shows the whole question end to end. The traceId the
  // UI already receives on the `sources` event is unchanged in shape: it is now
  // this root's id, which the retrieval spans share.
  const tracer = opts.tracer ?? new Tracer("research_ask", {
    botName: botConfig.name,
    platform: "research",
  });
  const traceId: string | undefined = tracer.traceId;
  let usage: { inputTokens?: number; outputTokens?: number; numTurns?: number; costUsd?: number } = {};
  let status: "ok" | "error" = "ok";

  try {
    await emit({ type: "phase", phase: "searching" });

    // On a follow-up, fold the prior question(s) into the retrieval query so the
    // decomposer can resolve references; the user-facing `question` is unchanged.
    const result = await researchKnowledge({
      question: buildRetrievalQuestion(question, history),
      collections,
      limit: PER_SEARCH_LIMIT,
      botName: botConfig.name,
      botDir: botConfig.dir,
      knowledgeApiUrl: config.knowledgeApiUrl,
      connector: botConfig.connector,
      haikuBackend: botConfig.haikuBackend,
      traceContext: tracer.context,
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
      // Persist the presented-but-ignored sources: on a declined verdict the weak
      // sources still rode out on the `sources` event, so they are retrieved-and-
      // ignored signal. All cited=false (the canned message references none).
      void persistResearchCitations({
        botName: botConfig.name,
        traceId: result.traceId,
        question,
        citations,
        citedIndices: [],
      });
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
    agentStatus.updatePhase(reqId, "synthesizing");

    const userPrompt = buildSynthesisUserPrompt(question, citations, history);
    const onProgress: StreamProgressCallback = (event) => {
      if (event.type === "text_delta") {
        void emit({ type: "delta", text: event.text });
      }
    };

    tracer.start("claude", {
      sources: citations.length,
      historyTurns: history.length,
      model: botConfig.model,
      connector: botConfig.connector ?? "claude-cli",
    });
    const claude = await executeOneShot(
      userPrompt,
      config,
      botConfig,
      { systemPrompt: opts.systemPrompt ?? SYNTHESIS_SYSTEM_PROMPT, onProgress },
    );
    usage = {
      inputTokens: claude.inputTokens,
      outputTokens: claude.outputTokens,
      numTurns: claude.numTurns,
      costUsd: claude.costUsd,
    };
    tracer.end("claude", { ...usage, model: claude.model });
    if (claude.model) agentStatus.setModel(reqId, claude.model);

    const answer = (claude.result ?? "").trim();
    log.info("Research answer synthesized botName={botName} sources={sources} tokens={tokens}", {
      botName: botConfig.name,
      sources: citations.length,
      tokens: claude.outputTokens,
    });

    const cited = citedIndices(answer);
    // Persist all presented citations, flagging which the answer actually used —
    // fire-and-forget so it never blocks closing the SSE stream.
    void persistResearchCitations({
      botName: botConfig.name,
      traceId: result.traceId,
      question,
      citations,
      citedIndices: cited,
    });

    await emit({
      type: "done",
      answer,
      noHits: false,
      lowConfidence: false,
      cited,
    });
  } catch (err) {
    status = "error";
    const message = err instanceof Error ? err.message : String(err);
    tracer.finish("error", { error: message });
    log.error("Research answer failed botName={botName} error={error}", {
      botName: botConfig.name,
      error: message,
    });
    await emit({ type: "error", message });
  } finally {
    // The declined-coverage path returns early without synthesizing, so `usage`
    // is empty there and the trace records retrieval only — which is exactly what
    // happened.
    if (status === "ok") tracer.finish("ok", usage);
    agentStatus.completeRequest(reqId, {
      ...usage,
      ...(config.tracingEnabled ? { traceId } : {}),
    });
  }
}
