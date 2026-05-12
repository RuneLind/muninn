import { CopilotClient, approveAll, type SessionEvent, type SessionConfig, type CustomAgentConfig, type ToolResultObject } from "@github/copilot-sdk";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { ClaudeExecResult } from "../executor.ts";
import type { StreamProgressCallback } from "../stream-parser.ts";
import { formatToolDisplayName, isReportIntentTool, extractIntentText } from "../stream-parser.ts";
import { truncateOutput } from "../truncate-output.ts";
import { processMcpToolResult, peelTraceMarkerForRewrite } from "../huginn-trace-pointer.ts";
import type { CorrectiveToolMeta, ToolCall } from "../../types.ts";
import { parseMcpConfig } from "./copilot-mcp.ts";
import { preflightMcpForRequest } from "../mcp-status.ts";
import { getLog } from "../../logging.ts";
import { resolve } from "node:path";
import { discoverSerenaConfigs } from "../../serena/config.ts";
import { isKnowledgeSearchTool } from "../tool-status.ts";
import { resolveCorrectiveConfig } from "../corrective-config.ts";
import { runCorrectiveRetrieval, type CorrectiveMetadata, type CorrectiveRetrievalContext } from "../corrective-retrieval.ts";

const log = getLog("ai", "copilot-sdk");

// Shared client — started once, stopped on process exit
let client: CopilotClient | null = null;
let clientStarting: Promise<void> | null = null;

async function getClient(): Promise<CopilotClient> {
  if (client) return client;

  if (!clientStarting) {
    clientStarting = (async () => {
      try {
        log.info("Starting Copilot SDK client");
        client = new CopilotClient({ logLevel: "warning" });
        await client.start();

        // Cleanup on process exit
        const cleanup = () => {
          client?.stop().catch(() => {});
          client = null;
          clientStarting = null;
        };
        process.on("beforeExit", cleanup);
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);

        log.info("Copilot SDK client started");
      } catch (e) {
        // Reset so next call can retry startup
        client = null;
        clientStarting = null;
        throw e;
      }
    })();
  }

  await clientStarting;
  return client!;
}

