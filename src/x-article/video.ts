/**
 * The X-video capture, as its SPEC over the shared short-video job.
 *
 * An X/Twitter video post: yt-dlp download → whisper transcript → keyframes →
 * frame-reading Claude one-shot → ingest into the `x-articles` collection (so it
 * shelves under the X badge next to article captures). The steps live in
 * `src/video/short-video.ts`, shared with the TikTok twin; what stays here is
 * what is genuinely X's — the 3-hour cap, the bare-status-URL canonicalisation,
 * the ingest endpoint and collection, the log category, and the ABSENCE of the
 * degraded-frame-Reads warn the TikTok spec turns on.
 *
 * `summarizeXVideo` keeps its name and signature (plus the `preset` option the
 * kind picker adds), so `x-article-routes.ts` is unchanged.
 */

import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { X_VIDEO_PROMPT_SPEC } from "../video/short-video-prompt.ts";
import {
  summarizeShortVideo,
  type ShortVideoOptions,
  type ShortVideoSpec,
} from "../video/short-video.ts";
import { canonicalXStatusUrl, extractXStatusId } from "../video/media.ts";
import * as store from "./state.ts";

export type SummarizeVideoOptions = ShortVideoOptions;

export const X_VIDEO_SPEC: ShortVideoSpec = {
  ...X_VIDEO_PROMPT_SPEC,
  noun: "X video",
  logCategory: ["x-article", "video"],
  // X carries genuinely long recordings (2h+ workshop uploads, talks,
  // interviews) and those are exactly the high-value captures, so the cap is 3
  // hours rather than TikTok's 60 min. The first real capture (a 2:21h
  // Anthropic workshop) tripped the original 20-min cap.
  maxDurationSeconds: 10800,
  workDirPrefix: "muninn-x-video-",
  ingestPath: "/api/x-articles/ingest",
  collection: "x-articles",
  // Key ingest + dedup on the BARE status URL, not yt-dlp's `/video/1`-suffixed
  // webpage_url — media-slot suffixes would defeat URL dedup on the shelf.
  canonicalUrl: (dlCanonicalUrl, submittedUrl) =>
    canonicalXStatusUrl(dlCanonicalUrl) ?? canonicalXStatusUrl(submittedUrl) ?? submittedUrl,
  idFor: (canonicalUrl, dlId) => extractXStatusId(canonicalUrl) ?? dlId,
  // NO degraded-frame-Reads warn: this vertical has never had one, and the
  // merge must not hand it the neighbour's second step.
  visualWarning: false,
  store: {
    attachRun: store.attachRun,
    updateStatus: store.updateStatus,
    appendText: store.appendText,
    setCategory: store.setCategory,
    setSimilar: store.setSimilar,
    completeJob: store.completeJob,
    failJob: store.failJob,
  },
};

export function summarizeXVideo(
  jobId: string,
  url: string,
  title: string,
  config: Config,
  botConfig: BotConfig,
  opts: SummarizeVideoOptions = {},
): Promise<void> {
  return summarizeShortVideo(X_VIDEO_SPEC, jobId, url, title, config, botConfig, opts);
}
