import type { Config } from "../config.ts";
import { saveMemory } from "../db/memories.ts";
import { generateEmbedding } from "../ai/embeddings.ts";
import { spawnHaiku } from "../scheduler/executor.ts";
import { extractJson } from "../ai/json-extract.ts";
import { Tracer, type TraceContext } from "../tracing/index.ts";
import { getLog } from "../logging.ts";

const log = getLog("memory");

interface ExtractionInput {
  userId: string;
  botName: string;
  userMessage: string;
  assistantResponse: string;
  sourceMessageId?: string;
}

interface ExtractionResult {
  worth_remembering: boolean;
  summary?: string;
  tags?: string[];
  scope?: 'personal' | 'shared';
}

const EXTRACTION_PROMPT = `You are a memory extraction system. Analyze this conversation exchange and decide if it contains information worth remembering for future conversations.

Worth remembering: facts about the user, preferences, decisions, project details, important context, recurring topics, team processes, organizational knowledge.
NOT worth remembering: greetings, thanks, simple factual lookups, small talk.

If worth remembering, also classify the scope:
- "personal": About this specific user — their preferences, projects, schedule, opinions, personal context.
- "shared": General knowledge useful to anyone — company processes, team decisions, technical standards, organizational facts.

Respond with ONLY valid JSON (no markdown fences):
{"worth_remembering": false}
or
{"worth_remembering": true, "summary": "Brief 1-sentence summary", "tags": ["tag1", "tag2"], "scope": "personal"}

User said: """
{USER_MESSAGE}
"""

Assistant replied: """
{ASSISTANT_RESPONSE}
"""`;

export function extractMemoryAsync(input: ExtractionInput, config: Config, traceContext?: TraceContext): void {
  // Fire and forget — don't block the chat response
  doExtract(input, config, traceContext).catch((err) => {
    log.error("Memory extraction failed: {error}", { botName: input.botName, error: err instanceof Error ? err.message : String(err) });
  });
}

async function doExtract(input: ExtractionInput, config: Config, traceContext?: TraceContext): Promise<void> {
  let tracer: Tracer | undefined;
  if (traceContext) {
    tracer = new Tracer("memory_extraction", {
      botName: input.botName,
      userId: input.userId,
      traceId: traceContext.traceId,
      parentId: traceContext.parentId,
    });
  }

  const prompt = EXTRACTION_PROMPT
    .replace("{USER_MESSAGE}", input.userMessage)
    .replace("{ASSISTANT_RESPONSE}", input.assistantResponse);

  const haiku = await spawnHaiku(prompt, "memory", "jarvis-memory", undefined, input.botName);

  let result: ExtractionResult;
  try {
    result = extractJson<ExtractionResult>(haiku.result);
  } catch {
    log.error("Memory extraction: failed to parse result: {raw}", { botName: input.botName, raw: haiku.result.slice(0, 300) });
    tracer?.finish("error", { error: "parse_failed", rawResult: haiku.result.slice(0, 300) });
    return;
  }

  if (!result.worth_remembering || !result.summary || !result.tags) {
    tracer?.finish("ok", { worthRemembering: false });
    return;
  }

  const embedding = await generateEmbedding(result.summary);
  if (!embedding) {
    log.warn("Embedding generation returned null for memory — saving without embedding (will not appear in semantic search)", { botName: input.botName, summary: result.summary });
  }

  await saveMemory({
    userId: input.userId,
    botName: input.botName,
    content: `User: ${input.userMessage}\nAssistant: ${input.assistantResponse}`,
    summary: result.summary,
    tags: result.tags,
    sourceMessageId: input.sourceMessageId,
    embedding,
    scope: result.scope === 'shared' ? 'shared' : 'personal',
  });

  tracer?.finish("ok", {
    worthRemembering: true,
    summary: result.summary,
    tags: result.tags,
    scope: result.scope ?? "personal",
  });
}
