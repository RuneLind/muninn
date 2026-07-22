/**
 * Dedicated SSE streaming lifecycle for the wiki reader's **Fact check** feature
 * (`GET /api/wiki/factcheck`). A sibling of `research-sse.ts`, but deliberately
 * NOT built on `streamResearchAnswer`: fact-check does no huginn retrieval and no
 * coverage gate — it runs one tool-enabled `executeOneShot` that verifies claims
 * against the LIVE web (WebFetch) and streams the verdicts back as they arrive.
 *
 * It reuses only the outer SSE scaffold shape (heartbeat, `app_error` masking,
 * terminal `end`, `finally` teardown) so the wire contract matches Ask/Explain —
 * the client's shared `runAskStream` consumes `delta`/`done`/`answer_html`/
 * `app_error`/`end` unchanged. `streamResearchSSE`/`streamResearchAnswer` are left
 * byte-untouched (the acceptance test requires Ask/Explain unchanged).
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { StreamProgressEvent } from "../../ai/stream-parser.ts";
import { executeOneShot } from "../../ai/one-shot.ts";
import { getToolProgress } from "../../ai/tool-status.ts";
import { agentStatus, setConnectorInfo } from "../../observability/agent-status.ts";
import { Tracer } from "../../tracing/tracer.ts";
import { attachToolSpans } from "../../core/tool-spans.ts";
import { countFactcheckClaims } from "../../wiki/factcheck-context.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "factcheck-sse");

/**
 * Raised timeout for a fact-check one-shot. The default `CLAUDE_TIMEOUT_MS` (120s)
 * would intermittently kill a whole-article check: task 0 measured 6 web-verified
 * claims at ~88s wall-clock on jarvis/claude-sdk (~15s/claim), and a slow source
 * fetch can push a single claim well past 60s. 280s leaves comfortable headroom
 * for the `FACTCHECK_MAX_CLAIMS` (8) cap while staying under the plan's 240–300s
 * budget.
 */
export const FACTCHECK_TIMEOUT_MS = 280_000;

export interface FactcheckSseOptions {
  config: Config;
  /** The synthesizing bot. `null` ⇒ the helper emits the "no bots" app_error. */
  botConfig: BotConfig | null;
  /** Route-computed preflight error (unknown wiki, no page, non-web connector, …).
   *  When set, emitted as an `app_error`; no model call. */
  preflightError?: string | null;
  /** Display label + `/agents` run name (unused on the preflight-error path). */
  question: string;
  systemPrompt: string;
  userPrompt: string;
  /** sha256 of the checked page's on-disk content — round-tripped on `done` so
   *  PR B's ➕ POST can detect a drifted page. */
  baseHash: string;
  mode: "sel" | "article";
  /** Final-render hook: markdown answer → reader HTML, emitted as a trailing
   *  `answer_html` (same shape as Ask/Explain). A throw is swallowed — the
   *  streamed plain text stands. */
  renderAnswerHtml?: (answer: string) => string;
}

/**
 * Run the whole SSE lifecycle for one fact-check request. Never throws (a model
 * failure is reported as an `app_error` event); always emits a terminal `end`
 * sentinel so the client can close deterministically.
 */
export function streamFactcheckSSE(c: Context, opts: FactcheckSseOptions): Response {
  return streamSSE(c, async (stream) => {
    // A web-verification pass can leave a long gap with no client-visible events
    // (the model is fetching pages); a heartbeat keeps the connection alive
    // through any proxy with a shorter idle window. Clients have no 'heartbeat'
    // listener, so these are silently ignored.
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) return;
      stream.writeSSE({ event: "heartbeat", data: "{}" }).catch(() => { alive = false; });
    }, 30_000);
    stream.onAbort(() => { alive = false; clearInterval(heartbeat); });

    const appError = (message: string) =>
      stream.writeSSE({ event: "app_error", data: JSON.stringify({ type: "error", message }) });

    try {
      if (opts.preflightError) {
        await appError(opts.preflightError);
      } else if (!opts.botConfig) {
        await appError("No bots configured to run a fact check.");
      } else {
        await runFactcheck(stream, opts, opts.botConfig);
      }
      // Terminal sentinel so the client closes the EventSource deterministically.
      await stream.writeSSE({ event: "end", data: "{}" });
    } finally {
      alive = false;
      clearInterval(heartbeat);
    }
  });
}

/** The retrieval-free model half: a tool-enabled `executeOneShot` streaming its
 *  verdicts via `text_delta`→`delta`, wrapped in a `factcheck` trace + an
 *  `/agents` run so the check is visible on `/traces` and `/agents`. */
