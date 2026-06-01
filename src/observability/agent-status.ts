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

/**
 * Tracks the live progress of in-flight requests.
 *
 * Requests are keyed by `requestId` in a `Map`, so concurrent work (multiple
 * users on one bot, parallel watchers) no longer clobbers a single shared slot
 * — each request accumulates its own tools/phase independently. Every mutating
 * method takes the `requestId` returned by `startRequest()`; an unknown id is a
 * silent no-op (defensive against callbacks that arrive after auto-clear).
 *
 * The read side (`getProgress()` / `subscribeProgress()`) still surfaces a
 * single `RequestProgress | null` — the "primary" (most-recently-started) live
 * request — because the dashboard/chat waterfall is a single-pane view. This
 * keeps the SSE contract and UI untouched while the data layer stays correct
 * under concurrency.
 *
 * The phase-only singleton (`set`/`get`/`subscribe`) is intentionally left
 * global: it's a coarse "what is the bot doing right now" indicator, not
 * per-request waterfall data.
 */
class AgentStatusTracker {
  private current: AgentStatus = { phase: "idle" };
  private subscribers = new Set<StatusSubscriber>();
  private requests = new Map<string, RequestProgress>();
  private progressSubscribers = new Set<ProgressSubscriber>();
  private completionTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    const requestId = `req_${nextRequestId++}`;
    this.requests.set(requestId, {
      requestId,
      botName,
      username,
      phase,
      startedAt: Date.now(),
      tools: [],
    });
    this.notifyProgress();
    return requestId;
  }

  updatePhase(requestId: string, phase: AgentPhase) {
    const req = this.requests.get(requestId);
    if (!req) return;
    req.phase = phase;
    this.notifyProgress();
  }

  setConnectorLabel(requestId: string, label: string) {
    const req = this.requests.get(requestId);
    if (!req) return;
    req.connectorLabel = label;
    this.notifyProgress();
  }

  setModel(requestId: string, model: string) {
    const req = this.requests.get(requestId);
    if (!req) return;
    req.model = model;
    this.notifyProgress();
  }

  toolStart(requestId: string, name: string, displayName: string, input?: string) {
    const req = this.requests.get(requestId);
    if (!req) return;
    req.tools.push({
      name,
      displayName,
      startedAt: Date.now(),
      input,
    });
    this.notifyProgress();
  }

  toolEnd(requestId: string, name: string, displayName: string) {
    const req = this.requests.get(requestId);
    if (!req) return;
    // Find the last matching tool that hasn't ended yet
    for (let i = req.tools.length - 1; i >= 0; i--) {
      const tool = req.tools[i]!;
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
    const req = this.requests.get(requestId);
    if (!req) return;
    req.completed = true;
    req.completedAt = Date.now();
    req.traceId = meta.traceId;
    req.inputTokens = meta.inputTokens;
    req.outputTokens = meta.outputTokens;
    req.numTurns = meta.numTurns;
    req.toolCount = meta.toolCount;
    this.notifyProgress();

    // Auto-clear this request after 30 seconds (user can dismiss earlier via × button)
    const existing = this.completionTimers.get(requestId);
    if (existing) clearTimeout(existing);
    this.completionTimers.set(requestId, setTimeout(() => {
      this.requests.delete(requestId);
      this.completionTimers.delete(requestId);
      this.notifyProgress();
    }, 30_000));
  }

  /** Clear one request (by id) or, with no id, every request — used for reset
   *  and the no-active-request error path. */
  clearRequest(requestId?: string) {
    if (requestId === undefined) {
      for (const timer of this.completionTimers.values()) clearTimeout(timer);
      this.completionTimers.clear();
      this.requests.clear();
      this.notifyProgress();
      return;
    }
    const timer = this.completionTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.completionTimers.delete(requestId);
    }
    this.requests.delete(requestId);
    this.notifyProgress();
  }

  getProgress(): RequestProgress | null {
    return this.primaryRequest();
  }

  subscribeProgress(fn: ProgressSubscriber): () => void {
    this.progressSubscribers.add(fn);
    return () => this.progressSubscribers.delete(fn);
  }

  /** The request the single-pane waterfall should display: the most recently
   *  started request still being tracked (Map preserves insertion order, so the
   *  last entry is the newest). Null when nothing is in flight. */
  private primaryRequest(): RequestProgress | null {
    let primary: RequestProgress | null = null;
    for (const req of this.requests.values()) primary = req;
    return primary;
  }

  private notifyProgress() {
    const snapshot = this.primaryRequest();
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
    case "claude-sdk": return "Claude SDK";
    default: return "Claude Code";
  }
}

/** Set connector label + model on the given request from bot config */
export function setConnectorInfo(requestId: string, botConfig: { connector?: string; model?: string }, fallbackModel?: string) {
  const label = getConnectorLabel(botConfig.connector ?? "claude-cli");
  agentStatus.setConnectorLabel(requestId, label);
  const model = botConfig.model ?? fallbackModel;
  if (model) agentStatus.setModel(requestId, model);
}

/** Create a progress callback that updates the given request with tool details */
export function createProgressCallback(requestId: string, phase: AgentPhase, username?: string): StreamProgressCallback {
  return (event) => {
    if (event.type === "tool_start") {
      agentStatus.set(phase, username, event.displayName);
      agentStatus.toolStart(requestId, event.name, event.displayName, event.input);
    } else if (event.type === "tool_end") {
      agentStatus.set(phase, username);
      agentStatus.toolEnd(requestId, event.name, event.displayName);
    }
  };
}
