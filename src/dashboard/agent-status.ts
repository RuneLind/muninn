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

export interface ToolProgress {
  name: string;
  displayName: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  input?: string;
}

export interface RequestProgress {
  requestId: string;
  botName: string;
  username?: string;
  phase: AgentPhase;
  connectorLabel?: string;
  model?: string;
  startedAt: number;
  tools: ToolProgress[];
  completed?: boolean;
  completedAt?: number;
  traceId?: string;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  toolCount?: number;
}

type StatusSubscriber = (status: AgentStatus) => void;
type ProgressSubscriber = (progress: RequestProgress | null) => void;

let nextRequestId = 1;

class AgentStatusTracker {
  private current: AgentStatus = { phase: "idle" };
  private subscribers = new Set<StatusSubscriber>();
  private activeRequest: RequestProgress | null = null;
  private progressSubscribers = new Set<ProgressSubscriber>();
  private completionTimer: ReturnType<typeof setTimeout> | null = null;

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

  subscribe(fn: StatusSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  // --- Request Progress ---

  startRequest(botName: string, phase: AgentPhase, username?: string): string {
    // Clear any pending completion timer
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
    const requestId = `req_${nextRequestId++}`;
    this.activeRequest = {
      requestId,
      botName,
      username,
      phase,
      startedAt: Date.now(),
      tools: [],
    };
    this.notifyProgress();
    return requestId;
  }

  updatePhase(phase: AgentPhase) {
    if (this.activeRequest) {
      this.activeRequest.phase = phase;
      this.notifyProgress();
    }
  }

  setConnectorLabel(label: string) {
    if (this.activeRequest) {
      this.activeRequest.connectorLabel = label;
      this.notifyProgress();
    }
  }

  setModel(model: string) {
    if (this.activeRequest) {
      this.activeRequest.model = model;
      this.notifyProgress();
    }
  }

  toolStart(name: string, displayName: string, input?: string) {
    if (!this.activeRequest) return;
    this.activeRequest.tools.push({
      name,
      displayName,
      startedAt: Date.now(),
      input,
    });
    this.notifyProgress();
  }

  toolEnd(name: string, displayName: string) {
    if (!this.activeRequest) return;
    // Find the last matching tool that hasn't ended yet
    for (let i = this.activeRequest.tools.length - 1; i >= 0; i--) {
      const tool = this.activeRequest.tools[i]!;
      if (tool.name === name && !tool.endedAt) {
        tool.endedAt = Date.now();
        tool.durationMs = tool.endedAt - tool.startedAt;
        break;
      }
    }
    this.notifyProgress();
  }

  completeRequest(requestId: string, meta: {
    traceId?: string;
    inputTokens?: number;
    outputTokens?: number;
    numTurns?: number;
    toolCount?: number;
  }) {
    if (!this.activeRequest || this.activeRequest.requestId !== requestId) return;
    this.activeRequest.completed = true;
    this.activeRequest.completedAt = Date.now();
    this.activeRequest.traceId = meta.traceId;
    this.activeRequest.inputTokens = meta.inputTokens;
    this.activeRequest.outputTokens = meta.outputTokens;
    this.activeRequest.numTurns = meta.numTurns;
    this.activeRequest.toolCount = meta.toolCount;
    this.notifyProgress();

    // Auto-clear after 30 seconds (user can dismiss earlier via × button)
    this.completionTimer = setTimeout(() => {
      this.activeRequest = null;
      this.completionTimer = null;
      this.notifyProgress();
    }, 30_000);
  }

  clearRequest() {
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
    this.activeRequest = null;
    this.notifyProgress();
  }

  getProgress(): RequestProgress | null {
    return this.activeRequest;
  }

  subscribeProgress(fn: ProgressSubscriber): () => void {
    this.progressSubscribers.add(fn);
    return () => this.progressSubscribers.delete(fn);
  }

  private notifyProgress() {
    const snapshot = this.activeRequest;
    for (const sub of this.progressSubscribers) {
      sub(snapshot);
    }
  }
}

export const agentStatus = new AgentStatusTracker();

/** Get human-readable connector label from connector type */
export function getConnectorLabel(connectorType: string): string {
  switch (connectorType) {
    case "copilot-sdk": return "Copilot SDK";
    case "openai-compat": return "OpenAI";
    default: return "Claude Code";
  }
}

/** Set connector label + model on the active request from bot config */
export function setConnectorInfo(botConfig: { connector?: string; model?: string }, fallbackModel?: string) {
  const label = getConnectorLabel(botConfig.connector ?? "claude-cli");
  agentStatus.setConnectorLabel(label);
  const model = botConfig.model ?? fallbackModel;
  if (model) agentStatus.setModel(model);
}

/** Create a progress callback that updates agent status with tool details */
export function createProgressCallback(phase: AgentPhase, username?: string): StreamProgressCallback {
  return (event) => {
    if (event.type === "tool_start") {
      agentStatus.set(phase, username, event.displayName);
      agentStatus.toolStart(event.name, event.displayName, event.input);
    } else if (event.type === "tool_end") {
      agentStatus.set(phase, username);
      agentStatus.toolEnd(event.name, event.displayName);
    }
  };
}
