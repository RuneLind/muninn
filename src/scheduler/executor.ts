/**
 * Shared Haiku subprocess helper for scheduled tasks and goal reminders.
 * Single place for the spawn + parse + fallback pattern.
 */
export async function callHaiku(
  prompt: string,
  fallback: string,
): Promise<string> {
  try {
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
          CLAUDE_CODE_ENTRYPOINT: "jarvis-scheduler",
        },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return fallback;

    const claudeOutput: { result: string } = JSON.parse(stdout);
    return claudeOutput.result.trim();
  } catch {
    return fallback;
  }
}
