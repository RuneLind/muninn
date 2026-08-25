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
  | "drafting"
  // Fact-check phases — Phase 1 claim extraction, then Phase 2 bounded-parallel
  // per-claim web verification. Additive: no consumer switches exhaustively.
  | "extracting_claims"
  | "verifying_claims";

export interface AgentStatus {
  phase: AgentPhase;
  /** Display label — a person's name on a chat turn, but a goal/task/watcher
   *  TITLE on the background paths. Never an identity; see `userId`. */
  username?: string;
  detail?: string;
  startedAt?: number;
  /**
   * Owner of the turn this phase describes, when there is one.
   *
   * The phase indicator used to be one process-wide slot and the source said so
   * ("intentionally left global") — with two people on one instance, A's chat
   * page rendered B's phase. `userId` is what a viewer-scoped subscriber filters
   * on; a background run (watcher, scheduled task, goal) legitimately has none
   * and is therefore visible only to the unscoped operator subscribers.
   */
  userId?: string;
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
  | "digest"
  | "factcheck"
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
  /** Display label only — see {@link AgentStatus.username}. */
  username?: string;
  /**
   * Owner of this run. Additive and optional: background kinds (watcher,
   * scheduled task, gardener drain, capture, …) have no user, and the operator
   * surfaces (`getAll`/`snapshotAll`/`subscribeAll` → `/agents`) never filter on
   * it. It exists so the single-pane waterfall can be scoped to ONE viewer —
   * `getProgress(viewer)` / `subscribeProgress(fn, viewer)`.
   */
  userId?: string;
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
  /** Cost of this run in USD. `undefined` ⇒ unknown (direct-SDK Haiku backends
   *  leave it unset); an explicit `0` is a real value (subscription connectors). */
  costUsd?: number;
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
 * **The filter is a parameter of the SUBSCRIBER, never a global.** Both read
 * sides take an optional viewer id: `getProgress(viewer)`/`subscribeProgress(fn,
 * viewer)` and `get(viewer)`/`subscribe(fn, viewer)` return only runs owned by
 * that user, while omitting it keeps the unfiltered operator view the dashboard
 * and `/agents` are built on. Filtering globally instead would leave every shape
 * test green while emptying the operator's page — the registry read side
 * (`getAll`/`snapshotAll`/`subscribeAll`) is deliberately not filterable at all.
 *
 * The phase-only surface (`set`/`get`/`subscribe`) used to be a genuine
 * singleton, and the comment here said it was intentional. It is not defensible
 * with two people on one instance: the shared pipeline sets it with whoever is
 * being processed, and every chat page rendered it. It is now a per-user map
 * (`userId` on the set call) with the global slot kept for the operator and for
 * the background paths that legitimately have no user. A `set` carrying a
 * `userId` notifies only the unscoped subscribers and that user's own;
 * a `set` without one notifies only the unscoped subscribers.
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
  /** Per-user phase, for viewer-scoped subscribers. An entry is DELETED when
   *  that user goes idle, so the map is bounded by concurrently-active users. */
  private userStatus = new Map<string, AgentStatus>();
  /** Subscriber → the viewer it is scoped to (`undefined` = unscoped/operator). */
  private subscribers = new Map<StatusSubscriber, string | undefined>();
  private requests = new Map<string, AgentRun>();
  private progressSubscribers = new Map<ProgressSubscriber, string | undefined>();
  private completionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Registry read side (/agents dashboard).
  private allSubscribers = new Set<AllSubscriber>();
  private completedRing: AgentRun[] = [];
  private allNotifyTimer: ReturnType<typeof setTimeout> | undefined;
  private lastAllNotifyAt = 0;

  /**
   * Set the coarse phase indicator.
   *
   * `opts.userId` is what makes this per-user rather than global — every chat
   * path passes it, INCLUDING the terminal `set("idle", …)`, because without
   * that clear the owner's pill would stay lit on their last phase forever.
   */
  set(phase: AgentPhase, username?: string, detail?: string, opts?: { userId?: string }) {
    const status: AgentStatus = {
      phase,
      username,
      detail,
      startedAt: phase === "idle" ? undefined : Date.now(),
      ...(opts?.userId ? { userId: opts.userId } : {}),
    };
    this.current = status;
    const userId = opts?.userId;
    if (userId) {
      if (phase === "idle") this.userStatus.delete(userId);
      else this.userStatus.set(userId, status);
    }
    for (const [sub, viewer] of this.subscribers) {
      // Unscoped subscribers see everything (the operator dashboard). A scoped
      // one hears only about its own user — not even an idle frame for someone
      // else's turn, which would be pure noise on the wire.
      if (viewer === undefined) sub(status);
      else if (viewer === userId) sub(this.statusFor(viewer));
    }
  }

