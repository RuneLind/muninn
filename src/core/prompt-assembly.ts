import type { BotConfig } from "../bots/config.ts";
import type { UserIdentity } from "../types.ts";
import type { Tracer } from "../tracing/index.ts";
import { buildPrompt } from "../ai/prompt-builder.ts";
import type { PromptBuildResult } from "../ai/prompt-builder.ts";
import { savePromptSnapshot } from "../db/prompt-snapshots.ts";
import { agentStatus } from "../dashboard/agent-status.ts";
import { getLog } from "../logging.ts";
import { slackPostCapability } from "./response-handler.ts";

const log = getLog("core", "prompt-assembly");

export interface AssemblePromptParams {
  text: string;
  userId: string;
  username: string;
  userIdentity?: string | UserIdentity;
  threadId?: string;
  botConfig: BotConfig;
  /** Slack-only — when present, append the channel-posting capability prompt. */
  postToChannel?: unknown;
  channelContext?: string;
  recentChannelMessages?: string[];
  tracer: Tracer;
  /** Log properties (botName/userId/username/platform) carried from the orchestrator. */
  logProps: Record<string, unknown>;
}

export interface AssembledPrompt {
  fullSystemPrompt: string;
  userPrompt: string;
  meta: PromptBuildResult["meta"];
}

/**
 * Build the system + user prompt, append Slack-specific additions, persist a
 * snapshot for offline inspection, and log a summary line.
 *
 * Tracer span management is co-located so callers see one call instead of the
 * `start("prompt_build") → buildPrompt → end → mutate` dance the orchestrator
 * used to inline.
 */
export async function assemblePrompt(params: AssemblePromptParams): Promise<AssembledPrompt> {
  const {
    text, userId, username, userIdentity, threadId, botConfig,
    postToChannel, channelContext, recentChannelMessages,
    tracer, logProps,
  } = params;

  agentStatus.set("building_prompt", username);
  agentStatus.updatePhase("building_prompt");
  tracer.start("prompt_build");
  const { systemPrompt, userPrompt, meta } = await buildPrompt({
    userId,
    currentMessage: text,
    persona: botConfig.persona,
    botName: botConfig.name,
    restrictedTools: botConfig.restrictedTools,
    userIdentity: userIdentity ?? username,
    threadId,
  });
  tracer.end("prompt_build", meta);

  let fullSystemPrompt = systemPrompt;
  if (postToChannel) {
    fullSystemPrompt += slackPostCapability(channelContext);
  }
  if (recentChannelMessages && recentChannelMessages.length > 0) {
    fullSystemPrompt += `\n\n## Channel Context\nRecent messages in the channel/thread (for context):\n${recentChannelMessages.join("\n")}`;
  }

  savePromptSnapshot({ traceId: tracer.traceId, systemPrompt: fullSystemPrompt, userPrompt }).catch(() => {});
  log.info("Prompt built in {ms}ms ({msgCount} msgs, {memCount} memories)", {
    ...logProps,
    ms: Math.round(tracer.summary().prompt_build ?? 0),
    msgCount: meta.messagesCount,
    memCount: meta.memoriesCount,
  });

  return { fullSystemPrompt, userPrompt, meta };
}
