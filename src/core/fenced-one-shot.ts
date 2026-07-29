/**
 * Shared runner for the FENCED background one-shots — the model calls whose
 * product is the RETURN TEXT and which therefore must not be able to reach a
 * file-writing tool.
 *
 * Two verticals had ~75 verbatim-identical lines of this: the source-page drafter
 * (`src/gardener/drafter-oneshot.ts`) and the fact-check integrate proposer
 * (`src/wiki/integrate-oneshot.ts`). Both mint their own trace ROOT, register a
 * lightweight `/agents` run, clone the bot config with {@link FENCED_EXCLUDED_TOOLS}
 * unioned onto its `excludedTools`, cap thinking, delegate the model call to
 * `tracedOneShot` (which owns the `claude` CHILD span, never the root), and finish
 * both root and run in try/catch so a throw can't leak an unfinished trace or a run
 * stuck mid-phase. That sequence lives here now; the callers supply only their own
 * identity strings.
 *
 * Bare `executeOneShot` is never called from either path — a bare call leaves the
 * work invisible on both `/traces` and `/agents`.
 */

import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import { executeOneShot, connectorCapabilities } from "../ai/one-shot.ts";
import { tracedOneShot } from "./traced-one-shot.ts";
import { Tracer } from "../tracing/tracer.ts";
import {
  agentStatus,
  getConnectorLabel,
  type AgentKind,
  type AgentPhase,
} from "../observability/agent-status.ts";

/**
 * Thinking budget for a fenced background one-shot. Same rationale as the capture
 * summarizers (`CAPTURE_THINKING_MAX_TOKENS`): this is mechanical synthesis, so a
 * bot's chat-tuned budget (jarvis: 40k) is spent as silent first-token dead-air.
 * 8k is the knee — matches the gardener's own draft cap.
 */
export const FENCED_THINKING_MAX_TOKENS = 8000;

/**
 * Tools a fenced one-shot must not have. The product is delivered as the call's
 * RETURN TEXT, so any tool that can produce the artifact some other way is a way
 * to LOSE it: the model writes the file to disk, returns "File created
 * successfully at: …", the caller's parser finds nothing usable, and the work is
 * terminally skipped. Measured over one 7-day trace window on the drafter: 28 of
 * 101 `draft:source` runs reached for `Write`/`Edit` (usually as a harmless
 * temp-file scratchpad), and 3 lost the draft outright — one of them into the
 * muninn repo itself. On the integrate path the same reach would bypass the human
 * preview, the CAS and the per-wiki write queue all at once.
 *
 * Fencing is expressed as an EXCLUDE list on purpose: under the claude-sdk's
 * `bypassPermissions`, an empty `allowedTools` means the FULL surface (see
 * `claude-sdk.ts`), so an allow-list of `[]` fences nothing. `excludedTools` is the
 * only knob that binds, and it maps on every connector that has these tools —
 * claude-sdk → `disallowedTools`, claude-cli → `--disallowedTools`, copilot-sdk →
 * `excludedTools`. **openai-compat ignores the field entirely** (it has no
 * filesystem tools either, so the exposure is nil, but the FENCE does not bind
 * there — a caller that needs a hard guarantee needs its own text-only retry, as
 * `draftSourcePage` has).
 *
 * The agent-loop tools are on the list for the same reason `DISALLOWED_BASE` in
 * `src/benchmarks/audit.ts` carries them: a run that is denied `Write` can still
 * delegate the write to a sub-agent with an unrestricted toolset and come back with
 * a confirmation — the exact shape being fenced against.
 */
export const FENCED_EXCLUDED_TOOLS = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "Agent",
  "Task",
  "Skill",
];

