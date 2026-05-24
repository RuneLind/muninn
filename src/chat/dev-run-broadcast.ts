import type { ChatState } from "./state.ts";
import {
  getDevRunById,
  getDevRunByThreadId,
  listHandoffs,
  type DevRun,
  type DevRunHandoff,
} from "../db/dev-runs.ts";
import { getLog } from "../logging.ts";

const log = getLog("chat", "dev-run-broadcast");

/** Injection seams for tests — default to the real DB queries. */
export interface DevRunBroadcastDeps {
  getRunById?: (id: string) => Promise<DevRun | null>;
  getRunByThreadId?: (threadId: string) => Promise<DevRun | null>;
  listHandoffs?: (runId: string) => Promise<DevRunHandoff[]>;
}

/**
 * Resolve a dev_run (by id or origin thread) + its handoffs and push a `dev_run`
 * ChatEvent to the run's web conversation (Phase 5 live run UI). Used off the
 * inbound-router delivery path after the handoff interpreter rolls a run up, and
 * by the stale-handoff sweep — both background state changes with no active chat
 * turn to carry the update.
 *
 * Best-effort: returns false (never throws) when the run can't be resolved, so a
 * broadcast failure never breaks the caller (inbound delivery / the sweep tick).
 * The client filters by conversationId + the run's threadId.
 */
export async function broadcastDevRun(
  state: ChatState,
  opts: { runId?: string; threadId?: string },
  deps: DevRunBroadcastDeps = {},
): Promise<boolean> {
  const getById = deps.getRunById ?? getDevRunById;
  const getByThread = deps.getRunByThreadId ?? getDevRunByThreadId;
  const listH = deps.listHandoffs ?? listHandoffs;
  try {
    const run = opts.runId
      ? await getById(opts.runId)
      : opts.threadId
        ? await getByThread(opts.threadId)
        : null;
    if (!run) return false;
    const handoffs = await listH(run.id);
    const conversationId = await state.botConversationId(run.userId, run.botName);
    state.publishDevRun(conversationId, run, handoffs);
    return true;
  } catch (err) {
    log.warn("Failed to broadcast dev_run: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
