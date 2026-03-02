import { getLog } from "../logging.ts";

const log = getLog("youtube", "state");

// --- Types ---

export type JobStatus =
  | "pending"
  | "fetching_transcript"
  | "summarizing"
  | "ingesting"
  | "complete"
  | "error";

export interface SimilarArticle {
  title: string;
  url: string;
  snippet?: string;
  relevance?: number;
  id?: string;
}

export interface YouTubeJob {
  id: string;
  videoId: string;
  title: string;
  url: string;
  status: JobStatus;
  createdAt: number;
  /** Accumulated streaming text from Claude */
  text: string;
  category?: string;
  summary?: string;
  error?: string;
  similar?: SimilarArticle[];
}

export type JobEvent =
  | { type: "status"; status: JobStatus }
  | { type: "text_delta"; text: string }
  | { type: "category"; category: string }
  | { type: "similar"; articles: SimilarArticle[] }
  | { type: "complete" }
  | { type: "error"; message: string };

type JobSubscriber = (event: JobEvent) => void;

// --- State ---

const jobs = new Map<string, YouTubeJob>();
const subscribers = new Map<string, Set<JobSubscriber>>();

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// --- Pub/Sub ---

function publish(jobId: string, event: JobEvent): void {
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

export function subscribe(jobId: string, fn: JobSubscriber): () => void {
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

export function createJob(videoId: string, title: string, url: string): string {
  const id = crypto.randomUUID();
  const job: YouTubeJob = {
    id,
    videoId,
    title,
    url,
    status: "pending",
    createdAt: Date.now(),
    text: "",
  };
  jobs.set(id, job);
  log.info("Created YouTube job {jobId} for video {videoId}", { jobId: id, videoId });
  return id;
}

export function getJob(jobId: string): YouTubeJob | undefined {
  return jobs.get(jobId);
}

export function getRecentJobs(limit = 20): YouTubeJob[] {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

export function updateStatus(jobId: string, status: JobStatus): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = status;
  publish(jobId, { type: "status", status });
}

export function appendText(jobId: string, text: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.text += text;
  publish(jobId, { type: "text_delta", text });
}

export function setCategory(jobId: string, category: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.category = category;
  publish(jobId, { type: "category", category });
}

export function setSimilar(jobId: string, articles: SimilarArticle[]): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.similar = articles;
  publish(jobId, { type: "similar", articles });
}

export function completeJob(jobId: string, summary: string, category: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "complete";
  job.summary = summary;
  job.category = category;
  publish(jobId, { type: "complete" });
  log.info("YouTube job {jobId} completed, category: {category}", { jobId, category });
}

export function failJob(jobId: string, error: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "error";
  job.error = error;
  publish(jobId, { type: "error", message: error });
  log.error("YouTube job {jobId} failed: {error}", { jobId, error });
}

// --- TTL cleanup ---

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(id);
      subscribers.delete(id);
    }
  }
}, CLEANUP_INTERVAL_MS);

// Prevent timer from keeping process alive
if (cleanupTimer.unref) cleanupTimer.unref();
