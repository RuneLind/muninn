import { getLog } from "../logging.ts";
import { agentStatus } from "../observability/agent-status.ts";

// Generic in-memory job store shared by the capture verticals (youtube,
// x-article, tiktok, anthropic, article). Each vertical's `state.ts` instantiates this
// with its own status union + identity fields and re-exports a vertical-typed
// API, so routes/summarizers keep importing from `<vertical>/state.ts` unchanged.

// --- Shared types ---

export interface SimilarArticle {
  title: string;
  url: string;
  snippet?: string;
  relevance?: number;
  id?: string;
}

// The `complete` event carries an optional `summary`. Only TikTok populates it
// (see `completeReplacesText` below) — for the other verticals the key is
// simply absent at runtime, matching their original `{ type: "complete" }`.
export type JobEvent<S extends string> =
  | { type: "status"; status: S }
  | { type: "text_delta"; text: string }
  | { type: "category"; category: string }
  | { type: "similar"; articles: SimilarArticle[] }
  | { type: "complete"; summary?: string }
  | { type: "error"; message: string };

/** Fields every capture-vertical job shares. `F` adds the vertical-specific
 *  identity fields (videoId, articleId+author, candidateId, docId, …). */
export interface BaseJob<S extends string> {
  id: string;
  title: string;
  url: string;
  status: S;
  createdAt: number;
  /** Accumulated streaming text from Claude */
  text: string;
  category?: string;
  summary?: string;
  error?: string;
  similar?: SimilarArticle[];
}

export type Job<S extends string, F> = BaseJob<S> & F;

type JobSubscriber<S extends string> = (event: JobEvent<S>) => void;

/**
 * The two terminal states every capture-vertical job store settles into
 * (`completeJob` → "complete", `failJob` → "error"). Centralized so the SSE
 * route plumbing doesn't hardcode the set per vertical. Accepts a plain string
 * so it works on both a job `status` and a `JobEvent["type"]` — they share the
 * "complete"/"error" tokens.
 */
export function isTerminalStatus(value: string): boolean {
  return value === "complete" || value === "error";
}

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface JobStoreOptions<S extends string> {
  /** LogTape subsystem, e.g. "youtube" — category ["muninn", <subsystem>, "state"]. */
  subsystem: string;
  /** Human label for completeJob/failJob log lines, e.g. "YouTube", "TikTok". */
  label: string;
  /** Status a freshly created job starts in (every vertical uses "pending"). */
  initialStatus: S;
  /**
   * TikTok-only: on completeJob, overwrite `job.text` with the clean parsed
   * summary and ship that summary on the `complete` event. TikTok's summarize
   * is a multi-turn frame-reading session, so the accumulated text stream
   * carries inter-turn "let me read frame N" chatter. Replacing it means an SSE
   * *replay* of `job.text` shows only the summary; the summary on the `complete`
   * event lets a *live* browser (which already accumulated the chatter) swap it
   * out. For the other verticals `completeJob` leaves `job.text` untouched and
   * publishes a bare `{ type: "complete" }`.
   */
  completeReplacesText?: boolean;
  /** Overridable only for tests — production always uses the module defaults. */
  ttlMs?: number;
  /** Overridable only for tests — production always uses the module defaults. */
  cleanupIntervalMs?: number;
}

/** Run telemetry that can only be known once the model call settles — parked
 *  until the job's terminal transition, then handed to `completeRequest`. */
interface CompletedRunMeta {
  traceId?: string;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  toolCount?: number;
  costUsd?: number;
}

/** Telemetry late-bound onto a job's `/agents` run by `attachRun`. The first
 *  three are live (pushed onto the in-flight card); the rest ride
 *  {@link CompletedRunMeta} to completion. */
export interface RunMeta extends CompletedRunMeta {
  botName?: string;
  model?: string;
  connectorLabel?: string;
}

export interface JobStore<S extends string, F> {
  createJob(fields: F & { title: string; url: string }): string;
  /** Late-bind bot/model/trace/token telemetry onto the job's `/agents` run.
   *  Unknown jobId (or a job whose run already completed) is a silent no-op. */
  attachRun(jobId: string, meta: RunMeta): void;
  getJob(jobId: string): Job<S, F> | undefined;
  getRecentJobs(limit?: number): Job<S, F>[];
  updateStatus(jobId: string, status: S): void;
  appendText(jobId: string, text: string): void;
  setCategory(jobId: string, category: string): void;
  setSimilar(jobId: string, articles: SimilarArticle[]): void;
  completeJob(jobId: string, summary: string, category: string): void;
  failJob(jobId: string, error: string): void;
  subscribe(jobId: string, fn: JobSubscriber<S>): () => void;
}

