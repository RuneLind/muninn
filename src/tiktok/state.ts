import { getLog } from "../logging.ts";
import { createJobStore, type Job, type JobEvent as GenericJobEvent } from "../summaries/job-store.ts";

export type { SimilarArticle } from "../summaries/job-store.ts";

const log = getLog("tiktok", "state");

// --- Types ---

export type JobStatus =
  | "pending"
  | "downloading"
  | "transcribing"
  | "extracting_frames"
  | "summarizing"
  | "ingesting"
  | "complete"
  | "error";

export type TikTokJob = Job<JobStatus, { videoId: string }>;

// TikTok's summarize is a multi-turn frame-reading session, so the accumulated
// text stream carries tool chatter. The complete event ships the *parsed*
// summary so a live browser can swap out the chatter — the store's
// `completeReplacesText` option drives both that and the job.text overwrite.
export type JobEvent = GenericJobEvent<JobStatus>;

// --- Store ---

const store = createJobStore<JobStatus, { videoId: string }>({
  subsystem: "tiktok",
  label: "TikTok",
  initialStatus: "pending",
  completeReplacesText: true,
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

export function createJob(videoId: string, title: string, url: string): string {
  const id = store.createJob({ videoId, title, url });
  log.info("Created TikTok job {jobId} for video {videoId}", { jobId: id, videoId });
  return id;
}
