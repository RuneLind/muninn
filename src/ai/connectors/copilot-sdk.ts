import {
  CopilotClient,
  approveAll,
  type CopilotSession,
  type CustomAgentConfig,
  type PermissionHandler,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { ClaudeExecResult } from "../executor.ts";
import type { StreamProgressCallback } from "../stream-parser.ts";
import { abbreviateInput, formatToolDisplayName, isReportIntentTool, extractIntentText } from "../stream-parser.ts";
import type { ToolCall } from "../../types.ts";
import { recordToolSpan } from "./tool-span.ts";
import { parseMcpConfig } from "./copilot-mcp.ts";
import { resolveCopilotModelId } from "./copilot-model-id.ts";
import { preflightMcpForRequest } from "../mcp-status.ts";
import { getLog } from "../../logging.ts";
import { resolve } from "node:path";
import { discoverSerenaConfigs } from "../../serena/config.ts";
import { currentActiveTurn } from "../../hivemind/active-turn.ts";
import { assertMcpToolsSurface, mcpToolsSurface, refuseFencedSurface, type McpToolsSurface } from "../tool-surface.ts";
import { resolveMcpToolsAgentCwd } from "../agent-cwd.ts";

const log = getLog("ai", "copilot-sdk");

/**
 * Fold one turn's reported input-token count into the running total.
 *
 * Copilot's `assistant.usage.inputTokens` is the *cumulative* context for that
 * turn (system prompt + conversation history + prior tool results), which grows
 * each turn of the agent loop. Summing it across turns double-counts the resent
 * context, so we track the peak instead — the largest turn IS the real total
 * input. Mirrors claude-sdk.ts, which assigns (not accumulates) totalInputTokens.
 */
export function accumulateInputTokens(prevTotal: number, turnTokens: number): number {
  return Math.max(prevTotal, turnTokens);
}

export { resolveCopilotModelId } from "./copilot-model-id.ts";

// bot:model pairs already warned about — avoids repeating the warning every turn.
const warnedModelIds = new Set<string>();

async function resolveModelForRequest(cl: CopilotClient, configured: string, botName: string): Promise<string> {
  let available: string[];
  try {
    available = (await cl.listModels()).map((m) => m.id);
  } catch (e) {
    log.warn("Could not list Copilot models — using configured id {model} as-is: {error}", {
      botName,
      model: configured,
      error: e instanceof Error ? e.message : String(e),
    });
    return configured;
  }
  const resolved = resolveCopilotModelId(configured, available);
  const warnKey = `${botName}:${configured}`;
  if (resolved.mapped && !warnedModelIds.has(warnKey)) {
    warnedModelIds.add(warnKey);
    log.warn("Model {configured} is not a Copilot model id — mapped to {mapped}. Update the config to the dotted id.", {
      botName,
      configured,
      mapped: resolved.id,
    });
  } else if (!resolved.known && !warnedModelIds.has(warnKey)) {
    warnedModelIds.add(warnKey);
    log.error("Model {configured} is not in the Copilot catalog ({available}) — Copilot will silently fall back to its default model", {
      botName,
      configured,
      available: available.join(", "),
    });
  }
  return resolved.id;
}

// Shared client — started once, stopped on process exit
let client: CopilotClient | null = null;
let clientStarting: Promise<void> | null = null;

export async function getCopilotClient(): Promise<CopilotClient> {
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
  refuseFencedSurface("copilot-sdk", botConfig.toolSurface);
  // The turn this call belongs to, CAPTURED HERE rather than read at the point
  // of use. This line runs inside the turn's own async chain, so it is exact;
  // a read from inside a tool-result handler is not, on any connector with a
  // shared long-lived transport (see `research/thread-citations.ts`).
  const activeTurn = currentActiveTurn();
  const wallStart = performance.now();
  const cl = await getCopilotClient();

  const model = await resolveModelForRequest(cl, botConfig.model ?? config.claudeModel, botConfig.name);
  const timeoutMs = botConfig.timeoutMs ?? config.claudeTimeoutMs;

  const named = mcpToolsSurface(botConfig.toolSurface);
  const tools = named ? copilotNamedToolsSession(botConfig, named) : copilotSessionTools(botConfig);

  // Pre-flight: warn if a *critical* MCP server is down. Non-critical failures
  // are visible in the inspector panel only — they no longer pollute the chat
  // stream. See src/ai/mcp-status.ts.
  if (tools.mcpServers) {
    await preflightMcpForRequest(botConfig, onProgress);
  }

  // Create session per request (system prompt is dynamic — memories, goals, history change per message)
  const session = await createCopilotSession(cl, botConfig, model, systemPrompt, tools);
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
        onProgress?.({ type: "tool_start", id: event.data.toolCallId, name, displayName, input });
        break;
      }

      case "tool.execution_complete": {
        const pending = pendingTools.get(event.data.toolCallId);
        if (pending) {
          // Capture the tool result for trace reproducibility. The SDK exposes
          // `result.content` (short string) and `result.detailedContent` / `contents[]`
          // (structured); we store the richest available form, capped to 16 KB.
          const resultPayload = event.data.success
            ? (event.data.result ?? undefined)
            : { error: event.data.error ?? { message: "tool execution failed" } };

          const { toolCall, toolEndEvent } = recordToolSpan({
            id: event.data.toolCallId,
            name: pending.name,
            input: pending.input,
            rawResult: resultPayload,
            startMs: pending.startMs,
            endMs: performance.now(),
            wallStart,
            botName: botConfig.name,
            turn: activeTurn,
          });

          toolCalls.push(toolCall);
          pendingTools.delete(event.data.toolCallId);
          onProgress?.(toolEndEvent);
        }
        break;
      }

      case "assistant.usage":
        lastTurnInputTokens = event.data.inputTokens ?? 0;
        totalInputTokens = accumulateInputTokens(totalInputTokens, lastTurnInputTokens);
        totalOutputTokens += event.data.outputTokens ?? 0;
        // NB asymmetry: inputTokens is the cumulative context (peak — see
        // accumulateInputTokens), but cacheRead/Write are summed on the
        // assumption they are per-turn deltas. If a real trace shows they are
        // also cumulative (each turn re-reading the cached prefix), these should
        // switch to peak too — they'd over-count today. Left additive pending a
        // trace to confirm.
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
    // Sessions are per-request throwaways — delete permanently (disk state
    // included) rather than disconnect(), which keeps them resumable on disk.
    cl.deleteSession(session.sessionId).catch((e: unknown) => {
      // A failed delete leaves the session (and its handler closures) in the
      // singleton client's registry — disconnect releases them, best-effort.
      session.disconnect().catch(() => {});
      log.warn("Failed to delete Copilot SDK session: {error}", { error: String(e) });
    });
  }
}

