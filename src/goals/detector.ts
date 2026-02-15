import type { Config } from "../config.ts";
import type { Platform } from "../types.ts";
import { saveGoal, getActiveGoals, updateGoalStatus } from "../db/goals.ts";
import { spawnHaiku } from "../scheduler/executor.ts";
import { extractJson } from "../ai/json-extract.ts";
import { Tracer, type TraceContext } from "../tracing/index.ts";
import { getLog } from "../logging.ts";

const log = getLog("goals");

interface DetectionInput {
  userId: string;
  botName: string;
  userMessage: string;
  assistantResponse: string;
  sourceMessageId?: string;
  platform?: Platform;
}

interface DetectionResult {
  action: "none" | "new" | "completed";
  title?: string;
  description?: string;
  deadline?: string; // ISO 8601 or null
  tags?: string[];
  completed_goal_title?: string;
}

export function extractGoalAsync(input: DetectionInput, config: Config, traceContext?: TraceContext): void {
  doExtract(input, config, traceContext).catch((err) => {
    log.error("Goal detection failed: {error}", { botName: input.botName, error: err instanceof Error ? err.message : String(err) });
  });
}

async function doExtract(
  input: DetectionInput,
  config: Config,
  traceContext?: TraceContext,
): Promise<void> {
  let tracer: Tracer | undefined;
  if (traceContext) {
    tracer = new Tracer("goal_detection", {
      botName: input.botName,
      userId: input.userId,
      traceId: traceContext.traceId,
      parentId: traceContext.parentId,
    });
  }

  // Load active goals so the detector can match completions
  let activeGoalsList = "";
  try {
    const goals = await getActiveGoals(input.userId, input.botName);
    if (goals.length > 0) {
      activeGoalsList = goals
        .map((g) => `- "${g.title}" (id: ${g.id})`)
        .join("\n");
    }
  } catch {
    // Non-critical
  }

  const prompt = buildPrompt(
    input.userMessage,
    input.assistantResponse,
    activeGoalsList,
  );

  const haiku = await spawnHaiku(prompt, "goals", "jarvis-goals", undefined, input.botName);

  let result: DetectionResult;
  try {
    result = extractJson<DetectionResult>(haiku.result);
  } catch {
    log.error("Goal detection: failed to parse result: {raw}", { botName: input.botName, raw: haiku.result.slice(0, 300) });
    tracer?.finish("error", { error: "parse_failed", rawResult: haiku.result.slice(0, 300) });
    return;
  }

  if (result.action === "completed" && result.completed_goal_title) {
    await handleCompletion(input.userId, result.completed_goal_title, input.botName);
    tracer?.finish("ok", { action: "completed", title: result.completed_goal_title });
    return;
  }

  if (result.action === "new" && result.title) {
    const deadline = result.deadline ? new Date(result.deadline) : null;

    const goalId = await saveGoal({
      userId: input.userId,
      botName: input.botName,
      title: result.title,
      description: result.description ?? null,
      deadline: deadline && !isNaN(deadline.getTime()) ? deadline : null,
      tags: result.tags ?? [],
      sourceMessageId: input.sourceMessageId ?? null,
      platform: input.platform,
    });

    log.info("Goal detected: \"{title}\" (id: {goalId})", { botName: input.botName, title: result.title, goalId });
    tracer?.finish("ok", { action: "new", title: result.title });
    return;
  }

  tracer?.finish("ok", { action: "none" });
}

async function handleCompletion(
  userId: string,
  completedTitle: string,
  botName: string,
): Promise<void> {
  const goals = await getActiveGoals(userId, botName);
  const titleLower = completedTitle.toLowerCase();

  // Fuzzy match: find the goal whose title best matches
  const match = goals.find(
    (g) =>
      g.title.toLowerCase().includes(titleLower) ||
      titleLower.includes(g.title.toLowerCase()),
  );

  if (match) {
    await updateGoalStatus(match.id, "completed");
    log.info("Goal completed: \"{title}\" (id: {goalId})", { botName, title: match.title, goalId: match.id });
  } else {
    log.info("Goal completion detected for \"{title}\" but no matching active goal found", { botName, title: completedTitle });
  }
}

function buildPrompt(
  userMessage: string,
  assistantResponse: string,
  activeGoals: string,
): string {
  return `You are a goal detection system. Analyze this conversation and decide:
1. Did the user express a NEW goal, commitment, or deadline?
2. Did the user indicate an EXISTING goal is completed/done/finished?

Worth detecting as NEW: explicit goals ("I need to finish X by Y"), commitments ("I'll do X this week"), deadlines, project milestones.
NOT worth detecting: questions, requests for help, vague wishes, things the assistant is doing.

Worth detecting as COMPLETED: user says a goal is done, finished, completed, shipped, or accomplished.
${activeGoals ? `\nCurrently active goals:\n${activeGoals}\n` : "\nNo active goals.\n"}
Respond with ONLY valid JSON (no markdown fences):
{"action": "none"}
or
{"action": "new", "title": "Short goal title", "description": "Brief context", "deadline": "2025-03-15T00:00:00Z", "tags": ["work"]}
or
{"action": "completed", "completed_goal_title": "matching goal title"}

If there's a deadline, use ISO 8601. If no clear deadline, omit it.

User said: """
${userMessage}
"""

Assistant replied: """
${assistantResponse}
"""`;
}
