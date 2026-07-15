import { callHaikuWithFallback, type HaikuBackend } from "./haiku-direct.ts";
import { extractJson } from "./json-extract.ts";
import { runTrackedExtraction } from "./extraction-tracker.ts";
import { agentStatus } from "../observability/agent-status.ts";
import { Tracer, type TraceContext } from "../tracing/index.ts";
import type { Logger } from "@logtape/logtape";
import type { ConnectorType } from "../bots/config.ts";

interface HaikuExtractionOptions<T> {
  /** Span name for tracing (e.g. "memory_extraction") */
  spanName: string;
  /** Source label for the Haiku call (e.g. "memory") */
  source: string;
  /** Entrypoint label for the Haiku call (e.g. "jarvis-memory") */
  entrypoint: string;
  /** The bot name */
  botName: string;
  /** The user ID */
  userId: string;
  /** The prompt to send to Haiku */
  prompt: string;
  /** Working directory for the CLI fallback — keeps sessions out of project root */
  cwd?: string;
  /** Bot's main connector — fed into `resolveBackend()` for the connector-derived default. */
  connector?: ConnectorType;
  /** Per-bot override from `BotConfig.haikuBackend`. */
  haikuBackend?: HaikuBackend;
  /** Logger instance for error reporting */
  log: Logger;
  /** Optional trace context for parent span linking */
  traceContext?: TraceContext;
  /** Called with parsed result; return tracer finish attributes or void */
  onResult: (result: T, tracer?: Tracer) => Promise<void>;
}

/**
 * Shared fire-and-forget Haiku extraction pattern.
 * Handles: async wrapper with error logging, tracer setup,
 * callHaikuWithFallback + extractJson parsing, and error/parse-failure handling.
 *
 * Runs through {@link runTrackedExtraction} so the work is concurrency-bounded
 * and drained on shutdown. The per-extraction `.catch` here preserves the
 * span-specific error log; the tracker's own catch is a final safety net.
 */
export function runHaikuExtraction<T>(opts: HaikuExtractionOptions<T>): void {
  runTrackedExtraction(() =>
    doExtract(opts).catch((err) => {
      opts.log.error(`${opts.spanName} failed: {error}`, {
        botName: opts.botName,
        error: err instanceof Error ? err.message : String(err),
      });
    }),
  );
}

async function doExtract<T>(opts: HaikuExtractionOptions<T>): Promise<void> {
  // AgentRun registry mirror (/agents dashboard). Registered on entry, completed
  // in the `finally` wrapping the WHOLE body — doExtract has three exits (success
  // via onResult, the JSON parse-failure early `return`, and an onResult throw);
  // only a finally completes on all three, so the run never leaks (auto-clear only
  // fires on completeRequest). No meta is readable here (the tracer is a local and
  // only exists when traceContext is set) — extractor Recent comes from haiku_usage.
  const reqId = agentStatus.startRequest(opts.botName, "calling_claude", undefined, {
    kind: "extractor",
    name: `Extractor: ${opts.source}`,
  });
  try {
    let tracer: Tracer | undefined;
    if (opts.traceContext) {
      tracer = new Tracer(opts.spanName, {
        botName: opts.botName,
        userId: opts.userId,
        traceId: opts.traceContext.traceId,
        parentId: opts.traceContext.parentId,
      });
    }

    const haiku = await callHaikuWithFallback(opts.prompt, {
      source: opts.source,
      entrypoint: opts.entrypoint,
      cwd: opts.cwd,
      botName: opts.botName,
      connector: opts.connector,
      haikuBackend: opts.haikuBackend,
      // (a) The join: hand the tracer to the router so its trackUsage call ties
      // the haiku_usage row back to this extraction's trace (NULL without it —
      // the ~89% of rows the anthropic/copilot backends wrote before this fix).
      tracer,
    });

    // (b) Span attributes: callHaikuDirect / callHaikuViaCopilot return usage but
    // never write it onto a span, so this extractor's (childless) root span would
    // still carry no model/tokens after (a). Mirror the watcher runner's
    // onUsage → finish stamping: fold the call's usage into whatever attributes
    // the finish writes — onResult's success finish, the parse-failure finish, or
    // the onResult-throw error finish below — so a read off the root span's own
    // attributes surfaces the model + tokens.
    if (tracer) {
      const usageAttrs = {
        model: haiku.model,
        inputTokens: haiku.inputTokens,
        outputTokens: haiku.outputTokens,
      };
      const baseFinish = tracer.finish.bind(tracer);
      tracer.finish = (status: "ok" | "error" = "ok", attributes?: Record<string, unknown>): void =>
        baseFinish(status, { ...usageAttrs, ...attributes });
    }

    let result: T;
    try {
      result = extractJson<T>(haiku.result);
    } catch {
      opts.log.error(`${opts.spanName}: failed to parse result: {raw}`, {
        botName: opts.botName,
        raw: haiku.result.slice(0, 300),
      });
      tracer?.finish("error", {
        error: "parse_failed",
        rawResult: haiku.result.slice(0, 300),
      });
      return;
    }

    try {
      await opts.onResult(result, tracer);
    } catch (err) {
      tracer?.finish("error", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  } finally {
    agentStatus.completeRequest(reqId, {});
  }
}
