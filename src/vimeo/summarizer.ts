import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { getLog } from "../logging.ts";
import { resolveServingProfile } from "../config.ts";
import { VALID_CATEGORIES, parseSummaryResponse } from "../utils/summary-parser.ts";
import { buildSummarySystemPrompt, ingestSummary, runCaptureOneShot } from "../summaries/summarizer-shared.ts";
import { triggerSourceDraftFromCapture } from "../gardener/source-drafter-run.ts";
import { createQueue } from "../wiki/queue.ts";
import { canonicalVimeoUrl } from "./url.ts";
import {
  chooseTrack,
  downloadVtt as realDownloadVtt,
  harvestVimeoCaptions,
  VIMEO_HARVEST_TIMEOUT_MS,
  type VimeoCaptions,
} from "./captions.ts";
import { detectCaptionKind, segmentsToMarkdown, vttToSegments, DEFAULT_WINDOW_SEC } from "./vtt.ts";
import {
  attachRun,
  updateStatus,
  appendText,
  setCategory,
  setSimilar,
  completeJob,
  failJob,
} from "./state.ts";

const log = getLog("vimeo", "summarizer");

/** The collection this vertical ingests into (huginn's `--vimeo-collection`). */
export const VIMEO_COLLECTION = "vimeo-summaries";

/**
 * Longest video this vertical will capture: 3 hours.
 *
 * Enforced in the ROUTE (413), not here — the check needs oEmbed's duration,
 * which the route already has, and refusing before a job exists is what keeps an
 * over-cap paste from leaving an unsettled row at the top of /summaries.
 */
export const VIMEO_MAX_DURATION_SEC = 3 * 60 * 60;

/**
 * A conference talk's summarize call gets the 600 s floor `summarizeTimeoutFor`
 * gives a 30-frame TikTok. There is no frame count to scale by here: the whole
 * input is one transcript, and a 3-hour talk's transcript is ~200 KB of text —
 * large for a prompt, but nothing like the multi-turn image reading the TikTok
 * scaling exists for.
 */
export const VIMEO_SUMMARIZE_TIMEOUT_MS = 600_000;

/** Error code stored on a job whose video has captions we could not choose from. */
export const NO_CAPTIONS_ERROR = "no_captions";

/**
 * oEmbed's `upload_date` is `"YYYY-MM-DD HH:MM:SS"`, huginn's `date` frontmatter
 * is a bare ISO date on every other vertical. Take the date half when it is
 * there and drop the field entirely otherwise — huginn then stamps today, which
 * is a better record than a malformed date nothing can sort on.
 */
export function ingestDate(uploadDate: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(uploadDate.trim());
  return match ? match[1] : undefined;
}

const SUMMARIZE_SYSTEM_PROMPT = buildSummarySystemPrompt(
  "You are a conference-talk analyst. Summarize the following Vimeo video transcript. " +
    "The transcript is grouped into windows headed with an absolute [HH:MM:SS] timestamp; " +
    "those headings are positions in the talk, not content — never quote one as if it were speech.",
  VALID_CATEGORIES,
);

/**
 * The rider appended when the chosen track is machine-generated.
 *
 * Vimeo's auto-captions garble proper nouns — measured on a real JavaZone talk,
 * "JavaBin" comes through as "JavaBeen" — and the failure mode that matters is
 * a summary confidently naming a library, product or person that was never
 * said. The instruction is to describe rather than to assert, not to omit.
 */
export const AUTO_CAPTION_RIDER =
  "\n\nIMPORTANT: this transcript is MACHINE-GENERATED and garbles proper nouns " +
  "(measured: \"JavaBeen\" for JavaBin). Do not assert the spelling of any name, " +
  "product, library or acronym the captions cannot corroborate — describe it " +
  "(\"a JVM testing library\") or mark it uncertain rather than guessing a spelling.";

/**
 * ONE Chromium at a time, process-wide.
 *
 * `harvestVimeoCaptions` launches a browser per harvest. Two concurrent pastes
 * are two legitimate jobs, but they must not be two concurrent Chromiums on a
 * laptop that is also running the dev server, the bots and huginn. A queue (not
 * a try-lock) because neither job may be dropped: the second one waits, then
 * runs, and its own 60 s budget starts when it does.
 */
const harvestQueue = createQueue();
const HARVEST_QUEUE_KEY = "vimeo-harvest";

