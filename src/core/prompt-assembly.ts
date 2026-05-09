import type { BotConfig } from "../bots/config.ts";
import type { UserIdentity } from "../types.ts";
import type { Tracer } from "../tracing/index.ts";
import { buildPrompt } from "../ai/prompt-builder.ts";
import type { PromptBuildResult } from "../ai/prompt-builder.ts";
import { savePromptSnapshot } from "../db/prompt-snapshots.ts";
import { getLog } from "../logging.ts";
import { slackPostCapability } from "./response-handler.ts";
import type { LogProps } from "./message-processor.ts";

const log = getLog("core", "prompt-assembly");

export interface AssemblePromptParams {
  text: string;
  userId: string;
  username: string;
  userIdentity?: string | UserIdentity;
  threadId?: string;
  botConfig: BotConfig;
  /** When true, append the Slack channel-posting capability prompt. */
  slackEnabled: boolean;
  channelContext?: string;
  recentChannelMessages?: string[];
  tracer: Tracer;
  logProps: LogProps;
}

export interface AssembledPrompt {
  fullSystemPrompt: string;
  userPrompt: string;
  meta: PromptBuildResult["meta"];
}

/**
 * Build the system + user prompt, append Slack-specific additions, persist a
 * snapshot for offline inspection, and log a summary line. Tracer span
 * management for `prompt_build` is co-located here.
 */
export async function assemblePrompt(params: AssemblePromptParams): Promise<AssembledPrompt> {
  const {
    text, userId, username, userIdentity, threadId, botConfig,
    slackEnabled, channelContext, recentChannelMessages,
    tracer, logProps,
  } = params;

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
  if (slackEnabled) {
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
