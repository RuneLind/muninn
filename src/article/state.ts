import { getLog } from "../logging.ts";
import { createJobStore, type Job, type JobEvent as GenericJobEvent } from "../summaries/job-store.ts";

export type { SimilarArticle } from "../summaries/job-store.ts";

const log = getLog("article", "state");

// --- Types ---

export type JobStatus =
  | "pending"
  | "summarizing"
  | "ingesting"
  | "complete"
  | "error";

// Unlike x-article there is no extension-supplied identity field — a pasted
// article has no stable external id, and the job id (minted by the generic
// store's createJob) is all we need. `author` is the only vertical-specific
// field; it's empty for URL-only / anonymous pastes.
export type ArticleJob = Job<JobStatus, { author: string }>;

export type JobEvent = GenericJobEvent<JobStatus>;

// --- Store ---

const store = createJobStore<JobStatus, { author: string }>({
  subsystem: "article",
  label: "Article",
  initialStatus: "pending",
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

/**
 * Create a pasted-article job. `url`/`author` are optional (a paste can carry
 * neither); the generic store requires a string `url`, so it's passed through
 * as `url ?? ""` and only stamped on the trace when non-empty.
 */
export function createJob(title: string, url?: string, author?: string): string {
  const id = store.createJob({ title, url: url ?? "", author: author ?? "" });
  log.info("Created article job {jobId} for {title}", { jobId: id, title });
  return id;
}
