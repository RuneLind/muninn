import type { Config } from "../config.ts";
import type { ClaudeResult } from "../types.ts";
import { parseClaudeOutput } from "./result-parser.ts";

export async function executeClaudePrompt(
  prompt: string,
  config: Config,
): Promise<ClaudeResult> {
  const proc = Bun.spawn(
    [
      "claude",
      "-p", prompt,
      "--output-format", "json",
      "--model", config.claudeModel,
    ],
    {
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: "jarvis-bot",
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => {
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
      throw new Error(`Claude exited with code ${exitCode}: ${stderr}`);
    }

    return parseClaudeOutput(stdout);
  })();

  return Promise.race([resultPromise, timeoutPromise]);
}
