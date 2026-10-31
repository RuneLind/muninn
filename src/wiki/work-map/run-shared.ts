/**
 * The halves of an organize run both kinds share: the model call with its
 * JSON parse, and the stored usage. Here rather than in `run.ts` so the
 * themes builder (`theme-run.ts`) imports no runtime value from `run.ts`.
 */

import { extractJson } from "../../ai/json-extract.ts";
import type { WikiRegistryEntry } from "../registry.ts";
import type { ModelReply, RunOutcomes, WorkMapRunDeps, WorkMapRunResult } from "./run.ts";
import type { WorkMap } from "./schema.ts";
import type { ThemeMap } from "./theme-schema.ts";

/** What a kind's builder hands the shared write tail. */
export interface BuiltMap {
  map: WorkMap | ThemeMap;
  commitMessage: string;
  logDone: () => void;
}

export type Built = BuiltMap | { result: WorkMapRunResult };

/** The model call and its JSON. Marks `progress.modelCalled` before the call,
 *  so a throw after it records `failed`. */
export async function callWorkMapModel(
  entry: WikiRegistryEntry,
  deps: WorkMapRunDeps,
  prompt: string,
  systemPrompt: string,
  signal: AbortSignal | undefined,
  { fail }: RunOutcomes,
  progress: { modelCalled: boolean },
): Promise<{ reply: ModelReply; raw: unknown } | { result: WorkMapRunResult }> {
  if (signal?.aborted) return { result: { outcome: "aborted" } };
  let reply: ModelReply;
  progress.modelCalled = true;
  try {
    reply = await deps.model({
      wiki: entry.name,
      prompt,
      systemPrompt,
      model: deps.config.workMapModel,
      ...(deps.config.workMapEffort ? { effort: deps.config.workMapEffort } : {}),
    });
  } catch (err) {
    if (signal?.aborted) return { result: { outcome: "aborted" } };
    return { result: await fail(`the model call failed: ${err instanceof Error ? err.message : String(err)}`) };
  }
  if (signal?.aborted) return { result: { outcome: "aborted" } };
  try {
    return { reply, raw: extractJson<unknown>(reply.text) };
  } catch {
    return { result: await fail(`the answer was not JSON (${reply.text.length} chars)`) };
  }
}

/** The model call's usage, as both kinds store it. */
export function usageOf(reply: ModelReply): NonNullable<WorkMap["usage"]> {
  return {
    ...(reply.costUsd !== undefined ? { costUsd: reply.costUsd } : {}),
    ...(reply.durationMs !== undefined ? { durationMs: reply.durationMs } : {}),
    ...(reply.inputTokens !== undefined ? { inputTokens: reply.inputTokens } : {}),
    ...(reply.outputTokens !== undefined ? { outputTokens: reply.outputTokens } : {}),
  };
}
