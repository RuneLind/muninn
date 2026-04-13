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
}

export interface CellContext {
  userId: string;
  threadId: string;
  tracer: Tracer;
}

export async function ensureCellContext(
  input: CellContextInput,
): Promise<CellContext> {
  // Unique per cell so the prompt builder can never pull a prior cell's
  // bot response out of <conversation_history>. Timestamp + runIndex makes
  // collisions impossible; the issue key makes the messages table greppable.
  const userId = `bench-${input.issueKey}-${Date.now()}-r${input.runIndex}`;

  await ensureUser({ id: userId, username: userId, platform: "web" });
  const thread = await createThread(userId, input.botName, "main");
  const tracer = new Tracer("benchmark_analysis", {
    botName: input.botName,
    userId,
    username: userId,
    platform: "web",
  });

  log.info(
    "cell context ready — userId={userId} threadId={threadId} traceId={traceId}",
    {
      botName: "benchmarks",
      userId,
      threadId: thread.id,
      traceId: tracer.traceId,
    },
  );

  return { userId, threadId: thread.id, tracer };
}
