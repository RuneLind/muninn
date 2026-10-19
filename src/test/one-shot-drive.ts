/**
 * Drive a one-shot through the TOP layer, `runCaptureOneShot` → `tracedOneShot`
 * → `executeOneShot` → the bot's real connector, so a field dropped anywhere on
 * the way down shows up in what the connector receives. No trace is written
 * (a recording tracer, `tracingEnabled: false`) and no takeaway check runs.
 */

import { runCaptureOneShot } from "../summaries/summarizer-shared.ts";
import type { Tracer } from "../tracing/tracer.ts";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import type { ToolSurface } from "../ai/tool-surface.ts";

export function silentTracer(): Tracer {
  return {
    traceId: crypto.randomUUID(),
    start: () => "span",
    end: () => 1,
    finish: () => {},
    event: () => {},
    annotate: () => {},
    addChildSpan: () => "child",
    addSubSpan: () => "sub",
  } as unknown as Tracer;
}

export const driveConfig = {
  claudeModel: "claude-sonnet-4-5",
  claudeTimeoutMs: 30_000,
  tracingEnabled: false,
  tracingCaptureToolOutputs: false,
} as unknown as Config;

export function driveBot(dir: string, over: Partial<BotConfig> = {}): BotConfig {
  return {
    name: "surfacebot",
    dir,
    persona: "",
    telegramAllowedUserIds: [],
    slackAllowedUserIds: [],
    ...over,
  };
}

export function driveCapture(
  botConfig: BotConfig,
  toolSurface: ToolSurface,
  over: { extraDirs?: string[]; prompt?: string } = {},
): Promise<ClaudeExecResult> {
  return runCaptureOneShot({
    source: "youtube",
    jobId: "job-surface",
    title: "t",
    url: "https://example.test/v",
    prompt: over.prompt ?? "summarize this",
    systemPrompt: "sys",
    config: driveConfig,
    botConfig,
    attachRun: () => {},
    tracer: silentTracer(),
    takeawayCheck: false,
    toolSurface,
    ...(over.extraDirs ? { extraDirs: over.extraDirs } : {}),
  });
}
