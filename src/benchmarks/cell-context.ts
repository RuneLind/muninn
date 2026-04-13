/**
 * Cell context setup for benchmark runs.
 *
 * Every benchmark cell that calls processMessage has implicit database
 * preconditions: the `users.id` must exist (FK from messages), and the
 * `threads.id` must exist (FK from messages.thread_id). If either is
 * missing, saveMessage throws a foreign-key violation mid-run, the cell
 * is wasted, and the failure surfaces as a cryptic SQL error instead of
 * a setup problem.
 *
 * Historical context — the bugs this helper guards against:
 *
 *   Bug 9 (history bleed): the runner used to share userId "benchmark-runner"
 *   across cells. Each cell's bot response landed in the messages table,
 *   then got pulled into the next cell's prompt as <conversation_history>.
 *   The next cell then paraphrased its predecessor instead of doing fresh
 *   analysis. Fixed by per-cell unique userId + fresh threadId.
 *
 *   FK follow-on: the first attempted fix for Bug 9 generated a random UUID
 *   for cellThreadId without materialising the threads row. saveMessage
 *   fired "violates foreign key constraint messages_thread_id_fkey".
 *   Fixed by calling ensureUser + createThread before processMessage.
 *
 * Lesson (credit: huginn peer agent): "a function with implicit DB
 * preconditions that only fail when called in a new context" is a bug
 * shape that stays hidden until the next code path reaches into it. The
 * defense is to extract the preconditions into an idempotent helper with
 * an explicit contract, so every future call site gets the setup for free.
 * See benchmarks/known-bugs.md Bug 9 for the full incident.
 */

import { ensureUser } from "../db/users.ts";
import { createThread } from "../db/threads.ts";
import { Tracer } from "../tracing/index.ts";
import { getLog } from "../logging.ts";

const log = getLog("benchmarks", "cell-context");

export interface CellContextInput {
  /** Issue key for the cell (e.g. "MELOSYS-7588") */
  issueKey: string;
  /** Which run this is within an n-runs loop (used for uniqueness + traceability) */
  runIndex: number;
  /** The bot whose persona/dir the cell runs against */
  botName: string;
  /** The treatment's connector, used for span attribution */
  connector: string;
}

export interface CellContext {
  /** Unique per-cell userId. Format: bench-<issue>-<timestamp>-r<index> */
  userId: string;
  /** Fresh per-cell thread id. Materialised as a row in the threads table. */
  threadId: string;
  /** Pre-created tracer so the runner owns the analysis trace_id from the start. */
  tracer: Tracer;
  /** Convenience: tracer.traceId for the runner to pass to saveBenchmarkRun. */
  traceId: string;
}

/**
 * Create a fresh cell execution context. Idempotency isn't meaningful for
 * this function — every call returns a NEW userId and a NEW thread by
 * construction. The helper's job is to guarantee every piece of state
 * processMessage needs exists in the DB before the call fires.
 *
 * Call this exactly once per (cell, run) pair, before invoking processMessage.
 * The returned object contains everything the runner needs to plumb the cell
 * through to completion.
 */
export async function ensureCellContext(
  input: CellContextInput,
): Promise<CellContext> {
  // userId encodes issue + timestamp + run index. The timestamp provides
  // uniqueness (two benchmark sessions on the same day can't collide) and
  // the issue key makes debug-by-greping-the-messages-table viable.
  const userId = `bench-${input.issueKey}-${Date.now()}-r${input.runIndex}`;

  // Step 1: user row. Must exist before createThread (threads.user_id FK)
  // and before saveMessage (messages.user_id FK).
  await ensureUser({
    id: userId,
    username: userId,
    platform: "web",
  });

  // Step 2: thread row. Must exist before saveMessage (messages.thread_id FK).
  // Using "main" as the thread name is fine because each cell has a unique
  // userId — no two cells ever share a (userId, botName, name) tuple, so
  // there's no collision risk with the existing createThread upsert.
  const thread = await createThread(userId, input.botName, "main");

  // Step 3: tracer. Pre-created so the analysis trace_id is known before
  // the runner writes the benchmark_runs row, letting the row carry the
  // trace_id from the start (no post-hoc linking needed).
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

  return {
    userId,
    threadId: thread.id,
    tracer,
    traceId: tracer.traceId,
  };
}