export async function executePrompt(
  prompt: string,
  config: Config,
  botConfig: BotConfig,
  systemPrompt?: string,
  onProgress?: StreamProgressCallback,
): Promise<ClaudeExecResult> {
  const wallStart = performance.now();
  const cl = await getClient();

  const model = botConfig.model ?? config.claudeModel;
  const timeoutMs = botConfig.timeoutMs ?? config.claudeTimeoutMs;

  // Parse .mcp.json for this bot
  const mcpServers = parseMcpConfig(botConfig.dir);
  const hasMcp = Object.keys(mcpServers).length > 0;

  // Pre-flight: warn if a *critical* MCP server is down. Non-critical failures
  // are visible in the inspector panel only — they no longer pollute the chat
  // stream. See src/ai/mcp-status.ts.
  if (hasMcp) {
    await preflightMcpForRequest(botConfig, onProgress);
  }

  // Build custom subagents (e.g. verify-code for grep/diff verification)
  const customAgents = buildCustomAgents(botConfig);

  // Corrective retrieval (CRAG-lite): when enabled for this bot, an onPostToolUse
  // hook judges each knowledge-search result and, if it's weak, does a bounded
  // re-query — splicing the fresh hits into the result before the model sees it.
  // Default judge is `"signal"` (no model call — re-query only when Huginn
  // already flags the result weak, using Huginn's `retryHints`); `"haiku"` is
  // an opt-in slower/smarter alternative. Off by default (see corrective-config.ts);
  // when off, the hook isn't registered and behaviour is byte-identical to before.
  const correctiveCfg = resolveCorrectiveConfig(botConfig);
  const correctiveOutcomes: CorrectiveMetadata[] = [];
  const correctiveEnabled = correctiveCfg.enabled && hasMcp;
  const userQuestion = correctiveEnabled ? extractUserQuestion(prompt) : "";
  const correctiveHooks: SessionConfig["hooks"] | undefined = correctiveEnabled
    ? {
        onPostToolUse: async (input) => {
          if (!isKnowledgeSearchTool(input.toolName)) return;
          try {
            const result = await applyCorrectiveRetrieval({
              toolName: input.toolName,
              toolArgs: input.toolArgs,
              toolResult: input.toolResult,
              botConfig,
              budget: correctiveCfg.retryBudget,
              grader: correctiveCfg.grader,
              userQuestion,
            });
            if (result) {
              correctiveOutcomes.push(result.metadata);
              if (result.modifiedResult) return { modifiedResult: result.modifiedResult };
            }
          } catch (e) {
            log.warn("Corrective retrieval hook failed: {error}", {
              botName: botConfig.name,
              error: e instanceof Error ? e.message : String(e),
            });
          }
          return;
        },
      }
    : undefined;

  // Create session per request (system prompt is dynamic — memories, goals, history change per message)
  const session = await cl.createSession({
    model,
    streaming: true,
    workingDirectory: botConfig.dir,
    systemMessage: systemPrompt
      ? { mode: "replace", content: systemPrompt }
      : undefined,
    onPermissionRequest: approveAll,
    ...(hasMcp ? { mcpServers } : {}),
    ...(customAgents.length > 0 ? { customAgents } : {}),
    ...(botConfig.excludedTools?.length ? { excludedTools: botConfig.excludedTools } : {}),
    ...(correctiveHooks ? { hooks: correctiveHooks } : {}),
  });

  // Track tool calls for waterfall
  const toolCalls: ToolCall[] = [];
  const pendingTools = new Map<string, { name: string; startMs: number; input?: string }>();

  // Track usage from assistant.usage events
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let lastTurnInputTokens = 0;
  let reportedModel = model;
  let turnCount = 0;

  // Wire up streaming events
  const unsubscribe = session.on((event: SessionEvent) => {
    switch (event.type) {
      case "assistant.message_delta":
        onProgress?.({ type: "text_delta", text: event.data.deltaContent });
        break;

      case "assistant.turn_start":
        turnCount++;
        break;

      case "assistant.intent":
        onProgress?.({ type: "intent", text: event.data.intent });
        break;

      case "tool.execution_start": {
        const name = event.data.toolName;
        // Emit intent event from report_intent tool (in addition to waterfall entry)
        if (isReportIntentTool(name)) {
          const intentText = extractIntentText(event.data.arguments);
          if (intentText) onProgress?.({ type: "intent", text: intentText });
        }
        const displayName = formatToolDisplayName(name);
        const startMs = performance.now();
        const input = abbreviateInput(event.data.arguments);
        pendingTools.set(event.data.toolCallId, { name, startMs, input });
        onProgress?.({ type: "tool_start", name, displayName, input });
        break;
      }

      case "tool.execution_complete": {
        const pending = pendingTools.get(event.data.toolCallId);
        if (pending) {
          const endMs = performance.now();
          const displayName = formatToolDisplayName(pending.name);
          // Capture the tool result for trace reproducibility. The SDK exposes
          // `result.content` (short string) and `result.detailedContent` / `contents[]`
          // (structured); we store the richest available form, capped to 16 KB.
          const resultPayload = event.data.success
            ? (event.data.result ?? undefined)
            : { error: event.data.error ?? { message: "tool execution failed" } };

          const processed = processMcpToolResult(resultPayload);
          const truncated = truncateOutput(processed.cleanedText);

          toolCalls.push({
            id: event.data.toolCallId,
            name: pending.name,
            displayName,
            durationMs: Math.round(endMs - pending.startMs),
            startOffsetMs: Math.round(pending.startMs - wallStart),
            input: pending.input,
            output: truncated,
            searchTrace: processed.searchTrace,
            searchTracePointer: processed.searchTracePointer,
            searchTraceFetch: processed.searchTraceFetch,
          });
          pendingTools.delete(event.data.toolCallId);
          onProgress?.({
            type: "tool_end",
            name: pending.name,
            displayName,
            outputSize: truncated ? truncated.length : undefined,
          });
        }
        break;
      }

      case "assistant.usage":
        lastTurnInputTokens = event.data.inputTokens ?? 0;
        totalInputTokens += lastTurnInputTokens;
        totalOutputTokens += event.data.outputTokens ?? 0;
        totalCacheReadTokens += event.data.cacheReadTokens ?? 0;
        totalCacheCreationTokens += event.data.cacheWriteTokens ?? 0;
        if (event.data.model) reportedModel = event.data.model;
        onProgress?.({
          type: "usage_progress",
          inputTokens: lastTurnInputTokens,
          outputTokens: totalOutputTokens,
          model: reportedModel || undefined,
        });
        break;

      case "subagent.started":
        log.info("Subagent started: {agent} ({description})", {
          botName: botConfig.name,
          agent: event.data.agentDisplayName,
          description: event.data.agentDescription,
        });
        onProgress?.({ type: "intent", text: `🔍 ${event.data.agentDisplayName}: ${event.data.agentDescription}` });
        // Track as a tool call for waterfall
        pendingTools.set(event.data.toolCallId, {
          name: `Agent:${event.data.agentName}`,
          startMs: performance.now(),
          input: event.data.agentDescription,
        });
        break;

      case "subagent.completed": {
        const pendingSub = pendingTools.get(event.data.toolCallId);
        if (pendingSub) {
          const endMs = performance.now();
          toolCalls.push({
            id: event.data.toolCallId,
            name: pendingSub.name,
            displayName: event.data.agentDisplayName,
            durationMs: Math.round(endMs - pendingSub.startMs),
            startOffsetMs: Math.round(pendingSub.startMs - wallStart),
            input: pendingSub.input,
          });
          pendingTools.delete(event.data.toolCallId);
        }
        log.info("Subagent completed: {agent}", {
          botName: botConfig.name,
          agent: event.data.agentDisplayName,
        });
        break;
      }

      case "subagent.failed":
        log.error("Subagent failed: {agent} — {error}", {
          botName: botConfig.name,
          agent: event.data.agentDisplayName,
          error: event.data.error,
        });
        pendingTools.delete(event.data.toolCallId);
        break;
    }
  });

  // Send with timeout
  let timeoutTimer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      log.error("Copilot SDK timed out after {timeoutMs}ms", { botName: botConfig.name, timeoutMs });
      session.abort().catch(() => {});
      reject(new Error(`Copilot SDK timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    // SDK timeout is longer so our manual timeout fires first (with session.abort + error).
    // The SDK timeout is a safety net for internal cleanup if our timeout somehow fails.
    const response = await Promise.race([
      session.sendAndWait({ prompt }, timeoutMs + 5000),
      timeoutPromise,
    ]);
    clearTimeout(timeoutTimer!);

    const wallClockMs = performance.now() - wallStart;
    const content = response?.data?.content ?? "";

    // Attach corrective-retrieval metadata to the matching knowledge-search tool
    // calls so the traces waterfall can synthesize knowledge_grade / knowledge_requery
    // spans (onPostToolUse gives no toolCallId, so this matches by tool order).
    if (correctiveOutcomes.length > 0) attachCorrectiveOutcomes(toolCalls, correctiveOutcomes);

    return {
      result: content,
      costUsd: 0, // Copilot SDK doesn't report cost (subscription model)
      durationMs: Math.round(wallClockMs),
      durationApiMs: Math.round(wallClockMs),
      wallClockMs,
      numTurns: Math.max(1, turnCount),
      model: reportedModel,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      contextTokens: lastTurnInputTokens || undefined,
      cacheReadTokens: totalCacheReadTokens || undefined,
      cacheCreationTokens: totalCacheCreationTokens || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  } catch (error) {
    clearTimeout(timeoutTimer!);
    throw error;
  } finally {
    unsubscribe();
    session.destroy().catch((e) => {
      log.warn("Failed to destroy Copilot SDK session: {error}", { error: String(e) });
    });
  }
}

/**
 * Build custom subagents from the bot's serena config.
 * Creates a "verify-code" agent with grep/diff/read tools for verifying
 * claims that Serena alone can't verify (reference-following, file diffing).
 */
export function buildCustomAgents(botConfig: BotConfig): CustomAgentConfig[] {
  // Reuse the shared Serena config discovery (validates name, projectPath, port)
  const botsDir = resolve(botConfig.dir, "..");
  const allConfigs = discoverSerenaConfigs(botsDir);
  const botSerena = allConfigs.find((c) => c.botName === botConfig.name);

  if (!botSerena?.instances.length) return [];

  const projectPaths = botSerena.instances
    .map((s) => `- **${s.displayName}**: \`${s.projectPath}\``)
    .join("\n");

  return [{
    name: "verify-code",
    displayName: "Code Verifier",
    description: "Verify claims about code by grepping for usages, diffing files, and following reference chains. Use this when you need to confirm that a function is actually called from a specific context, compare similar files for differences, or trace call chains.",
    prompt: `You are a code verification agent. Your job is to verify specific claims about code using grep, diff, and file reading. You complement Serena-based code navigation with low-level verification tools.

Available codebases:
${projectPaths}

## Approach
1. **Follow references** — grep for all usages to verify a function is actually called from the claimed context
2. **Diff similar files** — compare files side-by-side to find differences (use \`diff\` or read both and compare)
3. **Verify call chains** — trace actual import/call chains, don't assume from function names alone
4. **Check for inconsistencies** — look for subtle text differences between similar constructs

## Rules
- Use absolute paths
- Be concise — report verified facts, not process descriptions
- If a claim is wrong, state what is actually true
- Use Grep and Bash tools for searching across codebases
- Read files to verify specific details`,
    mcpServers: {}, // No MCP tools — use built-in tools only (Bash, Grep, Read, Glob)
  }];
}

function abbreviateInput(args: unknown): string | undefined {
  if (args == null) return undefined;
  const json = JSON.stringify(args);
  return json.length > 500 ? json.slice(0, 500) + "…" : json;
}

// ── Corrective retrieval (CRAG-lite) helpers ───────────────────────────────

export interface ApplyCorrectiveArgs {
  toolName: string;
  toolArgs: unknown;
  toolResult: ToolResultObject;
  botConfig: Pick<BotConfig, "name" | "dir">;
  budget: number;
  grader?: CorrectiveRetrievalContext["grader"];
  userQuestion: string;
  /** Injectable for tests — forwarded to {@link runCorrectiveRetrieval}. */
  searchFn?: CorrectiveRetrievalContext["searchFn"];
  gradeFn?: CorrectiveRetrievalContext["gradeFn"];
}

/**
 * Run the corrective grade-and-requery pass on a knowledge-search tool result.
 * Returns `null` when there's nothing to act on (empty result, tool error, or a
 * fully uneventful signal-mode check — judged confident, no re-query — which
 * isn't worth a trace span); otherwise returns the `metadata` (for tracing) and,
 * when results were merged in, a `modifiedResult` to hand back to the model. The
 * trailing Huginn trace marker, if any, is peeled off the body before splicing
 * and re-appended after, so downstream trace extraction is unaffected.
 */
export async function applyCorrectiveRetrieval(
  args: ApplyCorrectiveArgs,
): Promise<{ modifiedResult?: ToolResultObject; metadata: CorrectiveMetadata } | null> {
  const { toolResult, toolArgs, botConfig, budget, userQuestion } = args;
  const originalText = toolResult?.textResultForLlm;
  if (typeof originalText !== "string" || originalText.length === 0) return null;
  // Tool errors (server down, bad collection) carry an `error` field — don't
  // grade those; the model handles the error itself.
  if (toolResult.resultType && toolResult.resultType !== "success") return null;

  const { body, remainder } = peelTraceMarkerForRewrite(originalText);

  const argObj = toolArgs && typeof toolArgs === "object" ? (toolArgs as Record<string, unknown>) : {};
  const originalQuery = typeof argObj.query === "string" ? argObj.query.trim() : "";
  const originalCollections = normalizeCollections(argObj.collection);

  const outcome = await runCorrectiveRetrieval({
    question: userQuestion || originalQuery,
    originalQuery,
    originalCollections,
    originalResultText: body,
    budget,
    grader: args.grader,
    botName: botConfig.name,
    cwd: botConfig.dir,
    log,
    graderTimeoutMs: 30_000,
    searchFn: args.searchFn,
    gradeFn: args.gradeFn,
  });

  if (!outcome.changed) {
    // A signal-mode check that found nothing wrong is a free no-op — don't
    // clutter the trace with a span for every confident search. A Haiku-mode
    // check, or any pass that graded something non-"correct", is worth recording.
    const uneventful =
      outcome.metadata.graderMode === "signal" && outcome.metadata.verdicts.every((v) => v === "correct");
    return uneventful ? null : { metadata: outcome.metadata };
  }

  return {
    metadata: outcome.metadata,
    modifiedResult: { ...toolResult, textResultForLlm: outcome.text + remainder },
  };
}

function normalizeCollections(v: unknown): string[] | undefined {
  if (typeof v === "string" && v.trim()) return [v.trim()];
  if (Array.isArray(v)) {
    const arr = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    return arr.length > 0 ? arr : undefined;
  }
  return undefined;
}

/** Pull the current user turn out of the assembled prompt for grading. The
 *  prompt-builder puts history in a `<conversation_history>` block followed by
 *  the current message, so everything after the last close tag is the turn.
 *  Capped so the grader prompt stays cheap. */
export function extractUserQuestion(prompt: string): string {
  const closeTag = "</conversation_history>";
  const idx = prompt.lastIndexOf(closeTag);
  const tail = idx !== -1 ? prompt.slice(idx + closeTag.length) : prompt;
  const trimmed = tail.trim();
  return trimmed.length > 1500 ? trimmed.slice(-1500).trim() : trimmed;
}

/** Attach corrective outcomes to the knowledge-search tool calls in order
 *  (onPostToolUse exposes no toolCallId, so the i-th outcome maps to the i-th
 *  knowledge-search tool call). */
export function attachCorrectiveOutcomes(toolCalls: ToolCall[], outcomes: CorrectiveMetadata[]): void {
  let i = 0;
  for (const tc of toolCalls) {
    if (i >= outcomes.length) break;
    if (!isKnowledgeSearchTool(tc.name)) continue;
    tc.corrective = correctiveMetaToToolMeta(outcomes[i++]!);
  }
}

function correctiveMetaToToolMeta(m: CorrectiveMetadata): CorrectiveToolMeta {
  return {
    retries: m.retries,
    verdicts: m.verdicts,
    reasons: m.reasons,
    queriesTried: m.queriesTried,
    collectionsTried: m.collectionsTried.map((c) => c ?? null),
    finalVerdict: m.finalVerdict,
    graderMode: m.graderMode,
    graderMs: m.graderMs,
    requeryMs: m.requeryMs,
  };
}
