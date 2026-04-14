/**
 * Materialise the DB preconditions processMessage needs (user row, thread row)
 * before invoking it, so saveMessage's FK constraints don't fire mid-cell and
 * so every cell runs with an empty conversation history. See
 * benchmarks/known-bugs.md Bug 9 for the incident that motivated this.
 */

import { ensureUser } from "../db/users.ts";
import { createThread } from "../db/threads.ts";
import { Tracer } from "../tracing/index.ts";
import { getLog } from "../logging.ts";

const log = getLog("benchmarks", "cell-context");

export interface CellContextInput {
  issueKey: string;
  runIndex: number;
  botName: string;
  /**
   * When set, the newly-created Tracer reuses this UUID instead of generating
   * a fresh one. Used by the dashboard live-run view, which pre-allocates the
   * trace ID before spawning the runner subprocess so the live view can
   * subscribe to spans under that ID from the moment the request lands.
   */
  preAllocatedTraceId?: string;
}

export interface CellIdentity {
  userId: string;
  threadId: string;
}

export interface CellContext extends CellIdentity {
  tracer: Tracer;
}

export async function ensureCellIdentity(
  input: CellContextInput,
): Promise<CellIdentity> {
  // Unique per cell so the prompt builder can never pull a prior cell's
  // bot response out of <conversation_history>. Timestamp + runIndex makes
  // collisions impossible; the issue key makes the messages table greppable.
  const userId = `bench-${input.issueKey}-${Date.now()}-r${input.runIndex}`;

  await ensureUser({ id: userId, username: userId, platform: "web" });
  const thread = await createThread(userId, input.botName, "main");

  log.info("cell identity ready — userId={userId} threadId={threadId}", {
    botName: "benchmarks",
    userId,
    threadId: thread.id,
  });

  return { userId, threadId: thread.id };
}

export async function ensureCellContext(
  input: CellContextInput,
): Promise<CellContext> {
  const identity = await ensureCellIdentity(input);
  const tracer = new Tracer("benchmark_analysis", {
    botName: input.botName,
    userId: identity.userId,
    username: identity.userId,
    platform: "web",
    traceId: input.preAllocatedTraceId,
  });
  return { ...identity, tracer };
}
