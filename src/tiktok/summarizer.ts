/**
 * The TikTok capture, as its SPEC over the shared short-video job.
 *
 * The nine steps this file used to spell out are `src/video/short-video.ts`
 * now — it and `src/x-article/video.ts` were measured copy-paste twins, and
 * every difference between them is a field below. What stays here is what is
 * genuinely TikTok's: the 60-minute cap (the platform's own maximum), the work
 * dir's name, the log category the JSONL sink is queried by, the ingest
 * endpoint and collection, and the degraded-frame-Reads warn — which the X twin
 * has never had and must not acquire.
 *
 * `summarizeTikTok` keeps its name and signature (plus the `preset` option the
 * kind picker adds), so `tiktok-routes.ts` and every test that mocks this
 * module are unchanged.
 */

import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { TIKTOK_PROMPT_SPEC } from "../video/short-video-prompt.ts";
import {
  summarizeShortVideo,
  type ShortVideoOptions,
  type ShortVideoSpec,
} from "../video/short-video.ts";
import * as store from "./state.ts";

export type SummarizeOptions = ShortVideoOptions;

export const TIKTOK_SPEC: ShortVideoSpec = {
  ...TIKTOK_PROMPT_SPEC,
  noun: "TikTok",
  logCategory: ["tiktok", "summarizer"],
  // TikTok's own platform maximum is 60 min, and long-form uploads (tutorials,
  // walkthroughs) are exactly the captures worth keeping — the media module's
  // 10-min short-clip default rejected a 10:19 Claude Code tutorial.
  maxDurationSeconds: 3600,
  workDirPrefix: "muninn-tiktok-",
  ingestPath: "/api/tiktok/ingest",
  collection: "tiktok-summaries",
  // yt-dlp's canonical `/video/<id>` URL is already the dedup key here.
  canonicalUrl: (dlCanonicalUrl) => dlCanonicalUrl,
  idFor: (_canonicalUrl, dlId) => dlId,
  // The key this vertical's completion line has always used; the JSONL sink is
  // searched by field, so it is the spec's to declare, not the job's.
  idLogKey: "videoId",
  // This vertical warns when a frames-ON summary mentions nothing visual: the
  // frame Reads can degrade silently (a permissions or `--add-dir` regression)
  // and the warn is the only place that failure is visible.
  visualWarning: true,
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

export function summarizeTikTok(
  jobId: string,
  url: string,
  title: string,
  config: Config,
  botConfig: BotConfig,
  opts: SummarizeOptions,
): Promise<void> {
  return summarizeShortVideo(TIKTOK_SPEC, jobId, url, title, config, botConfig, opts);
}
