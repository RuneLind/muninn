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

// The summary STREAMS to the card delta by delta, and the visual-reference pass
// (`src/summaries/visual-detail.ts`) rewrites it afterwards — dropping quotes of
// frames that were never extracted, repeated, past the policy's cap, or that the
// copy to the served root could not keep. Without `completeReplacesText` the
// terminal event is a bare `{}`, so the live card and an SSE replay after a
// reload both keep the PRE-rewrite stream, broken image references included.
// The TikTok precedent, for the same reason one layer over: `job.text` becomes
// the final summary (what a replay serves) and the `complete` event carries it
// (what a live browser swaps in). `completeCarriesSummary` on the route's
// `registerSummaryVertical` call is the replay half.
const store = createJobStore<JobStatus, { videoId: string }>({
  subsystem: "youtube",
  label: "YouTube",
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

export function createJob(videoId: string, title: string, url: string): string {
  const id = store.createJob({ videoId, title, url });
  log.info("Created YouTube job {jobId} for video {videoId}", { jobId: id, videoId });
  return id;
}
