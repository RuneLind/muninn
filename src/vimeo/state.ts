import { getLog } from "../logging.ts";
import { createJobStore, type Job, type JobEvent as GenericJobEvent } from "../summaries/job-store.ts";

export type { SimilarArticle } from "../summaries/job-store.ts";

const log = getLog("vimeo", "state");

// --- Types ---

/**
 * There is no `fetching_metadata`. oEmbed runs in the ROUTE, before a job
 * exists — it is what decides whether there is anything to capture at all (not
 * public → 422, over the duration cap → 413), and a job created before that
 * verdict would be a row nothing settles. The metadata is handed to
 * `summarizeVimeo`, which never asks oEmbed again.
 *
 * `pending` is observable, and not only as the instant between `createJob` and
 * the first `updateStatus`: harvests are serialized process-wide (ONE Chromium
 * at a time, `summarizer.ts`), and the status moves INSIDE that queued closure,
 * so a job waiting its turn reports `pending` for as long as every harvest
 * ahead of it takes. Announcing `harvesting_captions` on arrival would be a
 * claim about a browser that is not running.
 */
export type JobStatus =
  | "pending"
  | "harvesting_captions"
  // The Whisper fallback (v2 PR 5): the Opus rendition coming down, then
  // whisper-cli running — both only on a video with no caption track.
  | "downloading"
  | "transcribing"
  | "extracting_frames"
  | "summarizing"
  | "ingesting"
  | "complete"
  | "error";

export type VimeoJob = Job<JobStatus, { videoId: string }>;

export type JobEvent = GenericJobEvent<JobStatus>;

// --- Store ---

// The closing-takeaway check in `runCaptureOneShot` (`summaries/takeaway-check.ts`)
// can rewrite the closer AFTER it streamed, so the stored summary is no longer
// what the card accumulated: `job.text` becomes the final summary (what a
// replay serves) and the `complete` event carries it (what a live browser
// swaps in). `completeCarriesSummary` on the route is the replay half.
const store = createJobStore<JobStatus, { videoId: string }>({
  subsystem: "vimeo",
  label: "Vimeo",
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
  log.info("Created Vimeo job {jobId} for video {videoId}", { jobId: id, videoId });
  return id;
}
