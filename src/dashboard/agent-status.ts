export type AgentPhase =
  | "idle"
  | "receiving"
  | "transcribing"
  | "building_prompt"
  | "calling_claude"
  | "saving_response"
  | "sending_telegram"
  | "synthesizing_voice";

export interface AgentStatus {
  phase: AgentPhase;
  username?: string;
  startedAt?: number;
}

type Subscriber = (status: AgentStatus) => void;

class AgentStatusTracker {
  private current: AgentStatus = { phase: "idle" };
  private subscribers = new Set<Subscriber>();

  set(phase: AgentPhase, username?: string) {
    this.current = {
      phase,
      username,
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
