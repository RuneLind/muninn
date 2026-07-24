/**
 * Shared traced-execution seam for one-shot (batch/background) model calls.
 *
 * The write side of `/traces` used to have NO shared seam: every `executeOneShot`
 * caller that wanted its model call to show up as a `claude` span hand-copied the
 * same start/end block — stamp connector + model at start, tokens/cost/duration +
 * `attachToolSpans` at end, error-end + rethrow on throw — and the copies drifted
 * (some stamped the config model at start and never a `requestedModel`, some
 * forgot `attachToolSpans`, factcheck's claim spans could flip a `/traces` row to
 * `model='mixed'` when an errored claim retained the model ALIAS it stamped at
 * start). `tracedOneShot` is the single place that block now lives.
 *
 * Behaviour (a distillation of what `runCaptureOneShot` did inline, minus the
 * capture-specific `attachRun` + thinking-cap):
 *   - START: stamp `connector` + `requestedModel` (the CONFIGURED model — never
 *     the resolved one, so an errored span carries no `model` and is excluded from
 *     the read-side model collapse) plus any caller `startAttrs` on the span;
 *   - END (ok): stamp the connector-reported `model`, `inputTokens`,
 *     `outputTokens`, `numTurns`, `costUsd`, `toolCount`, `durationMs`, then
 *     `attachToolSpans` under `opts.parentLabel ?? label`;
 *   - END (throw): stamp `{ error }` on the span and rethrow — the caller's own
 *     try/catch owns the trace-root `finish`, so this seam never touches the root.
 *
 * `label` defaults to `"claude"` (the single model span every fast path on the
 * read side keys off); callers that fan out concurrently pass an indexed label
 * (fact-check's `claude:claim-<i>`) so the parallel calls don't clobber one
 * label-keyed span. The seam deliberately does NOT own the trace root, the
 * `/agents` run, or `attachRun` — those stay per-caller.
 *
 * Lives in `core/` (not `ai/`) because it composes `ai/one-shot` with
 * `core/tool-spans` + `tracing/` — `core/` already sits above `ai/` (see
 * `core/tool-spans.ts`), so this keeps the dependency edges pointing the same way.
 */

import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { executeOneShot } from "../ai/one-shot.ts";
import type { Tracer } from "../tracing/tracer.ts";
import { attachToolSpans } from "./tool-spans.ts";

export interface TracedOneShotOptions {
  /** System prompt passed through to the connector. */
  systemPrompt?: string;
  /** Response timeout override in ms. */
  timeoutMs?: number;
  /** Thinking-budget override (`0` disables). Omit to inherit the bot's budget. */
  thinkingMaxTokens?: number;
  /** Streaming progress callback (text deltas, tool events). */
  onProgress?: StreamProgressCallback;
  /** Extra read dirs (claude-cli `--add-dir` / claude-sdk `additionalDirectories`). */
  extraDirs?: string[];
  /**
   * Extra attributes stamped on the span at START, alongside the seam's own
   * `connector` + `requestedModel` — vertical-specific context (capture's
   * source/title/url, the digest's wiki/entries, a claim's claimIndex, …).
   */
  startAttrs?: Record<string, unknown>;
  /**
   * Parent label for the tool child spans. Defaults to `label` (the model span
   * itself) — fact-check passes its indexed `claude:claim-<i>` label so each
   * concurrent verify's WebFetch spans hang under the right claim.
   */
  parentLabel?: string;
  /**
   * Capture tool OUTPUTS onto the tool spans. Defaults to
   * `config.tracingCaptureToolOutputs` — pass explicitly only to override.
   */
  captureToolOutputs?: boolean;
  /** Test seam — production callers omit it (defaults to {@link executeOneShot}). */
  oneShot?: typeof executeOneShot;
}

/**
 * Run one prompt→text turn through the bot's connector, wrapped in a traced
 * `claude` span (start/end + tool child spans). See the file header for the full
 * contract. Ends the span with `{ error }` and rethrows on failure; the caller
 * owns the trace-root `finish`.
 */
export async function tracedOneShot(
  tracer: Tracer,
  label: string,
  prompt: string,
  config: Config,
  botConfig: BotConfig,
  opts: TracedOneShotOptions = {},
): Promise<ClaudeExecResult> {
  const oneShot = opts.oneShot ?? executeOneShot;
  const spanLabel = label || "claude";

  tracer.start(spanLabel, {
    connector: botConfig.connector ?? "claude-cli",
    requestedModel: botConfig.model,
    ...(opts.startAttrs ?? {}),
  });

  try {
    const result = await oneShot(prompt, config, botConfig, {
      ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.thinkingMaxTokens !== undefined ? { thinkingMaxTokens: opts.thinkingMaxTokens } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.extraDirs ? { extraDirs: opts.extraDirs } : {}),
    });

    tracer.end(spanLabel, {
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      numTurns: result.numTurns,
      costUsd: result.costUsd,
      toolCount: result.toolCalls?.length ?? 0,
      durationMs: result.durationMs,
    });
    // Tool child spans hang off the model span (or the caller's parentLabel).
    await attachToolSpans(
      tracer,
      result.toolCalls,
      opts.captureToolOutputs ?? !!config.tracingCaptureToolOutputs,
      opts.parentLabel ?? spanLabel,
    );

    return result;
  } catch (err) {
    tracer.end(spanLabel, { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
