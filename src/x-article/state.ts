import { getLog } from "../logging.ts";
import { createJobStore, type Job, type JobEvent as GenericJobEvent } from "../summaries/job-store.ts";

export type { SimilarArticle } from "../summaries/job-store.ts";

const log = getLog("x-article", "state");

// --- Types ---

export type JobStatus =
  | "pending"
  | "summarizing"
  | "ingesting"
  | "complete"
  | "error";

export type XArticleJob = Job<JobStatus, { articleId: string; author: string }>;

export type JobEvent = GenericJobEvent<JobStatus>;

// --- Store ---

const store = createJobStore<JobStatus, { articleId: string; author: string }>({
  subsystem: "x-article",
  label: "X article",
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

export function createJob(articleId: string, title: string, url: string, author: string): string {
  const id = store.createJob({ articleId, title, url, author });
  log.info("Created X article job {jobId} for article {articleId} by @{author}", { jobId: id, articleId, author });
  return id;
}
