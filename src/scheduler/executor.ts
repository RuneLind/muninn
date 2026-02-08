import { getDb } from "../db/client.ts";

export interface HaikuResult {
  result: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * Low-level Haiku spawn: runs Claude Haiku and returns result + token usage.
 * All async Haiku calls should use this to get token tracking.
 */
export async function spawnHaiku(
  prompt: string,
  source: string,
  entrypoint = "jarvis-scheduler",
): Promise<HaikuResult> {
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      prompt,
      "--output-format",
      "json",
      "--model",
      "claude-haiku-4-5-20251001",
    ],
    {
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: entrypoint,
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Claude Haiku exited with code ${exitCode}: ${stderr}`);
  }

  const parsed = JSON.parse(stdout);

  const inputTokens = parsed.usage
    ? (parsed.usage.input_tokens ?? 0)
      + (parsed.usage.cache_creation_input_tokens ?? 0)
      + (parsed.usage.cache_read_input_tokens ?? 0)
    : 0;
  const outputTokens = parsed.usage?.output_tokens ?? 0;
  const model = parsed.modelUsage
    ? Object.keys(parsed.modelUsage)[0] ?? "claude-haiku-4-5-20251001"
    : "claude-haiku-4-5-20251001";

  // Track usage async — don't block the caller
  trackUsage(source, model, inputTokens, outputTokens);

  return {
    result: parsed.result,
    inputTokens,
    outputTokens,
    model,
  };
}

/**
 * High-level Haiku call with fallback — used by scheduler runner.
 */
export async function callHaiku(
  prompt: string,
  fallback: string,
  source = "task",
): Promise<string> {
  try {
    const { result } = await spawnHaiku(prompt, source);
    return result.trim();
  } catch {
    return fallback;
  }
}

function trackUsage(
  source: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): void {
  if (inputTokens === 0 && outputTokens === 0) return;

  const sql = getDb();
  sql`
    INSERT INTO haiku_usage (source, model, input_tokens, output_tokens)
    VALUES (${source}, ${model}, ${inputTokens}, ${outputTokens})
  `.catch((err) => {
    console.error("[Jarvis] Failed to track Haiku usage:", err);
  });
}
