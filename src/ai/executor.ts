import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeResult } from "../types.ts";
import { StreamParser, type StreamProgressCallback } from "./stream-parser.ts";
import { parseClaudeOutput } from "./result-parser.ts";
import { preflightMcpForRequest } from "./mcp-status.ts";
import { logTraceFlagsOnce } from "./huginn-trace.ts";
import { getLog } from "../logging.ts";

const log = getLog("ai", "executor");

export interface ClaudeExecResult extends ClaudeResult {
  wallClockMs: number;
}

export async function executeClaudePrompt(
  prompt: string,
  config: Config,
  botConfig: BotConfig,
  systemPrompt?: string,
  onProgress?: StreamProgressCallback,
): Promise<ClaudeExecResult> {
  const wallStart = performance.now();
  logTraceFlagsOnce();

  const model = botConfig.model ?? config.claudeModel;
  const timeoutMs = botConfig.timeoutMs ?? config.claudeTimeoutMs;

  const args = [
    "claude",
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", model,
  ];

  // Claude CLI discovers .mcp.json from the git root, not from cwd.
  // Bot dirs are subdirectories, so explicitly pass their .mcp.json.
  const mcpConfigPath = join(botConfig.dir, ".mcp.json");
  if (existsSync(mcpConfigPath)) {
    args.push("--mcp-config", mcpConfigPath);
    // Pre-flight: warn if a *critical* MCP server is down (cached probe).
    await preflightMcpForRequest(botConfig, onProgress);
  }

  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }

  // Exclude specific tools (e.g. native tools during jira analysis to force MCP usage)
  if (botConfig.excludedTools && botConfig.excludedTools.length > 0) {
    args.push("--disallowedTools", botConfig.excludedTools.join(","));
  }

  // Caller-supplied extra args (e.g. benchmark runner adds --strict-mcp-config
  // and --disallowedTools to fence the spawned bot off from harness/global MCPs).
  if (botConfig.spawnArgs && botConfig.spawnArgs.length > 0) {
    args.push(...botConfig.spawnArgs);
  }

  // "--" signals end of options so prompts starting with "-" aren't parsed as flags
  args.push("--", prompt);

  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_ENTRYPOINT: `${botConfig.name}-bot`,
    // Huginn MCP adapters embed a search trace in their tool result when this
    // is set. The CLI inherits this env and propagates it to spawned MCP
    // servers; non-Huginn servers ignore it. The stream parser peels the
    // ```huginn-trace``` fence off before truncateOutput runs so searchTrace
    // lands on attributes.searchTrace even for ~36 KB results where the fence
    // would otherwise fall past the 16 KB storage cap.
    HUGINN_TRACE_DEFAULT: "1",
  };
  if (botConfig.thinkingMaxTokens !== undefined) {
    env.MAX_THINKING_TOKENS = String(botConfig.thinkingMaxTokens);
  }

  const proc = Bun.spawn(
    args,
    {
      cwd: botConfig.dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );

  let timeoutTimer: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(
      () => {
        log.error("Claude process timed out after {timeoutMs}ms — killing PID {pid}", { botName: botConfig.name, timeoutMs, pid: proc.pid });
        proc.kill();
        reject(new Error(`Claude timed out after ${timeoutMs}ms`));
      },
      timeoutMs,
    );
  });

  const resultPromise = (async () => {
    // Read stdout line-by-line, feeding each to StreamParser incrementally
    // for real-time tool progress callbacks
    const { result: parsed, rawLines } = await readAndParseIncrementally(
      proc.stdout, wallStart, onProgress, botConfig.name,
    );
    captureStreamIfEnabled(botConfig.name, rawLines);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      log.error("Claude process exited with code {exitCode} (PID {pid})\n  stderr: {stderr}", { botName: botConfig.name, exitCode, pid: proc.pid, stderr: stderr.slice(0, 500) });
      throw new Error(`Claude exited with code ${exitCode}: ${stderr}`);
    }

    if (parsed) {
      const wallClockMs = performance.now() - wallStart;
      // Both terms are monotonic (performance.now), but durationMs comes from the
      // child's clock and wallClockMs from ours, so a tiny cross-process measurement
      // window can make the subtraction go slightly negative. Clamp to 0 — cosmetic.
      const startupMs = Math.max(0, wallClockMs - parsed.durationMs);
      return { ...parsed, wallClockMs, startupMs };
    }

    // Fallback: stream parser didn't complete (known CLI bug — missing result event)
    const fullOutput = rawLines.join("\n");
    log.warn("Falling back to legacy JSON parser ({lineCount} lines)", { botName: botConfig.name, lineCount: rawLines.length });
    const fallback = parseClaudeOutput(fullOutput);
    const wallClockMs = performance.now() - wallStart;
    const startupMs = Math.max(0, wallClockMs - fallback.durationMs);
    return { ...fallback, wallClockMs, startupMs };
  })();

  try {
    const result = await Promise.race([resultPromise, timeoutPromise]);
    clearTimeout(timeoutTimer!);
    return result;
  } catch (error) {
    clearTimeout(timeoutTimer!);
    throw error;
  }
}

interface IncrementalResult {
  result: ClaudeResult | null;
  rawLines: string[];
}

/** Read stdout line-by-line, feeding each to StreamParser incrementally for real-time progress */
async function readAndParseIncrementally(
  stdout: ReadableStream<Uint8Array>,
  referenceTimestamp: number,
  onProgress: StreamProgressCallback | undefined,
  botName: string,
): Promise<IncrementalResult> {
  const parser = new StreamParser(referenceTimestamp, onProgress);
  const rawLines: string[] = [];
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let parseError: Error | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Extract complete lines from buffer
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.trim()) {
          rawLines.push(line);
          if (!parseError) {
            try {
              parser.parseLine(line, performance.now());
            } catch (e) {
              // If stream parser threw a Claude error (is_error: true), rethrow immediately
              if (e instanceof Error && e.message.startsWith("Claude error:")) {
                throw e;
              }
              parseError = e instanceof Error ? e : new Error(String(e));
              log.warn("Stream parser failed, will use legacy fallback: {error}", { botName, error: String(e) });
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Handle remaining buffer (no trailing newline)
  if (buffer.trim()) {
    rawLines.push(buffer);
    if (!parseError) {
      try {
        parser.parseLine(buffer, performance.now());
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Claude error:")) {
          throw e;
        }
        parseError = e instanceof Error ? e : new Error(String(e));
      }
    }
  }

  if (!parseError && parser.complete) {
    return { result: parser.getResult(), rawLines };
  }

  return { result: null, rawLines };
}

function captureStreamIfEnabled(botName: string, rawLines: string[]): void {
  if (process.env.MUNINN_DEBUG_CAPTURE_STREAM !== "1") return;
  try {
    const dir = join(process.cwd(), "logs", "stream-capture");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${stamp}-${botName}.ndjson`);
    writeFileSync(path, rawLines.join("\n") + "\n", "utf8");
    log.info("Captured {n} stream-json lines to {path}", { botName, n: rawLines.length, path });
  } catch (e) {
    log.warn("Failed to capture stream-json: {error}", { botName, error: String(e) });
  }
}
