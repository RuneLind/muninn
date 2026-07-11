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
  | "running_watcher"
  // Research (/research + wiki Ask) — mirrors streamResearchAnswer's phases.
  | "searching"
  | "synthesizing"
  // Gardener backlog-drain stages — mirror `BacklogProgress.stage` so the
  // `/agents` card can render "Drain: <stage>". Additive: no existing consumer
  // switches exhaustively on AgentPhase (label maps fall back to the raw value).
  | "assembling"
  | "harvesting"
  | "clustering"
  | "resolving"
  | "drafting";

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

/**
 * The surface an agent run originates from. Every in-flight (or scheduled) AI
 * job in muninn maps to exactly one kind — the `/agents` dashboard groups and
 * sources Recent per kind (see `assembleAgentsOverview`).
 */
export type AgentKind =
  | "chat"
  | "scheduled_task"
  | "watcher"
  | "gardener_drain"
  | "capture"
  | "research"
  | "extractor"
  | "profile";

/**
 * Kinds eligible for the single-pane waterfall (`getProgress`/`subscribeProgress`
 * → the `request_progress` SSE event). Exactly the producers that existed before
 * the AgentRun registry — background kinds surface only via `getAll`/`subscribeAll`.
 */
const WATERFALL_KINDS = new Set<AgentKind | undefined>(["chat", "scheduled_task", "watcher", undefined]);

/** Discrete work counter for runs that expose real progress (n of m). */
export interface RunProgress {
  done: number;
  total: number;
  currentItem?: string;
}

/**
 * One tracked agent run. Formerly `RequestProgress` (kept as an alias for
 * existing consumers). The single-pane waterfall reads a subset of these fields;
 * the `/agents` registry read side (`getAll`/`getRecentCompleted`) reads them
 * all. All new fields are optional and shape-additive — the `request_progress`
 * SSE contract is unchanged.
 */
export interface AgentRun {
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
  // --- AgentRun registry fields (additive, /agents dashboard) ---------------
  /** Origin surface — defaults to `"chat"` at `startRequest`. */
  kind?: AgentKind;
  /** Stable run name (watcher name/type, task title) — ETA identity in PR 3. */
  name?: string;
  /** Discrete work progress where the producer can report it. */
  progress?: RunProgress;
  /** Estimated total duration (ms) — fed by the ETA estimator in PR 3. */
  expectedDurationMs?: number;
  /** Deep link to the surface that owns this run (e.g. `/wiki/gardener`). */
  sourcePage?: string;
  /** Set when a soft-cancel has been requested (gardener drain). */
  cancelRequested?: boolean;
}

/** @deprecated Alias for {@link AgentRun}, kept for existing consumers. */
export type RequestProgress = AgentRun;

type StatusSubscriber = (status: AgentStatus) => void;
type ProgressSubscriber = (progress: AgentRun | null) => void;
type AllSubscriber = (runs: AgentRun[]) => void;

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
/** Cap on tools serialized per run in the `agent_runs` SSE snapshot (keeps the
 *  fan-out payload bounded — a long chat turn can accumulate dozens). */
const SNAPSHOT_TOOLS_CAP = 20;
/** Completed-runs ring size — feeds Recent for kinds with no durable source. */
const COMPLETED_RING_MAX = 50;
/** Minimum interval between `agent_runs` snapshot emissions (throttle). */
const ALL_THROTTLE_MS = 1000;

class AgentStatusTracker {
  private current: AgentStatus = { phase: "idle" };
  private subscribers = new Set<StatusSubscriber>();
  private requests = new Map<string, AgentRun>();
  private progressSubscribers = new Set<ProgressSubscriber>();
  private completionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Registry read side (/agents dashboard).
  private allSubscribers = new Set<AllSubscriber>();
  private completedRing: AgentRun[] = [];
  private allNotifyTimer: ReturnType<typeof setTimeout> | undefined;
  private lastAllNotifyAt = 0;

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

  startRequest(
    botName: string,
    phase: AgentPhase,
    username?: string,
    opts?: { kind?: AgentKind; name?: string },
  ): string {
    const requestId = `req_${nextRequestId++}`;
    this.requests.set(requestId, {
      requestId,
      botName,
      username,
      phase,
      startedAt: Date.now(),
      tools: [],
      kind: opts?.kind ?? "chat",
      ...(opts?.name ? { name: opts.name } : {}),
    });
    this.notifyProgress();
    return requestId;
  }

  /** Set the discrete work progress (n of m + current item) for a run. */
  updateProgress(requestId: string, progress: RunProgress) {
    const req = this.requests.get(requestId);
    if (!req) return;
    req.progress = progress;
    this.notifyProgress();
  }

  /** Set the estimated total duration (ms) for a run (ETA estimator). */
  setExpectedDuration(requestId: string, expectedDurationMs: number) {
    const req = this.requests.get(requestId);
    if (!req) return;
    req.expectedDurationMs = expectedDurationMs;
    this.notifyProgress();
  }

  /** Set the deep-link source page for a run. */
  setSourcePage(requestId: string, sourcePage: string) {
    const req = this.requests.get(requestId);
    if (!req) return;
    req.sourcePage = sourcePage;
    this.notifyProgress();
  }