/**
 * The tool half of `createSession`: MCP servers, custom agents and the exclude
 * list. Under `toolsDisabled` all three sources are excluded by Copilot's
 * source-qualified patterns, which bind whatever Copilot names its built-ins —
 * Claude Code's names in `excludedTools` may match nothing here.
 */
export function copilotSessionTools(botConfig: BotConfig): {
  mcpServers?: ReturnType<typeof parseMcpConfig>;
  customAgents?: CustomAgentConfig[];
  excludedTools?: string[];
} {
  if (botConfig.toolsDisabled) {
    return { excludedTools: [...(botConfig.excludedTools ?? []), "builtin:*", "mcp:*", "custom:*"] };
  }
  const mcpServers = parseMcpConfig(botConfig.dir);
  // Custom subagents (e.g. verify-code for grep/diff verification)
  const customAgents = buildCustomAgents(botConfig);
  return {
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(customAgents.length > 0 ? { customAgents } : {}),
    ...(botConfig.excludedTools?.length ? { excludedTools: botConfig.excludedTools } : {}),
  };
}

/**
 * Create the per-request session. A `{ mcpTools }` surface runs in an empty
 * agent home (so the runtime discovers no CLAUDE.md, AGENTS.md or .github/
 * from the bot folder), approves only its listed tools, and is read back with
 * {@link assertSessionHoldsOnly} before it is returned: a session that holds
 * any other tool is deleted and refused. Exported for the real-API smoke
 * (`scripts/smoke-copilot-mcp-tools.ts`), which inspects the same session.
 */
export async function createCopilotSession(
  cl: CopilotClient,
  botConfig: BotConfig,
  model: string,
  systemPrompt: string | undefined,
  tools: ReturnType<typeof copilotSessionTools> | NamedToolsSessionOptions,
): Promise<CopilotSession> {
  const named = mcpToolsSurface(botConfig.toolSurface);
  const session = await cl.createSession({
    model,
    streaming: true,
    workingDirectory: named ? resolveMcpToolsAgentCwd() : botConfig.dir,
    systemMessage: systemPrompt
      ? { mode: "replace", content: systemPrompt }
      : undefined,
    onPermissionRequest: named ? namedToolsPermissionHandler(named) : approveAll,
    ...tools,
  });
  if (named) {
    try {
      await assertSessionHoldsOnly(session, namedToolWireNames(named));
    } catch (err) {
      cl.deleteSession(session.sessionId).catch(() => session.disconnect().catch(() => {}));
      throw err;
    }
  }
  return session;
}