export interface FencedOneShotOptions {
  /** Trace ROOT span name, e.g. `draft:source` / `factcheck-integrate`. */
  traceName: string;
  /** Tracer `platform` tag, e.g. `capture` / `factcheck`. */
  platform: string;
  /** `/agents` run kind + opening phase. */
  kind: AgentKind;
  phase: AgentPhase;
  /** `/agents` card name — already truncated by the caller if it wants that. */
  runName: string;
  /** Dashboard deep-link for the run card, e.g. `/wiki/gardener`. */
  sourcePage: string;
  /** The `source` attribute stamped on the span start + the trace finish. */
  source: string;
  prompt: string;
  systemPrompt?: string;
  config: Config;
  botConfig: BotConfig;
  timeoutMs?: number;
  /** Thinking budget; defaults to {@link FENCED_THINKING_MAX_TOKENS}. `null`
   *  inherits the bot's own. Ignored on connectors where the field is not a
   *  thinking budget (openai-compat, where it is `max_tokens`). */
  thinkingMaxTokens?: number | null;
  /** Vertical-specific attributes stamped on the span at START. */
  startAttrs?: Record<string, unknown>;
  /** Called with the error message on failure, so each vertical keeps its own
   *  log line. The error is rethrown regardless. */
  onError?: (message: string) => void;
  /** Test seams — production callers pass neither. */
  oneShot?: typeof executeOneShot;
  tracer?: Tracer;
}

/**
 * Run one fenced one-shot with a trace root + `/agents` run attached and the
 * file-writing tools excluded. Fail-soft by construction: on a throw the trace is
 * stamped `error`, the run completed, and the error re-thrown so the caller's own
 * handling is unchanged.
 */
export async function runFencedOneShot(opts: FencedOneShotOptions): Promise<ClaudeExecResult> {
  const { config, botConfig } = opts;

  const tracer =
    opts.tracer ?? new Tracer(opts.traceName, { botName: botConfig.name, platform: opts.platform });

  // Setup runs INSIDE the try so a throw in `startRequest` / `connectorCapabilities`
  // still finishes the root span and completes the run, instead of leaking both. The
  // shared `tracedOneShot` owns the `claude` span's whole lifecycle (start + ok-end +
  // error-end), so the catch only needs the root finish + `completeRequest`.
  let reqId: string | undefined;
  try {
    reqId = agentStatus.startRequest(botConfig.name, opts.phase, undefined, {
      kind: opts.kind,
      name: opts.runName,
    });
    agentStatus.setSourcePage(reqId, opts.sourcePage);
    agentStatus.setConnectorLabel(reqId, getConnectorLabel(botConfig.connector ?? "claude-cli"));
    if (botConfig.model) agentStatus.setModel(reqId, botConfig.model);

    // Only cap thinking where the field IS a thinking budget (claude-cli /
    // claude-sdk); on openai-compat it is max_tokens and clamping it would truncate
    // the returned text (a JSON edit list, a whole drafted page).
    const thinking = !connectorCapabilities(botConfig).supportsThinkingBudget
      ? null
      : opts.thinkingMaxTokens === undefined
        ? FENCED_THINKING_MAX_TOKENS
        : opts.thinkingMaxTokens;

    // A fresh object, never a mutation — `botConfig` is the shared discovered
    // config, and every other field (name / connector / model) is carried over so
    // the trace and the run still report the bot's own identity.
    const fencedBotConfig: BotConfig = {
      ...botConfig,
      excludedTools: [...new Set([...(botConfig.excludedTools ?? []), ...FENCED_EXCLUDED_TOOLS])],
    };

    const result = await tracedOneShot(tracer, "claude", opts.prompt, config, fencedBotConfig, {
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(thinking !== null ? { thinkingMaxTokens: thinking } : {}),
      ...(opts.oneShot ? { oneShot: opts.oneShot } : {}),
      startAttrs: {
        source: opts.source,
        ...(opts.startAttrs ?? {}),
        ...(thinking !== null ? { thinkingMaxTokens: thinking } : {}),
      },
    });

    const usage = {
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      numTurns: result.numTurns,
      toolCount: result.toolCalls?.length ?? 0,
      costUsd: result.costUsd,
    };

    tracer.finish("ok", { source: opts.source, ...usage });
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
    tracer.finish("error", { source: opts.source, error: message });
    if (reqId) agentStatus.completeRequest(reqId, {});
    opts.onError?.(message);
    throw err;
  }
}
