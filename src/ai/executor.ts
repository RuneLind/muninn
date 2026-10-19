import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeResult } from "../types.ts";
import { StreamParser, type StreamProgressCallback } from "./stream-parser.ts";
import { parseClaudeOutput } from "./result-parser.ts";
import { preflightMcpForRequest } from "./mcp-status.ts";
import { logTraceFlagsOnce } from "./huginn-trace.ts";
import { resolveFencedAgentCwd } from "./agent-cwd.ts";
import {
  assertRestrictedCliAvailable,
  fencedSettings,
  fencedSurface,
  fencedTools,
  isReadSurface,
  MIN_RESTRICTED_CLI_VERSION,
  restrictedCliAvailable,
} from "./tool-surface.ts";
import { getLog } from "../logging.ts";

const log = getLog("ai", "executor");

let warnedNoneUnrestricted = false;
function warnNoneUnrestrictedOnce(): void {
  if (warnedNoneUnrestricted) return;
  warnedNoneUnrestricted = true;
  log.warn(
    `claude-cli: a "none" tool surface runs without --restricted (needs Claude CLI ${MIN_RESTRICTED_CLI_VERSION} or newer), ` +
      "so the user's hooks and CLAUDE.md still load. The tools stay off.",
  );
}

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
  const fence = fencedSurface(botConfig.toolSurface);
  if (fence) {
    await assertRestrictedCliAvailable(fence);
    // spawnArgs land after the fence flags, and a later --settings or
    // --mcp-config wins, so they could undo it.
    if (botConfig.spawnArgs && botConfig.spawnArgs.length > 0) {
      throw new Error(
        `claude-cli: a fenced tool surface refuses spawnArgs (${botConfig.spawnArgs.join(" ")}) — a later flag would undo the fence.`,
      );
    }
  }
  // A run with no tools ("none") also takes `--restricted` and the empty agent
  // home: otherwise it runs the user's shell hooks and loads the user's and the
  // bot folder's CLAUDE.md into every call. The tools are off either way, so an
  // older CLI without `--restricted` keeps the plain `--tools ""` argv.
  // An agent home that cannot be created refuses a fenced run, but not this
  // one: with no tools there is nothing for the shared temp dir to expose.
  let fencedCwd = fence ? resolveFencedAgentCwd() : undefined;
  let restrictNone = false;
  if (!fence && botConfig.toolsDisabled === true) {
    if (await restrictedCliAvailable()) {
      try {
        fencedCwd = resolveFencedAgentCwd();
        restrictNone = true;
      } catch (err) {
        log.warn("claude-cli: a \"none\" run falls back to the bot folder: {error}", {
          botName: botConfig.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      warnNoneUnrestrictedOnce();
    }
  }

  const args = [
    "claude",
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", model,
  ];

  // Effort is the thinking control on adaptive-thinking models (Opus/Sonnet 4.6+,
  // the 5.5 models included); Claude Code ignores MAX_THINKING_TOKENS there.
  // `--restricted` drops the user settings' `effortLevel`, so a fenced run
  // states one.
  if (botConfig.effort) {
    args.push("--effort", botConfig.effort);
  } else if (fence || restrictNone) {
    args.push("--effort", "high");
  }

  // The CLI also discovers .mcp.json from its cwd; passing it explicitly is
  // what the MCP preflight below pairs with.
  const mcpConfigPath = join(botConfig.dir, ".mcp.json");
  if (fence) {
    // `--restricted` ignores the user, project and local settings files, confines
    // the file tools to the working dirs and refuses bypass; `--tools` names the
    // whole built-in set and `--strict-mcp-config` with no `--mcp-config` loads
    // no MCP server. One `--settings` only: the last flag wins.
    args.push("--restricted", "--tools", fencedTools(fence).join(","), "--strict-mcp-config");
    if (isReadSurface(fence)) {
      for (const dir of fence.read) args.push("--add-dir", dir);
    }
    const settings = fencedSettings(fence);
    if (settings) args.push("--settings", JSON.stringify(settings));
  } else if (botConfig.toolsDisabled) {
    // `--tools ""` removes every built-in; --strict-mcp-config with no
    // --mcp-config removes every MCP server, including the user-global ones
    // (IDE, peer messaging, claude.ai connectors) the CLI discovers on its own.
    args.push("--tools", "", "--strict-mcp-config");
    if (restrictNone) args.push("--restricted");
  } else if (existsSync(mcpConfigPath)) {
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
      // A fenced run's cwd is an empty agent home: the working dir is readable
      // without approval, so the bot folder would expose its config files.
      cwd: fencedCwd ?? botConfig.dir,
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
  const parser = new StreamParser(referenceTimestamp, onProgress, botName);
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