/** Copilot's wire name for an MCP tool: `<server>-<tool>`, as `ToolSet.addMcp` documents it. */
export function namedToolWireNames(surface: McpToolsSurface): string[] {
  return Object.entries(surface.mcpTools).flatMap(([server, tools]) => tools.map((tool) => `${server}-${tool}`));
}

/** The session options a `{ mcpTools }` surface sets, beside model, prompt and handler. */
export type NamedToolsSessionOptions = Pick<
  SessionConfig,
  | "mcpServers"
  | "availableTools"
  | "excludedTools"
  | "customAgents"
  | "skipCustomInstructions"
  | "enableSkills"
  | "skillDirectories"
  | "enableSessionStore"
  | "memory"
  | "pluginDirectories"
  | "instructionDirectories"
  | "enableConfigDiscovery"
  | "enableOnDemandInstructionDiscovery"
  | "enableFileHooks"
>;

/**
 * The tool half of `createSession` for a `{ mcpTools }` surface: an ALLOW list.
 * Only the named servers start, each filtered to its listed tools; the
 * session's `availableTools` names exactly those tools as `mcp:<server>-<tool>`
 * (source-qualified, so a built-in of the same name never matches);
 * `builtin:*` and `custom:*` are excluded as well, and nothing is discovered
 * from disk: no custom instructions, skills, plugins, file hooks, cross-session
 * store or memory, and no custom agent. Throws when the bot's `.mcp.json` does
 * not hold a named server.
 */
export function copilotNamedToolsSession(botConfig: BotConfig, surface: McpToolsSurface): NamedToolsSessionOptions {
  assertMcpToolsSurface(surface);
  const all = parseMcpConfig(botConfig.dir);
  const mcpServers: Record<string, ReturnType<typeof parseMcpConfig>[string]> = {};
  for (const [server, tools] of Object.entries(surface.mcpTools)) {
    const entry = all[server];
    if (!entry) {
      throw new Error(`copilot-sdk: the { mcpTools } surface names server "${server}", which ${botConfig.name}'s .mcp.json does not hold.`);
    }
    mcpServers[server] = { ...entry, tools: [...tools] };
  }
  return {
    mcpServers,
    availableTools: namedToolWireNames(surface).map((name) => `mcp:${name}`),
    excludedTools: ["builtin:*", "custom:*"],
    customAgents: [],
    skipCustomInstructions: true,
    enableSkills: false,
    skillDirectories: [],
    enableSessionStore: false,
    memory: { enabled: false },
    pluginDirectories: [],
    instructionDirectories: [],
    enableConfigDiscovery: false,
    enableOnDemandInstructionDiscovery: false,
    enableFileHooks: false,
  };
}

/**
 * A `{ mcpTools }` session approves only an MCP call to a listed tool; every
 * other request is rejected. The request names the tool by its wire name
 * (`toolName: "yggdrasil-list_repos"`, measured on the real runtime) and the
 * server separately, so both must match a listed pair.
 */
export function namedToolsPermissionHandler(surface: McpToolsSurface): PermissionHandler {
  return (request) => {
    const tools = request.kind === "mcp" ? surface.mcpTools[request.serverName] : undefined;
    if (request.kind === "mcp" && tools?.some((tool) => `${request.serverName}-${tool}` === request.toolName)) {
      return { kind: "approve-once" };
    }
    return { kind: "reject", feedback: "This session may call only its listed tools." };
  };
}

/**
 * Throw unless the session's initialized tool list is a subset of `allowed`
 * (wire names). The allow list is the fence; this reads back what the runtime
 * actually built, so a runtime that ignored `availableTools` or added a tool
 * of its own is refused before the prompt is sent. Fails closed: a runtime
 * that cannot report its tools refuses the run.
 */
export async function assertSessionHoldsOnly(session: Pick<CopilotSession, "rpc">, allowed: string[]): Promise<string[]> {
  await session.rpc.tools.initializeAndValidate();
  const { tools } = await session.rpc.tools.getCurrentMetadata();
  if (!tools) throw new Error("copilot-sdk: the { mcpTools } session reported no tool list — refusing to run it.");
  const names = tools.map((t) => t.name);
  const extra = names.filter((n) => !allowed.includes(n));
  if (extra.length > 0) {
    throw new Error(`copilot-sdk: the { mcpTools } session holds tools it was not given (${extra.join(", ")}) — refusing to run it.`);
  }
  return names;
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
