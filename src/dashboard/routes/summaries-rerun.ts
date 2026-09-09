/**
 * Re-run — `POST /api/summaries/rerun` and `GET /api/summaries/rerun/options`.
 *
 * Summarize a document that is ALREADY in the corpus again, from the
 * `## Transcript` appendix it stored, with no download and no re-fetch. The
 * reader's entry point is the `↻ Re-run ▾` menu in the `/summaries` doc panel.
 *
 * Four rules hold this together, and each of them is a way an earlier shape got
 * it wrong:
 *
 * 1. **The source of truth is the RAW file, not huginn's document JSON.** The
 *    JSON `text` is a cleaned copy — fenced code removed, images rewritten, a
 *    breadcrumb prepended — so a re-run built from it would shrink the document
 *    a little on every pass. `?raw=1` (huginn #131) answers with the bytes on
 *    disk, and {@link fetchKnowledgeApiText} is what reads them without parsing.
 *
 * 2. **The ingest RE-SENDS every frontmatter field, `url` and `date` included.**
 *    huginn's ingest takes no document id: it rewrites the whole file from the
 *    request body, keys the path on `<category>/<sanitized title>.md` and forks
 *    a `(2)` sibling when the stored `url` differs. A field left out is a field
 *    ERASED, and a differing `url` is a shadow copy of the talk. Only
 *    `summary_kind` changes; `title` and `category` are PINNED to the stored
 *    document (overriding the model's own `CATEGORY:` line, with a log line when
 *    they disagree), because either one moving is a second file rather than an
 *    edit.
 *
 * 3. **The vertical's own builders and its own finish tail.** The prompts come
 *    from `src/<vertical>/prompt.ts` and the post-model tail from
 *    `src/<vertical>/finish.ts` (PR 2's extraction) — never re-implemented here.
 *    YouTube's tail holds the summary's frame references to the capture's
 *    manifest and copies what it quotes; Vimeo's deliberately runs neither pass.
 *    A re-run that decided for itself what the tail is would store slide
 *    addresses the frames route 404s, and the model's answer looks fine either
 *    way.
 *
 * 4. **The frame listing handed to the tail is COMPLETE.** `finishYouTubeSummary`
 *    strips every quote of a frame that is NOT in the list it is given, so a
 *    partial listing silently narrows what the re-summary may show. The listing
 *    is therefore the whole kept-frames directory, and the write is UNION-ONLY:
 *    nothing here prunes or overwrites that directory (`removeKeptFrames` belongs
 *    to document delete).
 *
 * The job is the SOURCE vertical's own (`src/<vertical>/state.ts`), flagged
 * `rerun: true`, so it streams over that vertical's existing SSE seam and shows
 * up on the shelf and on `/agents` like any capture.
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import { getLog } from "../../logging.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { connectorCapabilities } from "../../ai/one-shot.ts";
import { fetchKnowledgeApiText, KnowledgeApiError } from "../../ai/knowledge-api-client.ts";
import { getSummarySource, isSafeDocId, SUMMARY_SOURCES } from "../../summaries/sources.ts";
import {
  parseCaptureFrontmatter,
  decodeFrontmatterScalar,
  splitTranscript,
  transcriptIsWindowed,
} from "../../summaries/transcript-split.ts";
import {
  capturePresetOptions,
  findCapturePreset,
  resolveCapturePresets,
  captureBotConfigFor,
  captureThinkingFor,
  DEFAULT_CAPTURE_KIND,
  type CapturePreset,
} from "../../summaries/presets.ts";
import { youtubeCaptureKinds } from "../../youtube/kinds.ts";
import {
  DEFAULT_VISUAL_DETAIL,
  isVisualDetail,
  visualDetailOptions,
  type VisualDetail,
} from "../../summaries/visual-detail.ts";
import {
  VIMEO_FRAME_SOURCE,
  YOUTUBE_FRAME_SOURCE,
  frameDirFor,
  framesRootDir,
  isFrameId,
  type CaptureFrame,
  type FrameSource,
} from "../../summaries/frames.ts";
import {
  ingestSummary,
  runCaptureOneShot,
  CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS,
} from "../../summaries/summarizer-shared.ts";
import { summarizeTimeoutFor } from "../../video/media.ts";
import { appendTranscriptSection, TRANSCRIPT_TRUNCATION_NOTE, youtubeWatchUrl } from "../../youtube/frames.ts";
import { buildYouTubeSystemPrompt, buildYouTubeUserPrompt } from "../../youtube/prompt.ts";
import { finishYouTubeSummary } from "../../youtube/finish.ts";
import { buildVimeoSystemPrompt, buildVimeoUserPrompt } from "../../vimeo/prompt.ts";
import { finishVimeoSummary } from "../../vimeo/finish.ts";
import { buildTikTokSystemPrompt, buildTikTokUserPrompt } from "../../tiktok/prompt.ts";
import { finishTikTokSummary } from "../../tiktok/finish.ts";
import { buildXVideoSystemPrompt, buildXVideoUserPrompt } from "../../x-article/video-prompt.ts";
import { finishXVideoSummary } from "../../x-article/video-finish.ts";
import { extractVimeoVideoId } from "../../vimeo/url.ts";
import { extractYouTubeVideoId } from "./youtube-routes.ts";
import { notifyCaptureIngest } from "../../summaries/recent-ingests.ts";
import { RERUN_SOURCES } from "../../summaries/rerun-sources.ts";
import * as youtubeState from "../../youtube/state.ts";
import * as vimeoState from "../../vimeo/state.ts";
import * as tiktokState from "../../tiktok/state.ts";
import * as xState from "../../x-article/state.ts";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const log = getLog("summaries", "rerun");

/** Reading the source file is a file read on huginn's Python server, not a
 *  model call — the same budget `/api/summaries/documents` gives a listing. */
