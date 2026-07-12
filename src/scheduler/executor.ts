import { getDb } from "../db/client.ts";
import { getLog } from "../logging.ts";
import { pickPrimaryModel } from "../ai/result-parser.ts";
import { StreamParser, type StreamProgressCallback } from "../ai/stream-parser.ts";
import { attachToolSpans } from "../core/tool-spans.ts";
import type { ClaudeResult, ToolCall } from "../types.ts";
import type { Tracer } from "../tracing/index.ts";

const log = getLog("scheduler", "executor");

export interface HaikuResult {
  result: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** Tool calls parsed from the stream (empty/undefined for tool-less Haiku prompts). */
  toolCalls?: ToolCall[];
  /** Number of assistant turns (from the CLI result event). Undefined for direct-SDK backends. */
  numTurns?: number;
  /** Total cost in USD (from the CLI result event). Undefined for direct-SDK backends. */
  costUsd?: number;
}

/**
 * Optional telemetry seams threaded into a `spawnHaiku` call so a Haiku-driven
 * agent (the email/x/anthropic watchers) surfaces its tool use like the chat
 * connector does:
 *  - `onProgress` fills the `/agents` Running card's tool mini-log live.
 *  - `tracer` receives tool child spans (under its root span) so the traces
 *    waterfall + `getToolUsageStats` pick them up.
 *  - `captureToolOutputs` mirrors `config.tracingCaptureToolOutputs`.
 * All optional — a `spawnHaiku` call with none behaves exactly as before.
 */
export interface HaikuTelemetry {
  onProgress?: StreamProgressCallback;
  tracer?: Tracer;
  captureToolOutputs?: boolean;
}

/**
 * Low-level Haiku spawn: runs Claude Haiku and returns result + token usage.
 * All async Haiku calls should use this to get token tracking.
 *
 * When cwd is provided, Claude CLI auto-discovers .mcp.json and
 * .claude/settings.json from that directory, keeping bot
 * sessions isolated from the dev project root.
 */
export const HAIKU_TIMEOUT_MS = 60_000;

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Parse Haiku stdout as JSON, throwing a descriptive error (including a stdout
 * preview) on failure. Mirrors the email watcher's slice(0,300) preview so an
 * unparseable Haiku response surfaces a useful message instead of a bare
 * "Watcher failed" (the X watcher at watchers/x.ts still uses a bare JSON.parse).
 */
export function parseHaikuJson(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `Failed to parse Haiku JSON output: ${err instanceof Error ? err.message : String(err)} — stdout: ${stdout.slice(0, 300)}`,
    );
  }
}

export interface SpawnHaikuOptions extends HaikuTelemetry {
  source: string;
  entrypoint?: string;
  cwd?: string;
  botName?: string;
  timeoutMs?: number;
  model?: string;
  /** Max output tokens for direct-SDK backends (anthropic). Ignored by the CLI spawn. */
  maxTokens?: number;
}

