import { getLog } from "../logging.ts";
import { createJobStore, type Job, type JobEvent as GenericJobEvent } from "../summaries/job-store.ts";

export type { SimilarArticle } from "../summaries/job-store.ts";

const log = getLog("youtube", "state");

// --- Types ---

/**
 * `downloading` and `extracting_frames` are the FRAMES path only (the reader
 * ticked Slides): the video comes down from yt-dlp and one JPEG per cadence
 * tick comes out of it. A transcript-only capture never leaves the three
 * statuses it always had. Both already have a label and a colour on the
 * /summaries job card — they were added for the Vimeo and X verticals.
 */
export type JobStatus =
  | "pending"
  | "fetching_transcript"
  | "downloading"
  | "extracting_frames"
  | "summarizing"
  | "ingesting"
  | "complete"
  | "error";

export type YouTubeJob = Job<JobStatus, { videoId: string }>;

export type JobEvent = GenericJobEvent<JobStatus>;

// --- Store ---

const store = createJobStore<JobStatus, { videoId: string }>({
  subsystem: "youtube",
  label: "YouTube",
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

export function createJob(videoId: string, title: string, url: string): string {
  const id = store.createJob({ videoId, title, url });
  log.info("Created YouTube job {jobId} for video {videoId}", { jobId: id, videoId });
  return id;
}
