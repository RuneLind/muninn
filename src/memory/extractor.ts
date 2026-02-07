import type { Config } from "../config.ts";
import { saveMemory } from "../db/memories.ts";
import { generateEmbedding } from "../ai/embeddings.ts";

interface ExtractionInput {
  userId: number;
  userMessage: string;
  assistantResponse: string;
  sourceMessageId?: string;
}

interface ExtractionResult {
  worth_remembering: boolean;
  summary?: string;
  tags?: string[];
}

const EXTRACTION_PROMPT = `You are a memory extraction system. Analyze this conversation exchange and decide if it contains information worth remembering for future conversations.

Worth remembering: facts about the user, preferences, decisions, project details, important context, recurring topics.
NOT worth remembering: greetings, thanks, simple factual lookups, small talk.

Respond with ONLY valid JSON (no markdown fences):
{"worth_remembering": false}
or
{"worth_remembering": true, "summary": "Brief 1-sentence summary", "tags": ["tag1", "tag2"]}

User said: """
{USER_MESSAGE}
"""

Assistant replied: """
{ASSISTANT_RESPONSE}
"""`;

export function extractMemoryAsync(input: ExtractionInput, config: Config): void {
  // Fire and forget — don't block the chat response
  doExtract(input, config).catch((err) => {
    console.error("Memory extraction failed:", err);
  });
}

async function doExtract(input: ExtractionInput, config: Config): Promise<void> {
  const prompt = EXTRACTION_PROMPT
    .replace("{USER_MESSAGE}", input.userMessage)
    .replace("{ASSISTANT_RESPONSE}", input.assistantResponse);

  const proc = Bun.spawn(
    [
      "claude",
      "-p", prompt,
      "--output-format", "json",
      "--model", "claude-haiku-4-5-20251001",
    ],
    {
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: "jarvis-memory",
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
    console.error("Memory extraction claude error:", stderr);
    return;
  }

  let claudeOutput: { result: string };
  try {
    claudeOutput = JSON.parse(stdout);
  } catch {
    console.error("Memory extraction: failed to parse claude JSON output");
    return;
  }

  let result: ExtractionResult;
  try {
    // Strip markdown fences if Haiku wraps the JSON in ```json ... ```
    const cleaned = claudeOutput.result.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/,"");
    result = JSON.parse(cleaned);
  } catch {
    console.error("Memory extraction: failed to parse extraction result:", claudeOutput.result);
    return;
  }

  if (!result.worth_remembering || !result.summary || !result.tags) {
    return;
  }

  const embedding = await generateEmbedding(result.summary);

  await saveMemory({
    userId: input.userId,
    content: `User: ${input.userMessage}\nAssistant: ${input.assistantResponse}`,
    summary: result.summary,
    tags: result.tags,
    sourceMessageId: input.sourceMessageId,
    embedding,
  });
}
