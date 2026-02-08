import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeResult } from "../types.ts";
import { parseClaudeOutput } from "./result-parser.ts";

export interface ClaudeExecResult extends ClaudeResult {
  wallClockMs: number;
  startupMs: number;
}

export async function executeClaudePrompt(
  prompt: string,
  config: Config,
  botConfig: BotConfig,
  systemPrompt?: string,
): Promise<ClaudeExecResult> {
  const wallStart = performance.now();

  const args = [
    "claude",
    "-p", prompt,
    "--output-format", "json",
    "--model", config.claudeModel,
  ];

  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }

  const proc = Bun.spawn(
    args,
    {
      cwd: botConfig.dir,
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: `${botConfig.name}-bot`,
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => {
        console.error(`[${botConfig.name}] Claude process timed out after ${config.claudeTimeoutMs}ms — killing PID ${proc.pid}`);
        proc.kill();
        reject(new Error(`Claude timed out after ${config.claudeTimeoutMs}ms`));
      },
      config.claudeTimeoutMs,
    );
  });

  const resultPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(`[${botConfig.name}] Claude process exited with code ${exitCode} (PID ${proc.pid})\n  stderr: ${stderr.slice(0, 500)}`);
      throw new Error(`Claude exited with code ${exitCode}: ${stderr}`);
    }

    const wallClockMs = performance.now() - wallStart;
    const parsed = parseClaudeOutput(stdout);
    const startupMs = wallClockMs - parsed.durationMs;

    return { ...parsed, wallClockMs, startupMs };
  })();

  return Promise.race([resultPromise, timeoutPromise]);
}
