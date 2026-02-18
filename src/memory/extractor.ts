import type { Config } from "../config.ts";
import { saveMemory } from "../db/memories.ts";
import { generateEmbedding } from "../ai/embeddings.ts";
import { runHaikuExtraction } from "../ai/haiku-extraction.ts";
import type { TraceContext } from "../tracing/index.ts";
import { getLog } from "../logging.ts";

const log = getLog("memory");

interface ExtractionInput {
  userId: string;
  botName: string;
  botDir?: string;
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

export function extractMemoryAsync(input: ExtractionInput, _config: Config, traceContext?: TraceContext): void {
  const prompt = EXTRACTION_PROMPT
    .replace("{USER_MESSAGE}", input.userMessage)
    .replace("{ASSISTANT_RESPONSE}", input.assistantResponse);

  runHaikuExtraction<ExtractionResult>({
    spanName: "memory_extraction",
    source: "memory",
    entrypoint: "jarvis-memory",
    botName: input.botName,
    userId: input.userId,
    prompt,
    cwd: input.botDir,
    log,
    traceContext,
    onResult: async (result, tracer) => {
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
    },
  });
}