const RAW_FETCH_TIMEOUT_MS = 10_000;

/** One stored document, as the re-run reads it. */
export interface RerunDocument {
  /** The raw file's bytes. */
  readonly raw: string;
  /** The path header huginn reports, when it sent one — logged, never trusted. */
  readonly sourcePath?: string;
}

/** The side-effecting seams, injected so the unit tests drive the whole route
 *  with no huginn, no bots on disk and no model call. */
export interface SummariesRerunDeps {
  fetchRawDoc: (collection: string, docId: string) => Promise<RerunDocument | null>;
  ingest: typeof ingestSummary;
  oneShot: typeof runCaptureOneShot;
  /** Where kept frames live; default `framesRootDir()`. A test MUST pass one. */
  framesRoot?: string;
  bots: () => BotConfig[];
}

export function defaultSummariesRerunDeps(knowledgeApiUrl: string): SummariesRerunDeps {
  return {
    // Segment-encoded exactly as `summaries-share.ts`'s `fetchDoc` encodes it —
    // a real doc id carries `/`, spaces and non-ASCII, and a bare interpolation
    // truncates at `#`.
    fetchRawDoc: async (collection, docId) => {
      const encoded = docId.split("/").map(encodeURIComponent).join("/");
      const raw = await fetchKnowledgeApiText(
        knowledgeApiUrl,
        `/api/document/${encodeURIComponent(collection)}/${encoded}?raw=1`,
        { timeoutMs: RAW_FETCH_TIMEOUT_MS },
      );
      return { raw };
    },
    ingest: ingestSummary,
    oneShot: runCaptureOneShot,
    bots: discoverAllBots,
  };
}

// ---------------------------------------------------------------------------
// The per-vertical table
// ---------------------------------------------------------------------------

/** Everything a re-run needs that differs between verticals. */
interface RerunVertical {
  /** The `/summaries` source id the client posts. */
  readonly id: string;
  /** huginn's ingest path for this vertical. */
  readonly ingestPath: string;
  /** The frames seam's source, where this vertical keeps quoted slides. */
  readonly frameSource?: FrameSource;
  /** Which frontmatter keys the vertical's ingest model accepts, `date`/`url`
   *  included — the RE-SEND list. `summary_kind` is here and is the one field
   *  the re-run overwrites. */
  readonly frontmatterFields: readonly string[];
  /** Does this vertical offer a kind picker? (`false` ⇒ `standard` only.) */
  readonly hasKindPicker: boolean;
  /** Does it offer the visual-detail axis? (YouTube alone.) */
  readonly hasVisualDetail: boolean;
  /** The kinds this vertical narrows the shared set to. */
  kinds(bot: BotConfig): CapturePreset[];
  /** The video id a stored url names — the frames directory and the
   *  recent-ingest key. */
  videoId(url: string): string | null;
  /** Create the job in this vertical's own store, flagged `rerun`. */
  createJob(input: { videoId: string; title: string; url: string; author: string }): string;
  /** The store's write surface, so the job streams like a capture. */
  readonly store: {
    attachRun: typeof youtubeState.attachRun;
    /** Narrowed to the two statuses a re-run passes through — every vertical's
     *  own union carries both, and a wider `string` would not be assignable. */
    updateStatus: (jobId: string, status: "summarizing" | "ingesting") => void;
    appendText: (jobId: string, text: string) => void;
    setCategory: (jobId: string, category: string) => void;
    setSimilar: typeof youtubeState.setSimilar;
    completeJob: (jobId: string, summary: string, category: string) => void;
    failJob: (jobId: string, error: string) => void;
  };
  /** The two prompts, from the vertical's OWN builders. */
  prompts(input: RerunPromptInput): { system: string; user: string };
  /** The vertical's post-model tail (PR 2's `finish<Vertical>Summary`). */
  finish(input: RerunFinishInput): Promise<{ summary: string; category: string; kept?: number[] }>;
  /** The ingest body's transcript half: appended to the summary string, or its
   *  own field. */
  readonly transcriptCarrier: "summary" | "field";
}