async function runFactcheck(
  stream: { writeSSE: (m: { event: string; data: string }) => Promise<void> },
  opts: FactcheckSseOptions,
  botConfig: BotConfig,
): Promise<void> {
  const { config } = opts;

  // /agents registry mirror. Kind `factcheck`; settled in the `finally` so it
  // closes on the done path AND every error path (mirrors ask.ts).
  const reqId = agentStatus.startRequest(botConfig.name, "calling_claude", undefined, {
    kind: "factcheck",
    name: opts.question.length > 60 ? `${opts.question.slice(0, 57)}…` : opts.question,
  });
  setConnectorInfo(reqId, botConfig, config.claudeModel);

  // One trace for the whole check (root + a `claude` child span carrying
  // model/tokens/cost, tool child spans underneath) — a bare executeOneShot is
  // invisible on /traces and /agents. Mirrors the runCaptureOneShot precedent.
  const tracer = new Tracer("factcheck", { botName: botConfig.name, platform: "factcheck" });
  const traceId: string | undefined = tracer.traceId;
  let usage: { inputTokens?: number; outputTokens?: number; numTurns?: number; costUsd?: number } = {};
  let status: "ok" | "error" = "ok";

  try {
    // Forward text deltas AND tool progress to the client (the live "Searching
    // the web / Reading <host>" status line + the "Consulting" sources row). Tool
    // spans still land on the trace below. The one-shot keeps producing events
    // after a client abort (no AbortSignal plumbing into executeOneShot), so stop
    // writing on the first failed write instead of leaking one unhandled
    // rejection per event.
    let clientGone = false;
    const onProgress = (event: StreamProgressEvent) => {
      if (clientGone) return;
      if (event.type === "text_delta") {
        stream.writeSSE({ event: "delta", data: JSON.stringify({ type: "delta", text: event.text }) })
          .catch(() => { clientGone = true; });
      } else if (event.type === "tool_start") {
        // Compute label/detail server-side so the client stays dumb. `detail` is
        // the hostname for WebFetch / query for WebSearch, else undefined.
        const prog = getToolProgress(event.name, event.input);
        stream.writeSSE({
          event: "tool",
          data: JSON.stringify({
            type: "tool",
            state: "start",
            name: event.displayName,
            label: prog?.label ?? event.displayName,
            detail: prog?.detail,
          }),
        }).catch(() => { clientGone = true; });
      } else if (event.type === "tool_end") {
        stream.writeSSE({
          event: "tool",
          data: JSON.stringify({ type: "tool", state: "end", name: event.displayName }),
        }).catch(() => { clientGone = true; });
      }
    };

    tracer.start("claude", {
      mode: opts.mode,
      model: botConfig.model,
      connector: botConfig.connector ?? "claude-cli",
    });
    const claude = await executeOneShot(opts.userPrompt, config, botConfig, {
      systemPrompt: opts.systemPrompt,
      onProgress,
      timeoutMs: FACTCHECK_TIMEOUT_MS,
    });
    usage = {
      inputTokens: claude.inputTokens,
      outputTokens: claude.outputTokens,
      numTurns: claude.numTurns,
      costUsd: claude.costUsd,
    };
    tracer.end("claude", { ...usage, model: claude.model, toolCount: claude.toolCalls?.length ?? 0 });
    if (claude.model) agentStatus.setModel(reqId, claude.model);
    // Tool child spans (the WebFetch calls) hang off the `claude` span.
    await attachToolSpans(tracer, claude.toolCalls, !!config.tracingCaptureToolOutputs);

    const answer = (claude.result ?? "").trim();
    const claimCount = countFactcheckClaims(answer);
    log.info("Fact check done bot={bot} mode={mode} claims={claims} tools={tools} tokens={tokens}", {
      bot: botConfig.name,
      mode: opts.mode,
      claims: claimCount,
      tools: claude.toolCalls?.length ?? 0,
      tokens: claude.outputTokens,
    });

    // `done` carries the extra fact-check fields the client status line + PR B
    // need. `cited`/`noHits`/`lowConfidence` keep the Ask/Explain done shape so
    // the shared `runAskStream` done handler consumes it unchanged.
    await stream.writeSSE({
      event: "done",
      data: JSON.stringify({
        type: "done",
        answer,
        cited: [],
        noHits: false,
        lowConfidence: false,
        claimCount,
        baseHash: opts.baseHash,
        mode: opts.mode,
      }),
    });

    // Trailing server-rendered HTML (same pipeline as Ask/Explain) — the client
    // swaps its streamed plain text for it. A throw here is swallowed.
    if (opts.renderAnswerHtml) {
      try {
        const html = opts.renderAnswerHtml(answer);
        await stream.writeSSE({ event: "answer_html", data: JSON.stringify({ html, cited: [] }) });
      } catch (err) {
        log.warn("Fact check answer_html render failed — keeping streamed text: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    status = "error";
    const message = err instanceof Error ? err.message : String(err);
    tracer.end("claude", { error: message });
    tracer.finish("error", { error: message });
    log.error("Fact check failed bot={bot} error={error}", { bot: botConfig.name, error: message });
    await stream.writeSSE({ event: "app_error", data: JSON.stringify({ type: "error", message }) });
  } finally {
    if (status === "ok") tracer.finish("ok", usage);
    agentStatus.completeRequest(reqId, {
      ...usage,
      ...(config.tracingEnabled ? { traceId } : {}),
    });
  }
}
