import { getDb } from "../db/client.ts";
import { getLog } from "../logging.ts";

const log = getLog("scheduler", "executor");

export interface HaikuResult {
  result: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
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

export async function spawnHaiku(
  prompt: string,
  source: string,
  entrypoint = "jarvis-scheduler",
  cwd?: string,
  botName?: string,
  timeoutMs = HAIKU_TIMEOUT_MS,
): Promise<HaikuResult> {
  const args = [
    "claude",
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    "claude-haiku-4-5-20251001",
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

  // Consume both streams eagerly to avoid resource leaks on timeout/kill
  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");

  let timeoutTimer: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      log.error("Haiku process timed out after {timeoutMs}ms — killing PID {pid}", { botName: botName ?? "haiku", timeoutMs, pid: proc.pid });
      proc.kill();
      reject(new Error(`Haiku timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const exitCode = await Promise.race([proc.exited, timeoutPromise]);

    if (exitCode !== 0) {
      const stderr = await stderrPromise;
      throw new Error(`Claude Haiku exited with code ${exitCode}: ${stderr}`);
    }

    const stdout = await stdoutPromise;
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

    // Track usage async — don't block the caller
    trackUsage(source, model, inputTokens, outputTokens, botName);

    return {
      result: resultText,
      inputTokens,
      outputTokens,
      model,
    };
  } finally {
    clearTimeout(timeoutTimer!);
  }
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
    const { result } = await spawnHaiku(prompt, source, "jarvis-scheduler", cwd, botName, timeoutMs);
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