/** What the route already knows by the time it creates a job. */
export interface VimeoJobMeta {
  readonly videoId: string;
  readonly hash?: string;
  /** The canonical url — the dedup and ingest key. */
  readonly url: string;
  readonly title: string;
  readonly durationSec: number;
  /** oEmbed's `upload_date`, used as the document's `date` frontmatter. */
  readonly uploadDate: string;
}

export type HarvestFn = (
  videoId: string,
  opts: { hash?: string; timeoutMs?: number },
) => Promise<VimeoCaptions>;

export type DownloadVttFn = (url: string) => Promise<string>;

export interface VimeoSummarizerDeps {
  harvest: HarvestFn;
  downloadVtt: DownloadVttFn;
}

/**
 * `VIMEO_HARVEST_STUB` — an absolute path to a `.vtt` file that stands in for
 * the whole browser half, so an acceptance run can drive the vertical end to
 * end with no Chromium and no live Vimeo.
 *
 * It is a BACKDOOR by construction: it makes the process summarize a file off
 * local disk while reporting a capture of a public video. Three gates, all
 * required, and every refusal is a warn rather than a throw — the operator's
 * intent was to capture, and a real harvest is the correct thing to fall back
 * to:
 *
 *  - `resolveServingProfile() === "default"` — never on a serving deployment;
 *  - the path is ABSOLUTE — a relative one resolves against whatever cwd the
 *    process happens to have;
 *  - the file EXISTS — a typo'd path would otherwise fail deep inside the job
 *    as an empty transcript.
 *
 * The stub is resolved per call (not once at import) so a test can set and clear
 * the variable, and it logs ONE line per distinct resolution so a long-running
 * dev server says on every boot which fixture it is serving.
 */
let lastStubWarn: string | null = null;

function stubWarnOnce(message: string, props: Record<string, unknown>): void {
  const key = `${message}:${JSON.stringify(props)}`;
  if (lastStubWarn === key) return;
  lastStubWarn = key;
  log.warn(message, props);
}

/** Test-only: forget the once-per-value warn dedup. */
export function resetHarvestStubWarnState(): void {
  lastStubWarn = null;
}

export async function resolveHarvestStubDeps(
  env: Record<string, string | undefined> = process.env,
): Promise<VimeoSummarizerDeps | null> {
  const raw = env.VIMEO_HARVEST_STUB?.trim();
  if (!raw) return null;

  const profile = resolveServingProfile(env);
  if (profile !== "default") {
    stubWarnOnce(
      "VIMEO_HARVEST_STUB is ignored on serving profile {profile} — running a real harvest",
      { profile },
    );
    return null;
  }
  if (!raw.startsWith("/")) {
    stubWarnOnce(
      "VIMEO_HARVEST_STUB={path} is not an absolute path — ignored, running a real harvest",
      { path: raw },
    );
    return null;
  }
  const file = Bun.file(raw);
  if (!(await file.exists())) {
    stubWarnOnce(
      "VIMEO_HARVEST_STUB={path} does not exist — ignored, running a real harvest",
      { path: raw },
    );
    return null;
  }

  stubWarnOnce(
    "VIMEO_HARVEST_STUB active: harvesting NOTHING, serving captions from {path}",
    { path: raw },
  );

  const vttUrl = `https://captions.vimeo.com/captions/stub.vtt`;
  return {
    harvest: async (videoId) => ({
      videoId,
      title: "",
      durationSec: 0,
      tracks: [{ lang: "en-x-autogen", label: "English (auto-generated)", vttUrl }],
    }),
    downloadVtt: async () => await file.text(),
  };
}

const REAL_DEPS: VimeoSummarizerDeps = {
  harvest: (videoId, opts) => harvestVimeoCaptions(videoId, opts),
  downloadVtt: (url) => realDownloadVtt(url),
};

/**
 * Run one Vimeo capture: harvest → download → window → summarize → ingest →
 * source-draft.
 *
 * `meta` is oEmbed's answer, which the ROUTE already fetched — this function
 * never asks again. Failures land on the job (`failJob`) rather than throwing,
 * and the huginn ingest is best-effort exactly as in the other verticals.
 */