export async function spawnHaiku(
  prompt: string,
  opts: SpawnHaikuOptions,
): Promise<HaikuResult> {
  const {
    source,
    entrypoint = "jarvis-scheduler",
    cwd,
    botName,
    timeoutMs = HAIKU_TIMEOUT_MS,
    model,
    onProgress,
    tracer,
    captureToolOutputs,
  } = opts;
  const effectiveModel = model || DEFAULT_MODEL;
  const wallStart = performance.now();
  // `stream-json` + `--verbose` (required together with `-p`) makes the CLI emit
  // NDJSON tool_use / tool_result events, so `StreamParser` can surface the
  // agent's tool calls — the same wire format the chat connector consumes. A
  // missing final `result` event (a known CLI bug) drops us to the legacy
  // single-JSON parse below, mirroring src/ai/executor.ts.
  const args = [
    "claude",
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    effectiveModel,
  ];

  const proc = Bun.spawn(
    args,
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: entrypoint,
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );

  let timeoutTimer: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      log.error("Haiku process timed out after {timeoutMs}ms — killing PID {pid}", { botName: botName ?? "haiku", timeoutMs, pid: proc.pid });
      proc.kill();
      reject(new Error(`Haiku timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  // Drain stderr eagerly so a chatty child can't block on a full stderr pipe
  // while we read stdout.
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");

  const resultPromise = (async (): Promise<HaikuResult> => {
    // Read stdout line-by-line so tool progress callbacks + tool timing are live.
    const { result: streamed, rawLines } = await readAndParseHaikuStream(
      proc.stdout, wallStart, onProgress, botName,
    );
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await stderrPromise;
      throw new Error(`Claude Haiku exited with code ${exitCode}: ${stderr}`);
    }

    const haiku = streamed
      ? claudeResultToHaiku(streamed, effectiveModel)
      // Fallback: stream parser didn't complete (known CLI bug — missing result
      // event, or the CLI degraded to a single legacy JSON blob). Recover the
      // result/tokens from the raw output via the legacy parser.
      : parseLegacyHaikuOutput(rawLines.join("\n"), effectiveModel);

    if (!streamed) {
      log.warn("Haiku stream parser incomplete, falling back to legacy JSON parse ({lineCount} lines)", {
        botName: botName ?? "haiku", lineCount: rawLines.length,
      });
    }

    // Track usage async — don't block the caller
    trackUsage(source, haiku.model, haiku.inputTokens, haiku.outputTokens, botName);

    // Emit tool child spans under the tracer's root span (the `watcher:<type>`
    // span) so the waterfall + getToolUsageStats pick them up. attachToolSpans'
    // "claude" parent label is absent here, so it falls back to the root span.
    if (tracer && haiku.toolCalls && haiku.toolCalls.length > 0) {
      await attachToolSpans(tracer, haiku.toolCalls, captureToolOutputs ?? false);
    }

    return haiku;
  })();

  try {
    return await Promise.race([resultPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutTimer!);
  }
}

/** Map a StreamParser `ClaudeResult` into a `HaikuResult`. */
function claudeResultToHaiku(r: ClaudeResult, effectiveModel: string): HaikuResult {
  return {
    result: r.result,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    model: r.model && r.model !== "unknown" ? r.model : effectiveModel,
    toolCalls: r.toolCalls,
    numTurns: r.numTurns,
    costUsd: r.costUsd,
  };
}

/**
 * Legacy single-JSON parse — the pre-stream-json extraction, kept as the
 * fallback for the known CLI bug where the final `result` event goes missing
 * (or the CLI degrades to `--output-format json` output). Preserves the CLI-2.x
 * result-as-object normalization the original spawnHaiku carried.
 */
export function parseLegacyHaikuOutput(stdout: string, effectiveModel: string): HaikuResult {
  const parsed = parseHaikuJson(stdout);

  const inputTokens = parsed.usage
    ? (parsed.usage.input_tokens ?? 0)
      + (parsed.usage.cache_creation_input_tokens ?? 0)
      + (parsed.usage.cache_read_input_tokens ?? 0)
    : 0;
  const outputTokens = parsed.usage?.output_tokens ?? 0;
  const model = parsed.modelUsage
    ? pickPrimaryModel(parsed.modelUsage) ?? effectiveModel
    : effectiveModel;

  // Normalize result to string — CLI 2.x may return an object
  let resultText: string;
  if (typeof parsed.result === "string") {
    resultText = parsed.result;
  } else if (parsed.result?.content) {
    // CLI 2.x object format: { content: [{ type: "text", text: "..." }] }
    const textBlock = parsed.result.content.find((b: any) => b.type === "text");
    resultText = textBlock?.text ?? "";
  } else {
    resultText = String(parsed.result ?? "");
  }

  return {
    result: resultText,
    inputTokens,
    outputTokens,
    model,
    numTurns: parsed.num_turns ?? 1,
    costUsd: parsed.total_cost_usd ?? parsed.cost_usd ?? 0,
  };
}

interface HaikuStreamResult {
  /** Parsed result when the stream completed with a `result` event, else null. */
  result: ClaudeResult | null;
  rawLines: string[];
}

/**
 * Read Haiku stdout line-by-line, feeding each NDJSON line to a StreamParser for
 * real-time tool progress + timing. Mirrors src/ai/executor.ts'
 * readAndParseIncrementally: a Claude `is_error` result rethrows immediately, any
 * other parse hiccup drops to the legacy fallback (null result + rawLines).
 */
export async function readAndParseHaikuStream(
  stdout: ReadableStream<Uint8Array>,
  referenceTimestamp: number,
  onProgress: StreamProgressCallback | undefined,
  botName: string | undefined,
): Promise<HaikuStreamResult> {
  const parser = new StreamParser(referenceTimestamp, onProgress);
  const rawLines: string[] = [];
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let parseError: Error | null = null;

  const feed = (line: string): void => {
    if (!line.trim()) return;
    rawLines.push(line);
    if (parseError) return;
    try {
      parser.parseLine(line, performance.now());
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Claude error:")) throw e;
      parseError = e instanceof Error ? e : new Error(String(e));
      log.warn("Haiku stream parser failed, will use legacy fallback: {error}", { botName: botName ?? "haiku", error: String(e) });
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        feed(line);
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Handle remaining buffer (no trailing newline)
  if (buffer.trim()) feed(buffer);

  if (!parseError && parser.complete) {
    return { result: parser.getResult(), rawLines };
  }
  return { result: null, rawLines };
}

/**
 * High-level Haiku call with fallback — used by scheduler runner.
 */
export async function callHaiku(
  prompt: string,
  fallback: string,
  source = "task",
  cwd?: string,
  botName?: string,
  timeoutMs?: number,
): Promise<string> {
  try {
    const { result } = await spawnHaiku(prompt, { source, cwd, botName, timeoutMs });
    return result.trim();
  } catch {
    return fallback;
  }
}

export function trackUsage(
  source: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  botName?: string,
): void {
  if (inputTokens === 0 && outputTokens === 0) return;

  const sql = getDb();
  sql`
    INSERT INTO haiku_usage (source, model, input_tokens, output_tokens, bot_name)
    VALUES (${source}, ${model}, ${inputTokens}, ${outputTokens}, ${botName ?? null})
  `.catch((err) => {
    log.error("Failed to track Haiku usage: {error}", { botName: botName ?? "haiku", error: err instanceof Error ? err.message : String(err) });
  });
}
