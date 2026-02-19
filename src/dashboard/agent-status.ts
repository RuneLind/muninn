import type { StreamProgressCallback } from "../ai/stream-parser.ts";

export type AgentPhase =
  | "idle"
  | "receiving"
  | "transcribing"
  | "building_prompt"
  | "calling_claude"
  | "saving_response"
  | "sending_telegram"
  | "sending_slack"
  | "synthesizing_voice"
  | "running_task"
  | "checking_goals"
  | "running_watcher";

export interface AgentStatus {
  phase: AgentPhase;
  username?: string;
  detail?: string;
  startedAt?: number;
}

type Subscriber = (status: AgentStatus) => void;

class AgentStatusTracker {
  private current: AgentStatus = { phase: "idle" };
  private subscribers = new Set<Subscriber>();

  set(phase: AgentPhase, username?: string, detail?: string) {
    this.current = {
      phase,
      username,
      detail,
      startedAt: phase === "idle" ? undefined : Date.now(),
    };
    for (const sub of this.subscribers) {
      sub(this.current);
    }
  }

  get(): AgentStatus {
    return this.current;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}

export const agentStatus = new AgentStatusTracker();

/** Create a progress callback that updates agent status with tool details */
export function createProgressCallback(phase: AgentPhase, username?: string): StreamProgressCallback {
  return (event) => {
    if (event.type === "tool_start") {
      agentStatus.set(phase, username, event.displayName);
    } else if (event.type === "tool_end") {
      agentStatus.set(phase, username);
    }
  };
}