export async function summarizeVimeo(
  jobId: string,
  meta: VimeoJobMeta,
  config: Config,
  botConfig: BotConfig,
  deps?: Partial<VimeoSummarizerDeps>,
): Promise<void> {
  const resolved: VimeoSummarizerDeps = {
    ...REAL_DEPS,
    ...((await resolveHarvestStubDeps()) ?? {}),
    ...(deps ?? {}),
  };

  try {
    // 1. Harvest the signed caption URL and download it, serialized against
    //    every other harvest in this process.
    updateStatus(jobId, "harvesting_captions");

    const captions = await harvestQueue.run(HARVEST_QUEUE_KEY, () =>
      resolved.harvest(meta.videoId, {
        ...(meta.hash ? { hash: meta.hash } : {}),
        timeoutMs: VIMEO_HARVEST_TIMEOUT_MS,
      }),
    );

    const track = chooseTrack(captions.tracks);
    if (!track) {
      // A legitimate answer about the video, not a failure of the mechanism.
      // The manifest url is kept on the log line: it is what PR 4's audio
      // fallback would need, and it expires, so it is worth naming while it is
      // still live.
      log.info("Vimeo video {videoId} has no usable caption track (manifest: {manifestUrl})", {
        videoId: meta.videoId,
        manifestUrl: captions.manifestUrl ?? "none",
      });
      failJob(jobId, NO_CAPTIONS_ERROR);
      return;
    }

    const vtt = await resolved.downloadVtt(track.vttUrl);
    const segments = vttToSegments(vtt, DEFAULT_WINDOW_SEC);
    if (segments.length === 0) {
      failJob(jobId, NO_CAPTIONS_ERROR);
      return;
    }
    const transcript = segmentsToMarkdown(segments);
    const captionKind = detectCaptionKind(track.lang);

    log.info(
      "Harvested {videoId}: {lang} ({kind}), {cues} windows, {chars} chars",
      {
        videoId: meta.videoId,
        lang: track.lang,
        kind: captionKind,
        cues: segments.length,
        chars: transcript.length,
      },
    );

    // 2. Summarize.
    updateStatus(jobId, "summarizing");

    const systemPrompt = `${SUMMARIZE_SYSTEM_PROMPT}

Video title: ${meta.title}
Video URL: ${meta.url}${captionKind === "auto" ? AUTO_CAPTION_RIDER : ""}`;

    const onProgress: StreamProgressCallback = (event) => {
      if (event.type === "text_delta") {
        appendText(jobId, event.text);
      }
    };

    const result = await runCaptureOneShot({
      source: "vimeo",
      jobId,
      title: meta.title,
      url: meta.url,
      prompt: transcript,
      systemPrompt,
      config,
      botConfig,
      attachRun,
      onProgress,
      timeoutMs: VIMEO_SUMMARIZE_TIMEOUT_MS,
      extraTraceAttrs: { captionLang: track.lang, captionKind },
    });

    const { category, summary } = parseSummaryResponse(result.result);
    setCategory(jobId, category);

    log.info("Summarized {videoId}: category={category}, {tokens} output tokens", {
      videoId: meta.videoId,
      category,
      tokens: result.outputTokens,
    });

    // 3. Ingest (best-effort — the summary already streamed to the client).
    updateStatus(jobId, "ingesting");

    let ingestedDocId: string | undefined;
    await ingestSummary({
      knowledgeApiUrl: config.knowledgeApiUrl,
      ingestPath: "/api/vimeo/ingest",
      body: {
        title: meta.title,
        url: canonicalVimeoUrl(meta.videoId),
        summary,
        category,
        ...(ingestDate(meta.uploadDate) ? { date: ingestDate(meta.uploadDate) } : {}),
        transcript_markdown: transcript,
        caption_lang: track.lang,
        caption_kind: captionKind,
        duration_sec: meta.durationSec,
      },
      onSimilar: (similar) => setSimilar(jobId, similar),
      onIngested: (info) => {
        ingestedDocId = info.filePath;
      },
    });

    completeJob(jobId, summary, category);

    // 4. Fire-and-forget source-page draft, keyed on huginn's stored doc id so a
    //    later run-now click cannot mint a duplicate proposal (same rule as the
    //    youtube vertical).
    triggerSourceDraftFromCapture(botConfig, {
      collection: VIMEO_COLLECTION,
      docId: ingestedDocId ?? meta.videoId,
      url: meta.url,
      body: summary,
      sourceTitle: meta.title,
      category,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Vimeo summarization failed for job {jobId}: {error}", { jobId, error: msg });
    failJob(jobId, msg);
  }
}