interface RerunPromptInput {
  readonly preset: CapturePreset;
  readonly title: string;
  readonly url: string;
  readonly videoId: string;
  readonly transcript: string;
  readonly windowed: boolean;
  readonly frames: readonly CaptureFrame[];
  readonly visualDetail: VisualDetail;
  readonly frontmatter: Record<string, string>;
}

interface RerunFinishInput {
  readonly raw: string;
  readonly jobId: string;
  readonly videoId: string;
  readonly frames: readonly CaptureFrame[];
  readonly visualDetail: VisualDetail;
  readonly framesRoot?: string;
  readonly onCategory: (category: string) => void;
}

/** `manual`/`auto` as the Vimeo prompt's rider wants it; anything else — a
 *  `whisper` or `stub` capture — takes the auto rider, since both garble proper
 *  nouns the same way the rider describes. */
function vimeoCaptionKind(value: string | undefined): "manual" | "auto" {
  return value === "manual" ? "manual" : "auto";
}

const VERTICALS: readonly RerunVertical[] = [
  {
    id: "youtube",
    ingestPath: "/api/youtube/ingest",
    frameSource: YOUTUBE_FRAME_SOURCE,
    frontmatterFields: ["date", "url", "summary_kind"],
    hasKindPicker: true,
    hasVisualDetail: true,
    kinds: (bot) => youtubeCaptureKinds(bot),
    videoId: (url) => extractYouTubeVideoId(url),
    createJob: ({ videoId, title, url }) => youtubeState.createJob(videoId, title, url, { rerun: true }),
    store: youtubeState,
    prompts: (i) => ({
      system: buildYouTubeSystemPrompt(i.preset, {
        windowed: i.windowed,
        title: i.title,
        // The url the first capture put in the prompt is built from the id
        // (`youtubeWatchUrl`), never from a stored string — the same rule its
        // route follows, and what keeps the snapshot key equal to the capture's.
        videoUrl: youtubeWatchUrl(i.videoId),
      }),
      user: buildYouTubeUserPrompt(i.transcript, {
        videoId: i.videoId,
        frames: i.frames,
        visualDetail: i.visualDetail,
      }),
    }),
    finish: (i) =>
      finishYouTubeSummary({
        raw: i.raw,
        jobId: i.jobId,
        videoId: i.videoId,
        frames: i.frames,
        visualDetail: i.visualDetail,
        ...(i.framesRoot !== undefined ? { framesRoot: i.framesRoot } : {}),
        onCategory: i.onCategory,
      }),
    transcriptCarrier: "summary",
  },
  {
    id: "vimeo",
    ingestPath: "/api/vimeo/ingest",
    frameSource: VIMEO_FRAME_SOURCE,
    // `vimeo_video_id` is DERIVED by huginn from the url and is not a request
    // field, so it is deliberately absent: sending it would 422.
    frontmatterFields: [
      "date",
      "url",
      "caption_lang",
      "caption_kind",
      "summary_kind",
      "summary_lang",
      "author",
      "upload_date",
      "speaker",
      "thumbnail_url",
      "duration_sec",
    ],
    hasKindPicker: true,
    hasVisualDetail: false,
    kinds: (bot) => resolveCapturePresets(bot.prompts, bot.connector),
    videoId: (url) => extractVimeoVideoId(url)?.id ?? null,
    createJob: ({ videoId, title, url }) => vimeoState.createJob(videoId, title, url, { rerun: true }),
    store: vimeoState,
    prompts: (i) => ({
      system: buildVimeoSystemPrompt({
        preset: i.preset,
        title: i.title,
        url: i.url,
        captionKind: vimeoCaptionKind(i.frontmatter.caption_kind),
        // The RESOLVED language the document already carries. A re-run never
        // re-resolves `talk`: the first capture's answer is on the document, and
        // re-deriving it from the transcript could flip the summary's language
        // under a reader who asked for the same settings again.
        outputLang: i.frontmatter.summary_lang === "nb" ? "nb" : "en",
      }),
      user: buildVimeoUserPrompt(i.transcript, { videoId: i.videoId, frames: i.frames }),
    }),
    finish: (i) =>
      finishVimeoSummary({
        raw: i.raw,
        jobId: i.jobId,
        videoId: i.videoId,
        frames: i.frames,
        ...(i.framesRoot !== undefined ? { framesRoot: i.framesRoot } : {}),
        onCategory: i.onCategory,
      }),
    transcriptCarrier: "field",
  },
  {
    id: "tiktok",
    ingestPath: "/api/tiktok/ingest",
    frontmatterFields: ["date", "url", "author"],
    hasKindPicker: false,
    hasVisualDetail: false,
    kinds: (bot) => resolveCapturePresets(bot.prompts, bot.connector),
    // This vertical keeps no frames on disk (its keyframes are read out of a
    // temp dir and never quoted by address), so nothing needs a video id but
    // the recent-ingest key, which it does not maintain either.
    videoId: () => null,
    createJob: ({ videoId, title, url }) =>
      tiktokState.createJob(videoId || url, title, url, { rerun: true }),
    store: tiktokState,
    prompts: (i) => ({
      system: buildTikTokSystemPrompt({
        title: i.title,
        url: i.url,
        author: i.frontmatter.author ?? "unknown",
      }),
      // NO frames: this vertical's keyframes lived in a temp dir the capture
      // removed, so a re-run summarizes from the transcript alone. The builder's
      // empty-frame branch is the one that ships.
      user: buildTikTokUserPrompt({ transcript: i.transcript, frames: [] }),
    }),
    finish: async (i) =>
      finishTikTokSummary({
        raw: i.raw,
        jobId: i.jobId,
        videoId: i.videoId,
        // Zero, truthfully: nothing was shown, so the degraded-frame-Reads warn
        // must not fire on a re-run that never had frames to read.
        frameCount: 0,
        onCategory: i.onCategory,
      }),
    transcriptCarrier: "summary",
  },
  {
    id: "x-article",
    ingestPath: "/api/x-articles/ingest",
    frontmatterFields: ["date", "url", "author"],
    hasKindPicker: false,
    hasVisualDetail: false,
    kinds: (bot) => resolveCapturePresets(bot.prompts, bot.connector),
    videoId: () => null,
    createJob: ({ videoId, title, url, author }) =>
      xState.createJob(videoId || url, title, url, author, { rerun: true }),
    store: xState,
    prompts: (i) => ({
      system: buildXVideoSystemPrompt({
        title: i.title,
        url: i.url,
        author: i.frontmatter.author ?? "unknown",
      }),
      user: buildXVideoUserPrompt({ transcript: i.transcript, frames: [] }),
    }),
    finish: async (i) => finishXVideoSummary({ raw: i.raw, onCategory: i.onCategory }),
    transcriptCarrier: "summary",
  },
];

