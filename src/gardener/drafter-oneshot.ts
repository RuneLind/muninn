/**
 * Observability seam for the source-page drafter's model call.
 *
 * The capture summarizers route their one-shot through `runCaptureOneShot`
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
 *
 * The sequence itself (trace root + run + tool fence + thinking cap + finish/complete
 * in try/catch) is the shared `runFencedOneShot` (`src/core/fenced-one-shot.ts`),
 * which the fact-check integrate proposer also uses; this module is now just the
 * drafter's identity strings around it.
 */

import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import type { executeOneShot } from "../ai/one-shot.ts";
import {
  runFencedOneShot,
  FENCED_EXCLUDED_TOOLS,
  FENCED_THINKING_MAX_TOKENS,
} from "../core/fenced-one-shot.ts";
import { Tracer } from "../tracing/tracer.ts";
import { getLog } from "../logging.ts";

const log = getLog("gardener", "source-drafter");

/** @deprecated name kept for compatibility — see `FENCED_THINKING_MAX_TOKENS`. */
export const DRAFTER_THINKING_MAX_TOKENS = FENCED_THINKING_MAX_TOKENS;

/** @deprecated name kept for compatibility — see `FENCED_EXCLUDED_TOOLS`. */
export const DRAFTER_EXCLUDED_TOOLS = FENCED_EXCLUDED_TOOLS;

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
  const { title, url } = opts;
  return runFencedOneShot({
    traceName: "draft:source",
    platform: "capture",
    kind: "capture",
    phase: "drafting",
    runName: `Source page: ${title}`,
    sourcePage: "/wiki/gardener",
    source: "source-draft",
    prompt: opts.prompt,
    ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    config: opts.config,
    botConfig: opts.botConfig,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.thinkingMaxTokens !== undefined ? { thinkingMaxTokens: opts.thinkingMaxTokens } : {}),
    startAttrs: { title, url },
    onError: (message) =>
      log.warn("Source-page draft one-shot failed for {title}: {error}", { title, error: message }),
    ...(opts.oneShot ? { oneShot: opts.oneShot } : {}),
    ...(opts.tracer ? { tracer: opts.tracer } : {}),
  });
}
