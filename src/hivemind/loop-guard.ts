import { countMessagesByRoleInWindow } from "../db/messages.ts";

export interface LoopGuardDecision {
  /** True when the autorespond turn may proceed. */
  allowed: boolean;
  /** Human-readable reason — either why we're blocking, or null when allowed. */
  reason?: string;
  /** True when the cap was hit on this call (caller should persist auto_respond_paused=true). */
  capHit?: boolean;
}

export interface LoopGuardInput {
  threadId: string;
  /** From DB — set by manual toggle or a previous cap-hit auto-pause. */
  alreadyPaused: boolean;
  maxTurnsPerHour: number;
}

/**
 * Decide whether an inbound peer message may trigger an autonomous bot turn.
 *
 * Two signals:
 *  - `alreadyPaused`: respect a manual or previously-tripped pause.
 *  - rolling-hour count of `assistant` messages in the peer thread vs `maxTurnsPerHour`.
 *
 * On cap hit we return `capHit: true` so the caller can flip the
 * `auto_respond_paused` flag and persist the reason — keeping the DB write
 * outside the guard makes it composable with the router's tracer/parallel work.
 */
export async function checkAutoRespond(input: LoopGuardInput): Promise<LoopGuardDecision> {
  if (input.alreadyPaused) {
    return { allowed: false, reason: "thread is paused" };
  }

  const recentTurns = await countMessagesByRoleInWindow(input.threadId, "assistant", 1);

  if (recentTurns >= input.maxTurnsPerHour) {
    return {
      allowed: false,
      reason: `${input.maxTurnsPerHour}-turn/hour cap`,
      capHit: true,
    };
  }

  return { allowed: true };
}