  /**
   * The phase to show a viewer. With no viewer this is the process-wide slot
   * (operator view); with one it is that user's own phase, or idle.
   */
  get(viewer?: string): AgentStatus {
    return this.statusFor(viewer);
  }

  subscribe(fn: StatusSubscriber, viewer?: string): () => void {
    this.subscribers.set(fn, viewer);
    return () => this.subscribers.delete(fn);
  }

  private statusFor(viewer?: string): AgentStatus {
    if (viewer === undefined) return this.current;
    return this.userStatus.get(viewer) ?? { phase: "idle" };
  }

  // --- Request Progress ---

  startRequest(
    botName: string,
    phase: AgentPhase,
    username?: string,
    opts?: { kind?: AgentKind; name?: string; userId?: string },
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
      ...(opts?.userId ? { userId: opts.userId } : {}),
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

  /** Late-bind the bot that actually ran this job. The capture verticals start
   *  their run at `createJob` (route level, before the summarizer bot is
   *  resolved), so their card would otherwise carry an empty bot chip. */
  setBotName(requestId: string, botName: string) {
    const req = this.requests.get(requestId);
    if (!req) return;
    req.botName = botName;
    this.notifyProgress();
  }

  /** Live token counts (from `usage_progress` stream events) so a Running card
   *  shows growing in/out tokens before the run completes. `completeRequest`
   *  overwrites these with the final totals. */
  updateUsage(requestId: string, usage: { inputTokens: number; outputTokens: number }) {
    const req = this.requests.get(requestId);
    if (!req) return;
    req.inputTokens = usage.inputTokens;
    req.outputTokens = usage.outputTokens;
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
    costUsd?: number;
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
    req.costUsd = meta.costUsd;

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
      this.userStatus.clear();
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

  /** The waterfall a viewer should see. Omit `viewer` for the unfiltered
   *  operator view; pass one to get only that user's runs. */
  getProgress(viewer?: string): AgentRun | null {
    return this.primaryRequest(viewer);
  }

  subscribeProgress(fn: ProgressSubscriber, viewer?: string): () => void {
    this.progressSubscribers.set(fn, viewer);
    return () => this.progressSubscribers.delete(fn);
  }

  /** Set the phase for the OWNER of a run, resolved from the run itself. Lets
   *  the streaming progress callback stay per-user without threading a userId
   *  through every connector callback signature. */
  setForRequest(requestId: string, phase: AgentPhase, detail?: string): void {
    const req = this.requests.get(requestId);
    if (!req) return;
    this.set(phase, req.username, detail, req.userId ? { userId: req.userId } : undefined);
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
  private primaryRequest(viewer?: string): RequestProgress | null {
    let primary: RequestProgress | null = null;
    for (const req of this.requests.values()) {
      if (!WATERFALL_KINDS.has(req.kind)) continue;
      // A viewer sees only their own runs. Note this also drops the watcher and
      // scheduled-task runs a chat page used to render as its own waterfall —
      // those have no owner, and showing someone else's background job as
      // "your request" was the same defect in a quieter form.
      if (viewer !== undefined && req.userId !== viewer) continue;
      primary = req;
    }
    return primary;
  }

  private notifyProgress() {
    for (const [sub, viewer] of this.progressSubscribers) {
      sub(this.primaryRequest(viewer));
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

/**
 * Create a progress callback that updates the given request with tool details.
 *
 * The display name comes off the run (`setForRequest`) rather than a `username`
 * argument, so there is nothing left for callers to pass — the third parameter
 * was removed rather than left inert.
 */
export function createProgressCallback(requestId: string, phase: AgentPhase): StreamProgressCallback {
  return (event) => {
    if (event.type === "tool_start") {
      // setForRequest, not set: the phase indicator is per-user now and the run
      // is the only thing here that knows whose turn this is (`username` is a
      // display label, not an id).
      agentStatus.setForRequest(requestId, phase, event.displayName);
      agentStatus.toolStart(requestId, event.name, event.displayName, event.input);
    } else if (event.type === "tool_end") {
      agentStatus.setForRequest(requestId, phase);
      agentStatus.toolEnd(requestId, event.name, event.displayName);
    } else if (event.type === "usage_progress") {
      // Live in/out tokens for the Running card. Per-call cumulative (a new
      // StreamParser per spawnHaiku), so a multi-call checker shows the current
      // call's tokens live; completeRequest sets the true summed totals.
      agentStatus.updateUsage(requestId, {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      });
    }
  };
}