export function createJobStore<S extends string, F>(
  opts: JobStoreOptions<S>,
): JobStore<S, F> {
  const log = getLog(opts.subsystem, "state");

  // --- State ---
  const jobs = new Map<string, Job<S, F>>();
  const subscribers = new Map<string, Set<JobSubscriber<S>>>();

  // AgentRun registry mirror (/agents dashboard). One hook in the shared factory
  // covers all the capture verticals (youtube / x-article / tiktok / anthropic / article):
  // createJob → startRequest(kind "capture"), the terminal completeJob/failJob →
  // completeRequest. `jobRuns` maps jobId → requestId for the completion lookup.
  // `opts.label` is the vertical name shown in the run name.
  //
  // The run starts at createJob — route level, BEFORE the summarizer bot is
  // resolved and before the model call — so bot/model/trace/tokens can't be known
  // yet. `attachRun` late-binds them once the summarizer has them (see
  // `runCaptureOneShot`): the live fields (bot/model/connector) are pushed
  // straight onto the run so the Running card is truthful mid-flight, while the
  // completion-only fields (traceId + token totals) are parked in `jobRunMeta`
  // and handed to `completeRequest` at the terminal transition — that snapshot is
  // what lands in the completed-runs ring, i.e. what `/agents` Recent shows.
  const jobRuns = new Map<string, string>();
  const jobRunMeta = new Map<string, CompletedRunMeta>();

  /** Short, single-line run name: "YouTube: <title-or-url>", capped for the card. */
  function runName(fields: { title?: string; url: string }): string {
    const subject = (fields.title || fields.url || "").trim();
    const short = subject.length > 60 ? `${subject.slice(0, 57)}…` : subject;
    return short ? `${opts.label}: ${short}` : opts.label;
  }

  function attachRun(jobId: string, meta: RunMeta): void {
    const reqId = jobRuns.get(jobId);
    if (!reqId) return;
    if (meta.botName) agentStatus.setBotName(reqId, meta.botName);
    if (meta.connectorLabel) agentStatus.setConnectorLabel(reqId, meta.connectorLabel);
    if (meta.model) agentStatus.setModel(reqId, meta.model);

    const { traceId, inputTokens, outputTokens, numTurns, toolCount, costUsd } = meta;
    if (
      traceId !== undefined || inputTokens !== undefined || outputTokens !== undefined ||
      numTurns !== undefined || toolCount !== undefined || costUsd !== undefined
    ) {
      jobRunMeta.set(jobId, {
        ...jobRunMeta.get(jobId),
        ...(traceId !== undefined ? { traceId } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(numTurns !== undefined ? { numTurns } : {}),
        ...(toolCount !== undefined ? { toolCount } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      });
    }
  }

  function completeRun(jobId: string): void {
    const reqId = jobRuns.get(jobId);
    if (!reqId) return;
    jobRuns.delete(jobId);
    const meta = jobRunMeta.get(jobId) ?? {};
    jobRunMeta.delete(jobId);
    agentStatus.completeRequest(reqId, meta);
  }

  // --- Pub/Sub ---

  function publish(jobId: string, event: JobEvent<S>): void {
    const subs = subscribers.get(jobId);
    if (!subs) return;
    for (const fn of subs) {
      try {
        fn(event);
      } catch {
        // subscriber error (e.g. closed SSE connection) — ignore
      }
    }
  }

  function subscribe(jobId: string, fn: JobSubscriber<S>): () => void {
    let subs = subscribers.get(jobId);
    if (!subs) {
      subs = new Set();
      subscribers.set(jobId, subs);
    }
    subs.add(fn);
    return () => {
      subs!.delete(fn);
      if (subs!.size === 0) subscribers.delete(jobId);
    };
  }

  // --- Job management ---

  function createJob(fields: F & { title: string; url: string }): string {
    const id = crypto.randomUUID();
    const job = {
      id,
      status: opts.initialStatus,
      createdAt: Date.now(),
      text: "",
      ...fields,
    } as Job<S, F>;
    jobs.set(id, job);
    const reqId = agentStatus.startRequest("", "running_task", undefined, {
      kind: "capture",
      name: runName(fields),
    });
    jobRuns.set(id, reqId);
    return id;
  }

  function getJob(jobId: string): Job<S, F> | undefined {
    return jobs.get(jobId);
  }

  function getRecentJobs(limit = 20): Job<S, F>[] {
    return [...jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  function updateStatus(jobId: string, status: S): void {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = status;
    publish(jobId, { type: "status", status });
  }

  function appendText(jobId: string, text: string): void {
    const job = jobs.get(jobId);
    if (!job) return;
    job.text += text;
    publish(jobId, { type: "text_delta", text });
  }

  function setCategory(jobId: string, category: string): void {
    const job = jobs.get(jobId);
    if (!job) return;
    job.category = category;
    publish(jobId, { type: "category", category });
  }

  function setSimilar(jobId: string, articles: SimilarArticle[]): void {
    const job = jobs.get(jobId);
    if (!job) return;
    job.similar = articles;
    publish(jobId, { type: "similar", articles });
  }

  function completeJob(jobId: string, summary: string, category: string): void {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = "complete" as S;
    job.summary = summary;
    job.category = category;
    if (opts.completeReplacesText) {
      // See `completeReplacesText` doc above.
      job.text = summary;
      publish(jobId, { type: "complete", summary });
    } else {
      publish(jobId, { type: "complete" });
    }
    completeRun(jobId);
    log.info(`${opts.label} job {jobId} completed, category: {category}`, { jobId, category });
  }

  function failJob(jobId: string, error: string): void {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = "error" as S;
    job.error = error;
    publish(jobId, { type: "error", message: error });
    completeRun(jobId);
    log.error(`${opts.label} job {jobId} failed: {error}`, { jobId, error });
  }

  // --- TTL cleanup ---

  const ttlMs = opts.ttlMs ?? JOB_TTL_MS;
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (now - job.createdAt > ttlMs) {
        jobs.delete(id);
        subscribers.delete(id);
        // Safety net: a job that never reached a terminal state would otherwise
        // leak its registry run (auto-clear only fires on completeRequest).
        completeRun(id);
      }
    }
  }, opts.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS);

  // Prevent timer from keeping process alive
  if (cleanupTimer.unref) cleanupTimer.unref();

  return {
    createJob,
    attachRun,
    getJob,
    getRecentJobs,
    updateStatus,
    appendText,
    setCategory,
    setSimilar,
    completeJob,
    failJob,
    subscribe,
  };
}
