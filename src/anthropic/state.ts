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

// The closing-takeaway check in `runCaptureOneShot` (`summaries/takeaway-check.ts`)
// can rewrite the closer AFTER it streamed, so the stored summary is no longer
// what the card accumulated: `job.text` becomes the final summary (what a
// replay serves) and the `complete` event carries it (what a live browser
// swaps in). `completeCarriesSummary` on the route is the replay half.
const store = createJobStore<JobStatus, { candidateId: string; docId?: string }>({
  subsystem: "anthropic",
  label: "Anthropic",
  initialStatus: "pending",
  completeReplacesText: true,
});

export const {
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