function verticalFor(sourceId: string): RerunVertical | undefined {
  return VERTICALS.find((v) => v.id === sourceId);
}

// ---------------------------------------------------------------------------
// Reading the stored document
// ---------------------------------------------------------------------------

/** What the raw file says, once split. */
export interface StoredCapture {
  /**
   * The frontmatter DECODED — what the route reads when it needs a value
   * (`summary_lang`, `caption_kind`, `author`, `url`, `summary_kind`).
   */
  readonly frontmatter: Record<string, string>;
  /**
   * The same keys with their RAW on-disk text, which is what the ingest body is
   * built from.
   *
   * Two maps and not one, because decoding TWICE is a wrong answer, not a
   * no-op: huginn writes a quoted `caption_lang: "2026"` and a bare
   * `duration_sec: 3180`, and re-decoding the already-unquoted `2026` turns a
   * string field into a NUMBER its `Optional[str]` model refuses. The decoded
   * map cannot tell the two apart any more; the raw one still can.
   */
  readonly frontmatterRaw: Record<string, string>;
  /** The summary WITHOUT the transcript appendix. */
  readonly body: string;
  /** The appendix's text, trimmed — `null` when the document has none. */
  readonly transcript: string | null;
  readonly windowed: boolean;
  /** The stored appendix ends on the shared truncation note. */
  readonly truncated: boolean;
}

/**
 * Split one raw capture file into the parts a re-run needs.
 *
 * The transcript is TRIMMED here, because `appendTranscriptSection` (and
 * huginn's Vimeo `body_suffix`) add their own separator and their own trailing
 * newline — re-appending an untrimmed appendix grows the file by a blank line
 * on every pass, which is exactly the shrink-on-every-pass failure `?raw=1`
 * exists to stop, in the other direction.
 */
export function readStoredCapture(raw: string): StoredCapture {
  const fm = parseCaptureFrontmatter(raw);
  const frontmatter: Record<string, string> = {};
  for (const [key, value] of Object.entries(fm.byKey)) {
    frontmatter[key] = String(decodeFrontmatterScalar(value));
  }
  const split = splitTranscript(fm.body);
  const transcript = split.transcript === null ? null : split.transcript.trim();
  return {
    frontmatter,
    frontmatterRaw: { ...fm.byKey },
    body: split.body.trimEnd(),
    transcript: transcript === "" ? null : transcript,
    windowed: transcript !== null && transcriptIsWindowed(transcript),
    truncated: transcript !== null && transcript.includes(TRANSCRIPT_TRUNCATION_NOTE),
  };
}

