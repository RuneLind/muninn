import { getLog } from "../logging.ts";
import { createJobStore, type Job, type JobEvent as GenericJobEvent } from "../summaries/job-store.ts";

export type { SimilarArticle } from "../summaries/job-store.ts";

const log = getLog("anthropic", "state");

// --- Types ---

// Mirrors the YouTube/X vertical, minus the transcript step — the candidate's
// full content already lives in Huginn's anthropic-knowledge collection, so the
// summarizer resolves it inline (while still `pending`) rather than fetching a
// separate transcript.
export type JobStatus =
  | "pending"
  | "summarizing"
  | "ingesting"
  | "complete"
  | "error";

export type AnthropicJob = Job<
  JobStatus,
  {
    /** summary_candidates.id this job was kicked from. */
    candidateId: string;
    /** Resulting anthropic-summaries doc id once ingested. */
    docId?: string;
  }
>;

export type JobEvent = GenericJobEvent<JobStatus>;

// --- Store ---

const store = createJobStore<JobStatus, { candidateId: string; docId?: string }>({
  subsystem: "anthropic",
  label: "Anthropic",
  initialStatus: "pending",
});

export const {
  getJob,
  getRecentJobs,
  updateStatus,
  appendText,
  setCategory,
  setSimilar,
  completeJob,
  failJob,
  subscribe,
} = store;

export function createJob(candidateId: string, title: string, url: string): string {
  const id = store.createJob({ candidateId, title, url });
  log.info("Created anthropic job {jobId} for candidate {candidateId}", { jobId: id, candidateId });
  return id;
}

export function setDocId(jobId: string, docId: string): void {
  const job = getJob(jobId);
  if (!job) return;
  job.docId = docId;
}