  /** Mark that a soft-cancel has been requested for a run. */
  setCancelRequested(requestId: string, cancelRequested: boolean) {
    const req = this.requests.get(requestId);
    if (!req) return;
    req.cancelRequested = cancelRequested;
    this.notifyProgress();
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

    // Snapshot into the completed-runs ring — this survives the 30s auto-clear
    // below, so Recent can source kinds that have no durable trace/usage row
    // (gardener drains, capture jobs, research, per-task granularity).
    this.completedRing.push({ ...req });
    if (this.completedRing.length > COMPLETED_RING_MAX) this.completedRing.shift();

    this.notifyProgress();

    // Auto-clear this request after completion (user can dismiss earlier via ×
    // button). Extractors are frequent + short (memory/goals/schedule fire on
    // nearly every turn), so a 30s window piles up dozens of just-finished rows —
    // clear those far sooner. Every other kind keeps the 30s dwell.
    const clearMs = req.kind === "extractor" ? 5_000 : 30_000;
    const existing = this.completionTimers.get(requestId);
    if (existing) clearTimeout(existing);
    this.completionTimers.set(requestId, setTimeout(() => {
      this.requests.delete(requestId);
      this.completionTimers.delete(requestId);
      this.notifyProgress();
    }, clearMs));
  }

  /** Clear one request (by id) or, with no id, every request — used for reset
   *  and the no-active-request error path. */
  clearRequest(requestId?: string) {
    if (requestId === undefined) {
      for (const timer of this.completionTimers.values()) clearTimeout(timer);
      this.completionTimers.clear();
      this.requests.clear();
      // Full reset also drops the completed-runs ring + throttle state so tests
      // (and the reset path) start clean. No production caller passes no id.
      this.completedRing = [];
      if (this.allNotifyTimer) {
        clearTimeout(this.allNotifyTimer);
        this.allNotifyTimer = undefined;
      }
      this.lastAllNotifyAt = 0;
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

  getProgress(): AgentRun | null {
    return this.primaryRequest();
  }

  subscribeProgress(fn: ProgressSubscriber): () => void {
    this.progressSubscribers.add(fn);
    return () => this.progressSubscribers.delete(fn);
  }

  // --- Registry read side (/agents dashboard) -------------------------------

  /** Every tracked run (live + completed-but-not-yet-cleared). The set is tiny;
   *  the `/agents` overview filters non-completed for its `running[]`. */
  getAll(): AgentRun[] {
    return [...this.requests.values()];
  }

  /** The completed-runs ring (last {@link COMPLETED_RING_MAX}), newest last. */
  getRecentCompleted(): AgentRun[] {
    return this.completedRing.map((r) => ({ ...r }));
  }

  /**
   * Subscribe to full-snapshot updates of all runs. Emissions are throttled to
   * ~1/s **in the tracker** (not in subscribers) because the SSE route fans each
   * snapshot to every connected dashboard page. The snapshot caps tools per run
   * at {@link SNAPSHOT_TOOLS_CAP} to bound the payload. The route is responsible
   * for sending an initial snapshot on connect (via `getAll()`).
   */
  subscribeAll(fn: AllSubscriber): () => void {
    this.allSubscribers.add(fn);
    return () => this.allSubscribers.delete(fn);
  }

  /** Serializable snapshot for the `agent_runs` SSE event — tools capped at
   *  {@link SNAPSHOT_TOOLS_CAP}. Public so the SSE route's initial write uses the
   *  same capped shape as the live `subscribeAll` fan-out (not uncapped
   *  `getAll()`). */
  snapshotAll(): AgentRun[] {
    return [...this.requests.values()].map((r) =>
      r.tools.length > SNAPSHOT_TOOLS_CAP
        ? { ...r, tools: r.tools.slice(-SNAPSHOT_TOOLS_CAP) }
        : { ...r },
    );
  }

  /** Throttled fan-out of the all-runs snapshot to `subscribeAll` listeners. */
  private notifyAll(): void {
    if (this.allSubscribers.size === 0) return;
    const now = Date.now();
    const elapsed = now - this.lastAllNotifyAt;
    if (elapsed >= ALL_THROTTLE_MS) {
      this.emitAll();
    } else if (!this.allNotifyTimer) {
      this.allNotifyTimer = setTimeout(() => {
        this.allNotifyTimer = undefined;
        this.emitAll();
      }, ALL_THROTTLE_MS - elapsed);
      // Don't keep the process alive just for a pending throttle flush.
      this.allNotifyTimer.unref?.();
    }
  }

  private emitAll(): void {
    this.lastAllNotifyAt = Date.now();
    const snapshot = this.snapshotAll();
    for (const sub of this.allSubscribers) sub(snapshot);
  }

  /** The request the single-pane waterfall should display: the most recently
   *  started request still being tracked (Map preserves insertion order, so the
   *  last entry is the newest). Null when nothing is in flight.
   *
   *  Only the kinds that populated the waterfall before the AgentRun registry
   *  existed are eligible — background kinds (extractor/research/gardener_drain/
   *  capture/profile) live only in getAll()/subscribeAll(). Without this filter
   *  the post-turn extractors would hijack the primary slot on every chat turn,
   *  masking the completed chat card and cancelling its auto-dismiss. */
  private primaryRequest(): RequestProgress | null {
    let primary: RequestProgress | null = null;
    for (const req of this.requests.values()) {
      if (WATERFALL_KINDS.has(req.kind)) primary = req;
    }
    return primary;
  }

  private notifyProgress() {
    const snapshot = this.primaryRequest();
    for (const sub of this.progressSubscribers) {
      sub(snapshot);
    }
    // Registry read side rides the same mutation points (throttled internally).
    this.notifyAll();
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
