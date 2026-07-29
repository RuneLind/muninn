/**
 * Observability + tool-fencing seam for the fact-check integrate one-shot.
 *
 * Mirrors `runDrafterOneShot` (`src/gardener/drafter-oneshot.ts`): it mints its
 * own `factcheck-integrate` trace ROOT and a lightweight `/agents` run of the
 * already-registered `factcheck` kind, runs the model call through the shared
 * `tracedOneShot` (which owns the `claude` CHILD span, never the root), and
 * finishes both in try/finally so a throw can't leak an unfinished trace or a run
 * stuck mid-phase. Bare `executeOneShot` is never called from this path.
 *
 * ── The tool fence is load-bearing ───────────────────────────────────────────
 * The proposed edits are delivered as the one-shot's RETURN TEXT, previewed by a
 * human and only then applied under CAS. A model that can reach `Write`/`Edit`
 * can satisfy the prompt by editing the page directly — bypassing the preview,
 * the CAS, the per-wiki queue, the log entry and the commit, all at once. So the
 * bot config is cloned with `DRAFTER_EXCLUDED_TOOLS` unioned onto its own
 * `excludedTools` (muninn #397's lesson: under `bypassPermissions` an empty
 * `allowedTools` means the FULL surface — only `excludedTools` binds). WebFetch /
 * WebSearch stay available; the prompt steers against using them, since every
 * source the edit list needs is already quoted in the verdict blocks.
 */

import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import { executeOneShot, connectorCapabilities } from "../ai/one-shot.ts";
import { tracedOneShot } from "../core/traced-one-shot.ts";
import { Tracer } from "../tracing/tracer.ts";
import { agentStatus, getConnectorLabel } from "../observability/agent-status.ts";
import { DRAFTER_EXCLUDED_TOOLS, DRAFTER_THINKING_MAX_TOKENS } from "../gardener/drafter-oneshot.ts";
import { getLog } from "../logging.ts";

const log = getLog("wiki", "integrate");

/** Wall-clock budget for the integrate call — one structured-output turn over a
 *  capped body, with no tool excursions expected. */
export const INTEGRATE_TIMEOUT_MS = 90_000;

export interface IntegrateOneShotOptions {
  /** Page title — the trace subject + `/agents` card name. */
  pageTitle: string;
  wikiName: string;
  prompt: string;
  systemPrompt: string;
  config: Config;
  botConfig: BotConfig;
  /** Test seams — production callers pass neither. */
  oneShot?: typeof executeOneShot;
  tracer?: Tracer;
}

/**
 * Run the integrate model call with a trace root + `/agents` run attached and the
 * file-writing tools fenced off. Fail-soft by construction: the trace is stamped
 * `error`, the run completed, and the error re-thrown so the route's own handling
 * is unchanged.
 */
export async function runIntegrateOneShot(opts: IntegrateOneShotOptions): Promise<ClaudeExecResult> {
  const { pageTitle, wikiName, config, botConfig } = opts;

  const tracer =
    opts.tracer ??
    new Tracer("factcheck-integrate", { botName: botConfig.name, platform: "factcheck" });

  // Setup runs INSIDE the try (the drafter's discipline) so a throw in
  // `startRequest` / `connectorCapabilities` still finishes the root span and
  // completes the run instead of leaking both.
  let reqId: string | undefined;
  try {
    const name = `Fact-check integrate: ${pageTitle}`;
    reqId = agentStatus.startRequest(botConfig.name, "calling_claude", undefined, {
      kind: "factcheck",
      name: name.length > 60 ? `${name.slice(0, 57)}…` : name,
    });
    agentStatus.setSourcePage(reqId, "/wiki");
    agentStatus.setConnectorLabel(reqId, getConnectorLabel(botConfig.connector ?? "claude-cli"));
    if (botConfig.model) agentStatus.setModel(reqId, botConfig.model);

    // Cap thinking only where the field IS a thinking budget (claude-cli /
    // claude-sdk); on openai-compat it is max_tokens and clamping it would
    // truncate the JSON edit list.
    const thinking = connectorCapabilities(botConfig).supportsThinkingBudget
      ? DRAFTER_THINKING_MAX_TOKENS
      : null;

    // A fresh object, never a mutation — `botConfig` is the shared discovered
    // config, and every other field is carried over so the trace and the run
    // still report the bot's own identity.
    const fencedBotConfig: BotConfig = {
      ...botConfig,
      excludedTools: [...new Set([...(botConfig.excludedTools ?? []), ...DRAFTER_EXCLUDED_TOOLS])],
    };

    const result = await tracedOneShot(tracer, "claude", opts.prompt, config, fencedBotConfig, {
      systemPrompt: opts.systemPrompt,
      timeoutMs: INTEGRATE_TIMEOUT_MS,
      ...(thinking !== null ? { thinkingMaxTokens: thinking } : {}),
      ...(opts.oneShot ? { oneShot: opts.oneShot } : {}),
      startAttrs: {
        source: "factcheck-integrate",
        wiki: wikiName,
        title: pageTitle,
        ...(thinking !== null ? { thinkingMaxTokens: thinking } : {}),
      },
    });

    tracer.finish("ok", {
      source: "factcheck-integrate",
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      numTurns: result.numTurns,
      toolCount: result.toolCalls?.length ?? 0,
      costUsd: result.costUsd,
    });
    agentStatus.completeRequest(reqId, {
      ...(config.tracingEnabled ? { traceId: tracer.traceId } : {}),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      numTurns: result.numTurns,
      toolCount: result.toolCalls?.length ?? 0,
      costUsd: result.costUsd,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tracer.finish("error", { source: "factcheck-integrate", error: message });
    if (reqId) agentStatus.completeRequest(reqId, {});
    log.warn("Fact-check integrate one-shot failed for {title}: {error}", {
      title: pageTitle,
      error: message,
    });
    throw err;
  }
}
