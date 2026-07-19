/**
 * Observability seam for the source-page drafter's model call.
 *
 * The four capture summarizers route their one-shot through `runCaptureOneShot`
 * (`src/summaries/summarizer-shared.ts`), but that helper is coupled to the capture
 * job-store — it takes a `jobId` and an `attachRun(jobId, meta)` callback that
 * late-binds telemetry onto a job created at route level. The source-page drafter
 * has no job-store row, so it can't reuse that seam as-is.
 *
 * `runDrafterOneShot` mirrors `runCaptureOneShot`'s observability shape WITHOUT the
 * job coupling: it mints its own `draft:source` trace root with a `claude` child
 * span (model / tokens / cost + tool child spans), and registers a lightweight
 * `/agents` run of kind `capture` (the source draft IS a capture-derived background
 * job — reusing the kind keeps it in Recent + off the single-pane waterfall with no
 * AgentKind cascade). Bare `executeOneShot` is never called from the drafter — a
 * bare call would leave the draft invisible on both `/traces` and `/agents`.
 */

import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import { executeOneShot, connectorCapabilities } from "../ai/one-shot.ts";
import { Tracer } from "../tracing/tracer.ts";
import { attachToolSpans } from "../core/tool-spans.ts";
import { agentStatus, getConnectorLabel } from "../observability/agent-status.ts";
import { getLog } from "../logging.ts";

const log = getLog("gardener", "source-drafter");

/**
 * Thinking budget for a source-page draft. Same rationale as the capture summarizers
 * (`CAPTURE_THINKING_MAX_TOKENS`): drafting is mechanical synthesis, so a bot's
 * chat-tuned budget (jarvis: 40k) is spent as silent first-token dead-air. 8k is the
 * knee — matches the gardener's own draft cap.
 */
export const DRAFTER_THINKING_MAX_TOKENS = 8000;

export interface DrafterOneShotOptions {
  /** Subject for the trace + `/agents` card — the encyclopedic title if known, else the url/docId. */
  title: string;
  url: string;
  prompt: string;
  systemPrompt?: string;
  config: Config;
  botConfig: BotConfig;
  timeoutMs?: number;
  /** Thinking budget; defaults to {@link DRAFTER_THINKING_MAX_TOKENS}. `null` inherits the bot's. */
  thinkingMaxTokens?: number | null;
  /** Test seams — production callers pass neither. */
  oneShot?: typeof executeOneShot;
  tracer?: Tracer;
}

/**
 * Run the source-page drafter's model call with a trace + `/agents` run attached.
 * Fail-soft by construction: the trace is stamped `error`, the run completed, and
 * the error re-thrown so the caller's own failure handling is unchanged.
 */
export async function runDrafterOneShot(opts: DrafterOneShotOptions): Promise<ClaudeExecResult> {
  const { title, url, config, botConfig } = opts;
  const oneShot = opts.oneShot ?? executeOneShot;

  const tracer =
    opts.tracer ??
    new Tracer("draft:source", { botName: botConfig.name, platform: "capture" });

  // Setup runs INSIDE the try so a throw in `startRequest` / `connectorCapabilities` /
  // `tracer.start` still finishes the root span and completes the /agents run, instead
  // of leaking an unfinished trace + a run stuck in "drafting". Staged with two flags so
  // the catch only touches what was actually created: `tracer.end("claude")` throws on an
  // unstarted mark (Timing.end), so it is gated on `claudeStarted`; `completeRequest` is
  // gated on `reqId`.
  let reqId: string | undefined;
  let claudeStarted = false;
  try {
    reqId = agentStatus.startRequest(botConfig.name, "drafting", undefined, {
      kind: "capture",
      name: `Source page: ${title}`,
    });
    agentStatus.setSourcePage(reqId, "/wiki/gardener");
    agentStatus.setConnectorLabel(reqId, getConnectorLabel(botConfig.connector ?? "claude-cli"));
    if (botConfig.model) agentStatus.setModel(reqId, botConfig.model);

    // Only cap thinking where the field IS a thinking budget (claude-cli / claude-sdk);
    // on openai-compat it is max_tokens, so overriding it would clamp the draft length.
    const thinking = !connectorCapabilities(botConfig).supportsThinkingBudget
      ? null
      : opts.thinkingMaxTokens === undefined
        ? DRAFTER_THINKING_MAX_TOKENS
        : opts.thinkingMaxTokens;

    tracer.start("claude", {
      source: "source-draft",
      title,
      url,
      connector: botConfig.connector ?? "claude-cli",
      model: botConfig.model,
      ...(thinking !== null ? { thinkingMaxTokens: thinking } : {}),
    });
    claudeStarted = true;

    const result = await oneShot(opts.prompt, config, botConfig, {
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(thinking !== null ? { thinkingMaxTokens: thinking } : {}),
    });

    const usage = {
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      numTurns: result.numTurns,
      toolCount: result.toolCalls?.length ?? 0,
      costUsd: result.costUsd,
    };

    tracer.end("claude", { ...usage, durationMs: result.durationMs });
    await attachToolSpans(tracer, result.toolCalls, !!config.tracingCaptureToolOutputs);
    tracer.finish("ok", { source: "source-draft", ...usage });
    agentStatus.completeRequest(reqId, {
      ...(config.tracingEnabled ? { traceId: tracer.traceId } : {}),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      numTurns: result.numTurns,
      toolCount: usage.toolCount,
      costUsd: result.costUsd,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (claudeStarted) tracer.end("claude", { error: message });
    tracer.finish("error", { source: "source-draft", error: message });
    if (reqId) agentStatus.completeRequest(reqId, {});
    log.warn("Source-page draft one-shot failed for {title}: {error}", { title, error: message });
    throw err;
  }
}
