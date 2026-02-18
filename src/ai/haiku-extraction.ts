import { spawnHaiku } from "../scheduler/executor.ts";
import { extractJson } from "./json-extract.ts";
import { Tracer, type TraceContext } from "../tracing/index.ts";
import type { Logger } from "@logtape/logtape";

interface HaikuExtractionOptions<T> {
  /** Span name for tracing (e.g. "memory_extraction") */
  spanName: string;
  /** Source label for spawnHaiku (e.g. "memory") */
  source: string;
  /** Entrypoint for spawnHaiku (e.g. "jarvis-memory") */
  entrypoint: string;
  /** The bot name */
  botName: string;
  /** The user ID */
  userId: string;
  /** The prompt to send to Haiku */
  prompt: string;
  /** Working directory for the Haiku process — keeps sessions out of project root */
  cwd?: string;
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
 * spawnHaiku + extractJson parsing, and error/parse-failure handling.
 */
export function runHaikuExtraction<T>(opts: HaikuExtractionOptions<T>): void {
  doExtract(opts).catch((err) => {
    opts.log.error(`${opts.spanName} failed: {error}`, {
      botName: opts.botName,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

async function doExtract<T>(opts: HaikuExtractionOptions<T>): Promise<void> {
  let tracer: Tracer | undefined;
  if (opts.traceContext) {
    tracer = new Tracer(opts.spanName, {
      botName: opts.botName,
      userId: opts.userId,
      traceId: opts.traceContext.traceId,
      parentId: opts.traceContext.parentId,
    });
  }

  const haiku = await spawnHaiku(
    opts.prompt,
    opts.source,
    opts.entrypoint,
    opts.cwd,
    opts.botName,
  );

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
}