/**
 * The document's display title.
 *
 * From the FILE NAME, because no capture vertical writes a `title:` key — the
 * title lives only in `<category>/<sanitized title>.md`. huginn re-sanitizes
 * whatever is posted, and `sanitize_filename` is idempotent, so a title read
 * back out of the path and posted again resolves to the SAME path. Deriving it
 * from anything else is how a re-run forks a second document.
 */
export function titleFromDocId(docId: string): string {
  const base = docId.split("/").pop() ?? docId;
  return base.replace(/\.md$/i, "") || docId;
}

/** The category the document is filed under — its own directory, which is what
 *  huginn keys the path on. `null` for an id with no directory part. */
export function categoryFromDocId(docId: string): string | null {
  const at = docId.lastIndexOf("/");
  return at <= 0 ? null : docId.slice(0, at);
}

/**
 * Every kept frame of one video, as a COMPLETE `CaptureFrame[]`.
 *
 * Complete is the contract: `finishYouTubeSummary` removes every quote of a
 * frame absent from the list it is handed, so a listing that missed one would
 * silently delete that slide from the re-summary. Seconds come from the file
 * names — the frames route serves exactly `<digits>.jpg` — and there are no
 * selection notes to recover, so every frame carries `note: ""`.
 *
 * Ascending by second, so the prompt's list reads in talk order.
 */
