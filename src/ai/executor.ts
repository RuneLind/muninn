import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeResult } from "../types.ts";
import { StreamParser } from "./stream-parser.ts";
import { parseClaudeOutput } from "./result-parser.ts";
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
): Promise<ClaudeExecResult> {
  const wallStart = performance.now();

  const model = botConfig.model ?? config.claudeModel;
  const timeoutMs = botConfig.timeoutMs ?? config.claudeTimeoutMs;

  const args = [
    "claude",
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
  ];

  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_ENTRYPOINT: `${botConfig.name}-bot`,
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
    // Read stdout line-by-line with timestamps for accurate tool call timing
    const lines = await readLinesWithTimestamps(proc.stdout);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      log.error("Claude process exited with code {exitCode} (PID {pid})\n  stderr: {stderr}", { botName: botConfig.name, exitCode, pid: proc.pid, stderr: stderr.slice(0, 500) });
      throw new Error(`Claude exited with code ${exitCode}: ${stderr}`);
    }

    const wallClockMs = performance.now() - wallStart;
    const parsed = parseStreamOutput(lines, botConfig.name);
    const startupMs = wallClockMs - parsed.durationMs;

    return { ...parsed, wallClockMs, startupMs };
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

interface TimestampedLine {
  line: string;
  timestamp: number;
}

/** Read stdout as timestamped lines for tool call duration tracking */
async function readLinesWithTimestamps(stdout: ReadableStream<Uint8Array>): Promise<TimestampedLine[]> {
  const lines: TimestampedLine[] = [];
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
          lines.push({ line, timestamp: performance.now() });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Handle remaining buffer (no trailing newline)
  if (buffer.trim()) {
    lines.push({ line: buffer, timestamp: performance.now() });
  }

  return lines;
}

/** Parse stream-json NDJSON lines, falling back to legacy JSON parser */
function parseStreamOutput(lines: TimestampedLine[], botName: string): ClaudeResult {
  // Try stream-json parsing first
  try {
    const parser = new StreamParser();
    for (const { line, timestamp } of lines) {
      parser.parseLine(line, timestamp);
    }
    if (parser.complete) {
      return parser.getResult();
    }
  } catch (e) {
    // If stream parser threw a Claude error (is_error: true), rethrow
    if (e instanceof Error && e.message.startsWith("Claude error:")) {
      throw e;
    }
    log.warn("Stream parser failed, trying legacy JSON parser: {error}", { botName, error: String(e) });
  }

  // Fallback: concatenate all lines and try legacy JSON parse
  // This handles cases where stream-json result event is missing (known bug)
  const fullOutput = lines.map((l) => l.line).join("\n");
  log.warn("Falling back to legacy JSON parser ({lineCount} lines)", { botName, lineCount: lines.length });
  return parseClaudeOutput(fullOutput);
}
