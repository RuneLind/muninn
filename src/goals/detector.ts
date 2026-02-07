import type { Config } from "../config.ts";
import { saveGoal } from "../db/goals.ts";

interface DetectionInput {
  userId: number;
  userMessage: string;
  assistantResponse: string;
  sourceMessageId?: string;
}

interface DetectionResult {
  has_goal: boolean;
  title?: string;
  description?: string;
  deadline?: string; // ISO 8601 or null
  tags?: string[];
}

const DETECTION_PROMPT = `You are a goal detection system. Analyze this conversation exchange and decide if the user expressed a goal, commitment, intention, or deadline.

Worth detecting: explicit goals ("I need to finish X by Y"), commitments ("I'll do X this week"), deadlines, project milestones, action items the user assigned themselves.
NOT worth detecting: questions, requests for help, vague wishes, things the assistant is doing, information lookups.

Respond with ONLY valid JSON (no markdown fences):
{"has_goal": false}
or
{"has_goal": true, "title": "Short goal title", "description": "Brief context", "deadline": "2025-03-15T00:00:00Z", "tags": ["work", "report"]}

If there's a deadline, use ISO 8601 format. If no clear deadline, omit the deadline field or set it to null.

User said: """
{USER_MESSAGE}
"""

Assistant replied: """
{ASSISTANT_RESPONSE}
"""`;

export function extractGoalAsync(input: DetectionInput, config: Config): void {
  doExtract(input, config).catch((err) => {
    console.error("[Jarvis] Goal detection failed:", err);
  });
}

async function doExtract(
  input: DetectionInput,
  config: Config,
): Promise<void> {
  const prompt = DETECTION_PROMPT
    .replace("{USER_MESSAGE}", input.userMessage)
    .replace("{ASSISTANT_RESPONSE}", input.assistantResponse);

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
        CLAUDE_CODE_ENTRYPOINT: "jarvis-goals",
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
    console.error("[Jarvis] Goal detection claude error:", stderr);
    return;
  }

  let claudeOutput: { result: string };
  try {
    claudeOutput = JSON.parse(stdout);
  } catch {
    console.error("[Jarvis] Goal detection: failed to parse claude JSON output");
    return;
  }

  let result: DetectionResult;
  try {
    const cleaned = claudeOutput.result
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/, "");
    result = JSON.parse(cleaned);
  } catch {
    console.error(
      "[Jarvis] Goal detection: failed to parse detection result:",
      claudeOutput.result,
    );
    return;
  }

  if (!result.has_goal || !result.title) {
    return;
  }

  const deadline = result.deadline ? new Date(result.deadline) : null;

  const goalId = await saveGoal({
    userId: input.userId,
    title: result.title,
    description: result.description ?? null,
    deadline: deadline && !isNaN(deadline.getTime()) ? deadline : null,
    tags: result.tags ?? [],
    sourceMessageId: input.sourceMessageId ?? null,
  });

  console.log(`[Jarvis] Goal detected: "${result.title}" (id: ${goalId})`);
}