export async function listKeptFrames(
  source: FrameSource,
  videoId: string,
  root: string = framesRootDir(),
): Promise<CaptureFrame[]> {
  if (!isFrameId(source, videoId)) return [];
  const dir = frameDirFor(source, videoId, root);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const frames: CaptureFrame[] = [];
  for (const name of names) {
    const m = /^(\d{1,6})\.jpg$/.exec(name);
    if (!m) continue;
    frames.push({ path: join(dir, name), tSeconds: Number(m[1]), note: "" });
  }
  return frames.sort((a, b) => a.tSeconds - b.tSeconds);
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

interface RerunJobInput {
  readonly vertical: RerunVertical;
  readonly jobId: string;
  readonly docId: string;
  readonly stored: StoredCapture;
  readonly title: string;
  readonly category: string;
  readonly url: string;
  readonly videoId: string;
  readonly preset: CapturePreset;
  readonly visualDetail: VisualDetail;
  readonly frames: CaptureFrame[];
  readonly botConfig: BotConfig;
  readonly config: Config;
  readonly deps: SummariesRerunDeps;
}

/**
 * The ingest body: every frontmatter field the vertical accepts, re-sent
 * verbatim, with `summary_kind` set to the kind this run used and `title` /
 * `category` pinned to the stored document.
 *
 * Its own function rather than an expression inside the job, so the per-vertical
 * `frontmatterFields` list is applied in ONE place and the round trip is
 * readable next to the rule it implements. Not exported: the tests drive it
 * through the real route, which is the only way the per-vertical table is under
 * test rather than a copy of it.
 */
function buildRerunIngestBody(input: {
  vertical: RerunVertical;
  stored: StoredCapture;
  title: string;
  category: string;
  summary: string;
  transcript: string;
  kindId: string;
}): Record<string, unknown> {
  const { vertical, stored } = input;
  const body: Record<string, unknown> = { title: input.title, category: input.category };
  for (const key of vertical.frontmatterFields) {
    // The RAW text, never the decoded map — see `StoredCapture.frontmatterRaw`.
    const raw = stored.frontmatterRaw[key];
    if (raw === undefined) continue;
    // `summary_kind` is the one field a re-run changes. Everything else is
    // decoded from the RAW on-disk text, so a bare `duration_sec: 3180` is a
    // NUMBER again rather than a string huginn would re-render as `"3180"`.
    if (key === "summary_kind") continue;
    body[key] = decodeFrontmatterScalar(raw);
  }
  body.summary_kind = input.kindId;
  if (vertical.transcriptCarrier === "summary") {
    const appended = appendTranscriptSection(input.summary, input.transcript);
    body.summary = appended.text;
  } else {
    body.summary = input.summary;
    body.transcript_markdown = input.transcript;
  }
  return body;
}

async function runRerunJob(input: RerunJobInput): Promise<void> {
  const { vertical, jobId, stored, title, category, url, videoId, preset, frames, deps } = input;
  const store = vertical.store;
  try {
    const transcript = stored.transcript ?? "";
    const built = vertical.prompts({
      preset,
      title,
      url,
      videoId,
      transcript,
      windowed: stored.windowed,
      frames,
      visualDetail: input.visualDetail,
      frontmatter: stored.frontmatter,
    });

    // The kind's run levers, resolved exactly as a capture resolves them: `deep`
    // swaps the model in BEFORE the call, so the `/agents` card says opus from
    // its first frame.
    const runBot = captureBotConfigFor(input.botConfig, preset);
    const thinking = captureThinkingFor(preset);

    store.updateStatus(jobId, "summarizing");
    const result = await deps.oneShot({
      source: vertical.id,
      jobId,
      title,
      // The url the FIRST capture stored under — so the prompt snapshot lands
      // under the same key and `GET /api/summaries/prompt?url=` keeps finding
      // one row per document rather than one per run.
      url,
      prompt: built.user,
      systemPrompt: built.system,
      config: input.config,
      botConfig: runBot,
      attachRun: store.attachRun,
      onProgress: (event) => {
        if (event.type === "text_delta") store.appendText(jobId, event.text);
      },
      ...(frames.length > 0 && vertical.frameSource
        ? { extraDirs: [frameDirFor(vertical.frameSource, videoId, deps.framesRoot)] }
        : {}),
      timeoutMs: summarizeTimeoutFor(frames.length, CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS),
      ...(thinking === null ? { thinkingMaxTokens: null } : {}),
      extraTraceAttrs: {
        rerun: "true",
        summaryKind: preset.id,
        frameCount: String(frames.length),
        transcriptWindows: String(stored.windowed),
        ...(vertical.hasVisualDetail ? { visualDetail: input.visualDetail } : {}),
      },
    });

    // The vertical's OWN tail — see rule 3 in the header.
    const finished = await vertical.finish({
      raw: result.result,
      jobId,
      videoId,
      frames,
      visualDetail: input.visualDetail,
      ...(deps.framesRoot !== undefined ? { framesRoot: deps.framesRoot } : {}),
      onCategory: () => {
        // The live card is told the PINNED category, never the model's: the
        // document is filed where it is filed, and showing the model's guess on
        // the card would contradict the file the ingest writes a moment later.
        store.setCategory(jobId, category);
      },
    });
    if (finished.category && finished.category !== category) {
      log.info(
        "Re-run {jobId}: the model filed {docId} under {modelCategory}; the stored category {category} wins",
        { jobId, docId: input.docId, modelCategory: finished.category, category },
      );
    }

    // The completion record. YouTube's is the STRUCTURED one
    // (`event: "capture_complete"`), because `scripts/replay-youtube.ts` parses
    // that marker for its `run.json` — a re-run that skipped it would leave the
    // replay harness with no run to read.
    if (vertical.id === "youtube") {
      log.info(
        "Re-summarized {videoId}: kind={summaryKind}, visual={visualDetail}, category={category}, model={model}, {tokens} output tokens, frames={frames}",
        {
          videoId,
          event: "capture_complete",
          rerun: true,
          summaryKind: preset.id,
          visualDetail: input.visualDetail,
          category,
          model: result.model ?? "unknown",
          requestedModel: runBot.model ?? "bot-default",
          tokens: result.outputTokens,
          frames: frames.length,
        },
      );
    } else {
      log.info("Re-summarized {docId} as {summaryKind} ({model})", {
        docId: input.docId,
        summaryKind: preset.id,
        model: result.model ?? "unknown",
      });
    }

    store.updateStatus(jobId, "ingesting");
    const body = buildRerunIngestBody({
      vertical,
      stored,
      title,
      category,
      summary: finished.summary,
      transcript,
      kindId: preset.id,
    });
    let ingestedDocId: string | undefined;
    await deps.ingest({
      knowledgeApiUrl: input.config.knowledgeApiUrl,
      ingestPath: vertical.ingestPath,
      body,
      onSimilar: (similar) => store.setSimilar(jobId, similar),
      onIngested: (info) => {
        ingestedDocId = info.filePath;
      },
    });

    // The vertical's reindex-window memory. Without it a paste of the same
    // video right after a re-run is captured a SECOND time, and on YouTube that
    // forks a shadow copy rather than only doubling the spend.
    if (ingestedDocId && videoId) {
      notifyCaptureIngest(vertical.id, videoId, ingestedDocId, url);
    }
    if (ingestedDocId && ingestedDocId !== input.docId) {
      log.warn(
        "Re-run {jobId} wrote {written} for a re-run of {docId} — the stored path was not overwritten",
        { jobId, written: ingestedDocId, docId: input.docId },
      );
    }

    // NO source-drafter trigger. A capture fires one from its summarizer; the
    // re-run calls no summarizer, and drafting a second wiki proposal for a
    // document that already has one is a duplicate the gate has to reject by
    // hand.
    store.completeJob(jobId, finished.summary, category);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Re-run {jobId} of {docId} failed: {error}", { jobId, docId: input.docId, error: message });
    store.failJob(jobId, message);
  }
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

/**
 * Why `full: true` answers 501 on every vertical today, stated once.
 *
 * The obvious implementation — POST the vertical's own `/summarize` with the
 * stored url — is unreachable BY CONSTRUCTION: every one of those four routes
 * answers `duplicate` for a document that is already in the collection, which a
 * re-run's target always is. Calling the vertical's summarizer FUNCTION directly
 * gets past that and past something else too: it pins neither `title` nor
 * `category`, so a model that re-picked a different category writes a SECOND
 * file under a second path — the exact fork rule 2 above exists to prevent.
 */
export const FULL_RERUN_UNSUPPORTED =
  "A full re-fetch is not available yet: the capture routes answer \"already captured\" for a " +
  "document that exists, and re-running the downloader directly would not pin the title and " +
  "category, so a re-picked category writes a second file instead of replacing this one.";

export function registerSummariesRerunRoutes(
  app: Hono,
  config: Config,
  deps: SummariesRerunDeps = defaultSummariesRerunDeps(config.knowledgeApiUrl),
): void {
  /** Read + split one document, or the JSON error the caller gets. */
  async function loadStored(
    sourceId: string,
    docId: string,
  ): Promise<
    | { ok: true; vertical: RerunVertical; collection: string; stored: StoredCapture }
    | { ok: false; status: 400 | 404 | 502 | 503; error: string; code: string }
  > {
    const source = getSummarySource(sourceId);
    const vertical = verticalFor(sourceId);
    if (!source || !vertical) {
      return { ok: false, status: 400, error: `Re-run is not available for source "${sourceId}".`, code: "bad_source" };
    }
    if (!isSafeDocId(docId)) {
      return { ok: false, status: 400, error: "docId is not a document path.", code: "bad_doc_id" };
    }
    let doc: RerunDocument | null;
    try {
      doc = await deps.fetchRawDoc(source.collection, docId);
    } catch (err) {
      if (err instanceof KnowledgeApiError && err.upstreamStatus === 404) {
        return { ok: false, status: 404, error: "No such document.", code: "not_found" };
      }
      const status = err instanceof KnowledgeApiError && err.statusCode === 503 ? 503 : 502;
      return { ok: false, status, error: "Could not read the stored document.", code: "upstream" };
    }
    if (!doc) return { ok: false, status: 404, error: "No such document.", code: "not_found" };
    return { ok: true, vertical, collection: source.collection, stored: readStoredCapture(doc.raw) };
  }

  /**
   * What the `↻ Re-run ▾` menu renders itself from.
   *
   * The panel knows the source, the doc id and the url; it does NOT know the
   * stored kind, whether there is a transcript at all, or how many frames
   * survived — all three are properties of the file, and the menu is wrong
   * without them. One read, so opening the menu costs one huginn round-trip and
   * not four.
   */
  app.get("/api/summaries/rerun/options", async (c) => {
    const sourceId = (c.req.query("source") ?? "").trim();
    const docId = (c.req.query("docId") ?? "").trim();
    if (!docId) return c.json({ error: "docId is required", code: "bad_doc_id" }, 400);

    const loaded = await loadStored(sourceId, docId);
    if (!loaded.ok) return c.json({ error: loaded.error, code: loaded.code }, loaded.status);
    const { vertical, stored } = loaded;

    const bot = resolveSummarizerBot(deps.bots());
    const kinds = bot && vertical.hasKindPicker ? capturePresetOptions(vertical.kinds(bot)) : [];
    const storedKind = stored.frontmatter.summary_kind || DEFAULT_CAPTURE_KIND;

    const url = stored.frontmatter.url ?? "";
    const videoId = vertical.videoId(url) ?? "";
    const frames =
      vertical.frameSource && videoId
        ? await listKeptFrames(vertical.frameSource, videoId, deps.framesRoot)
        : [];

    return c.json({
      hasTranscript: stored.transcript !== null,
      truncated: stored.truncated,
      windowed: stored.windowed,
      kinds,
      storedKind,
      // NOT stored anywhere: `visual_detail` is a request axis, not a document
      // field. A `## Visual reference` appendix is the one piece of evidence the
      // file carries, and it only ever appears under `detailed` — so the answer
      // is `detailed` when it is there and the route's own default otherwise.
      ...(vertical.hasVisualDetail
        ? {
            storedVisualDetail: /^#{2,3}\s*Visual reference\b/im.test(stored.body)
              ? "detailed"
              : DEFAULT_VISUAL_DETAIL,
            visualDetailOptions: visualDetailOptions(),
          }
        : {}),
      framesKept: frames.length,
      // The prompt route matches the url EXACTLY against what the vertical
      // stored, which for YouTube is `youtubeWatchUrl(id)` and need not equal
      // the listing's url — so the menu is told the string to ask with rather
      // than deriving one of its own.
      promptUrl: vertical.id === "youtube" && videoId ? youtubeWatchUrl(videoId) : url,
      full: { supported: false, reason: FULL_RERUN_UNSUPPORTED },
      bot: bot?.name ?? null,
    });
  });

  app.post("/api/summaries/rerun", async (c) => {
    type Body = { source?: string; docId?: string; kind?: unknown; visual_detail?: unknown; full?: unknown };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    const sourceId = typeof body.source === "string" ? body.source.trim() : "";
    const docId = typeof body.docId === "string" ? body.docId.trim() : "";
    if (!docId) return c.json({ error: "docId is required", code: "bad_doc_id" }, 400);

    if (body.full === true) {
      return c.json({ error: FULL_RERUN_UNSUPPORTED, code: "not_implemented" }, 501);
    }

    if (body.kind !== undefined && (typeof body.kind !== "string" || body.kind.trim() === "")) {
      return c.json({ error: "Summary kind must be a non-blank string.", code: "bad_kind" }, 400);
    }
    if (body.visual_detail !== undefined && !isVisualDetail(body.visual_detail)) {
      return c.json({ error: "Unknown visual detail.", code: "bad_visual_detail" }, 400);
    }

    // Read + split SYNCHRONOUSLY, before the job exists: a document with no
    // appendix is a refusal the caller can act on, and a failed job that says
    // so is a card the reader has to go and read.
    const loaded = await loadStored(sourceId, docId);
    if (!loaded.ok) return c.json({ error: loaded.error, code: loaded.code }, loaded.status);
    const { vertical, stored } = loaded;
    if (stored.transcript === null) {
      return c.json(
        {
          error: "This summary has no stored transcript, so it cannot be re-run without downloading the source again.",
          code: "no_transcript",
        },
        400,
      );
    }

    const bot = resolveSummarizerBot(deps.bots());
    if (!bot) return c.json({ error: "No bots configured", code: "no_bot" }, 500);

    const kinds = vertical.kinds(bot);
    const wantedKind = typeof body.kind === "string" ? body.kind : stored.frontmatter.summary_kind;
    const preset = findCapturePreset(kinds, wantedKind);
    if (!preset) {
      return c.json({ error: `Unknown summary kind: ${wantedKind}`, code: "bad_kind" }, 400);
    }

    const url = stored.frontmatter.url ?? "";
    if (!url) {
      return c.json(
        { error: "The stored document carries no url, so a re-ingest would fork a second file.", code: "no_url" },
        400,
      );
    }
    const category = categoryFromDocId(docId);
    if (!category) {
      return c.json({ error: "The stored document is not filed under a category.", code: "no_category" }, 400);
    }
    const title = titleFromDocId(docId);
    const videoId = vertical.videoId(url) ?? "";

    const frames =
      vertical.frameSource && videoId
        ? await listKeptFrames(vertical.frameSource, videoId, deps.framesRoot)
        : [];
    // The frames are handed to the model as `--add-dir`, so a connector that
    // cannot read files would produce a summary with no slides while the tail
    // stripped every quote it could not serve — a re-run that silently loses
    // pictures. Refused instead, the TikTok/YouTube `frames_unsupported`
    // precedent, before a job exists.
    if (frames.length > 0 && !connectorCapabilities(bot).supportsExtraDirs) {
      return c.json(
        {
          error: `Summarizer bot "${bot.name}" cannot read the kept slides, so a re-run would drop them.`,
          code: "frames_unsupported",
        },
        503,
      );
    }

    const visualDetail: VisualDetail = isVisualDetail(body.visual_detail)
      ? body.visual_detail
      : DEFAULT_VISUAL_DETAIL;

    const jobId = vertical.createJob({
      videoId,
      title,
      url,
      author: stored.frontmatter.author ?? "unknown",
    });

    // Fire and forget: the job streams over the vertical's own SSE seam, and the
    // route answers with the id the client attaches to.
    void runRerunJob({
      vertical,
      jobId,
      docId,
      stored,
      title,
      category,
      url,
      videoId,
      preset,
      visualDetail,
      frames,
      botConfig: bot,
      config,
      deps,
    });

    log.info("Re-run started for {docId} as {kind} (job {jobId})", { docId, kind: preset.id, jobId });
    return c.json({
      job_id: jobId,
      dashboard_url: `/summaries?source=${encodeURIComponent(vertical.id)}&job=${jobId}`,
    });
  });
}

/**
 * Module-load assertions, so the three lists that must agree cannot drift:
 * every vertical here names a REGISTERED summary source, and the import-free
 * {@link RERUN_SOURCES} the doc-panel view renders its control from names
 * exactly these verticals.
 *
 * At load rather than in a test alone: the view's list is what decides whether
 * the reader is offered a control, and an id present in one list and absent
 * from the other is either a dead menu or a missing one.
 */
for (const v of VERTICALS) {
  if (!SUMMARY_SOURCES.some((s) => s.id === v.id)) {
    throw new Error(`Re-run vertical "${v.id}" is not a registered summary source`);
  }
}
if (
  RERUN_SOURCES.length !== VERTICALS.length ||
  !VERTICALS.every((v) => RERUN_SOURCES.includes(v.id))
) {
  throw new Error("RERUN_SOURCES and the re-run vertical table disagree");
}
