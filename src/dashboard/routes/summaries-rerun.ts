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
 * The job is the SOURCE vertical's own (`src/<vertical>/state.ts`), so it
 * streams over that vertical's existing SSE seam and shows up on the shelf and
 * on `/agents` like any capture. Nothing marks it as a re-run on the job
 * itself — the trace carries `rerun: "true"`, which is where the question is
 * ever asked. A shelf badge would be the reason to add a job field, and there
 * is none.
 *
 * One writer per document at a time (the shared claim registry in
 * `src/summaries/summary-save.ts`): two concurrent POSTs would spend two model
 * calls and then race each other's ingest for one FILE, and huginn rewrites the
 * whole document from the request body, so the loser's summary is simply gone.
 * The write itself is that module's `saveSummaryBody`, blocking: a failed or
 * forked ingest fails the job rather than completing it.
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import { getLog } from "../../logging.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { connectorCapabilities } from "../../ai/one-shot.ts";
import { fetchKnowledgeApiText, KnowledgeApiError } from "../../ai/knowledge-api-client.ts";
import { encodeDocIdPath, getSummarySource, isSafeDocId, SUMMARY_SOURCES } from "../../summaries/sources.ts";
import { mapProseLines } from "../../summaries/transcript-split.ts";
import {
  preflightSummarySave,
  readStoredCapture,
  requireSaveDescriptor,
  saveSummaryBody,
  summarySaveClaims,
  titleFromDocId,
  titleRoundTripRefusal,
  type StoredCapture,
  type SummarySaveClaim,
  type SummarySaveClaims,
  type SummarySaveDescriptor,
} from "../../summaries/summary-save.ts";
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
  VISUAL_REFERENCE_HEADING_RE,
  isVisualDetail,
  visualDetailOptions,
  type VisualDetail,
} from "../../summaries/visual-detail.ts";
import { isOutputLang, resolveOutputLang, type OutputLang } from "../../summaries/language.ts";
import {
  FRAME_FILE_RE,
  VIMEO_FRAME_SOURCE,
  YOUTUBE_FRAME_SOURCE,
  frameDirFor,
  framesRootDir,
  isFrameId,
  type CaptureFrame,
  type FrameSource,
} from "../../summaries/frames.ts";
import {
  runCaptureOneShot,
  postSummaryIngest,
  CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS,
  type SummaryIngest,
} from "../../summaries/summarizer-shared.ts";
import { summarizeTimeoutFor } from "../../video/media.ts";
import { youtubeWatchUrl } from "../../youtube/frames.ts";
import { buildYouTubeSystemPrompt, buildYouTubeUserPrompt } from "../../youtube/prompt.ts";
import { finishYouTubeSummary } from "../../youtube/finish.ts";
import { buildVimeoSystemPrompt, buildVimeoUserPrompt } from "../../vimeo/prompt.ts";
import { finishVimeoSummary } from "../../vimeo/finish.ts";
// The SHORT-VIDEO pair — TikTok and X video — run one job, one prompt builder
// and one tail now (muninn #544), so a re-run of either passes that vertical's
// own SPEC rather than importing a per-source module that no longer exists.
import { buildShortVideoSystemPrompt, buildShortVideoUserPrompt } from "../../video/short-video-prompt.ts";
import { finishShortVideoSummary } from "../../video/short-video-finish.ts";
import { shortVideoCaptureKinds, SHORT_VIDEO_THINKING } from "../../video/short-video-kinds.ts";
import { TIKTOK_SPEC } from "../../tiktok/summarizer.ts";
import { X_VIDEO_SPEC } from "../../x-article/video.ts";
import { extractVimeoVideoId } from "../../vimeo/url.ts";
// The import-free `src/youtube/url.ts`, never `./youtube-routes.ts`, which
// re-exports it: reading it there would pull the whole YouTube route graph —
// the job store, the summarizer, every capture route — into this module.
import { extractYouTubeVideoId } from "../../youtube/url.ts";
import { notifyCaptureIngest } from "../../summaries/recent-ingests.ts";
import * as youtubeState from "../../youtube/state.ts";
import * as vimeoState from "../../vimeo/state.ts";
import * as tiktokState from "../../tiktok/state.ts";
import * as xState from "../../x-article/state.ts";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { requireJsonRequest } from "./json-request.ts";

const log = getLog("summaries", "rerun");

/** Reading the source file is a file read on huginn's Python server, not a
 *  model call — the same budget `/api/summaries/documents` gives a listing. */
const RAW_FETCH_TIMEOUT_MS = 10_000;

/** One stored document, as the re-run reads it. */
export interface RerunDocument {
  /** The raw file's bytes. */
  readonly raw: string;
}

/** The side-effecting seams, injected so the unit tests drive the whole route
 *  with no huginn, no bots on disk and no model call. */
export interface SummariesRerunDeps {
  fetchRawDoc: (collection: string, docId: string) => Promise<RerunDocument | null>;
  /** The BLOCKING ingest the shared save posts through. */
  ingest: SummaryIngest;
  oneShot: typeof runCaptureOneShot;
  /** Where kept frames live; default `framesRootDir()`. A test MUST pass one. */
  framesRoot?: string;
  /**
   * How long a single-flight claim may be held, ms — default
   * {@link rerunLatchBudgetMs} over the run's own model-call budget, which is
   * twelve minutes at the floor. A seam so a test can drive the EXPIRY without
   * waiting for it; nothing in production passes one.
   */
  latchBudgetMs?: number;
  /** The per-document claim registry; default the process-wide one, which the
   *  other summary write routes share. A test passes its own. */
  claims?: SummarySaveClaims;
  bots: () => BotConfig[];
}

export function defaultSummariesRerunDeps(knowledgeApiUrl: string): SummariesRerunDeps {
  return {
    // `encodeDocIdPath` (`src/summaries/sources.ts`) — the one spelling the
    // share adapter and the export route also read now, since a real doc id
    // carries `/`, spaces and non-ASCII and a bare interpolation truncates at
    // `#`.
    fetchRawDoc: async (collection, docId) => {
      const raw = await fetchKnowledgeApiText(
        knowledgeApiUrl,
        `/api/document/${encodeURIComponent(collection)}/${encodeDocIdPath(docId)}?raw=1`,
        { timeoutMs: RAW_FETCH_TIMEOUT_MS },
      );
      return { raw };
    },
    ingest: postSummaryIngest,
    oneShot: runCaptureOneShot,
    bots: discoverAllBots,
  };
}

// ---------------------------------------------------------------------------
// The per-vertical table
// ---------------------------------------------------------------------------

/**
 * Everything a re-run needs that differs between verticals: the vertical's
 * SAVE descriptor (`src/summaries/summary-save.ts` — ingest path, re-send
 * list, tags, transcript carrier) plus the re-run-only members.
 */
interface RerunVertical extends SummarySaveDescriptor {
  /**
   * The `source` the CAPTURE traces this vertical's model call under, which is
   * not always the `/summaries` source id: an X VIDEO capture traces
   * `capture:x-video` while its documents live on the `x-article` shelf. A
   * re-run has to trace under the capture's name, or the one comparison this
   * attribute exists for — a run against the capture it re-runs — silently
   * spans two span names.
   */
  readonly captureSource: string;
  /** The frames seam's source, where this vertical keeps quoted slides. */
  readonly frameSource?: FrameSource;
  /** Does this vertical offer a kind picker? (`false` ⇒ `standard` only.) */
  readonly hasKindPicker: boolean;
  /** Does it offer the visual-detail axis? (YouTube alone.) */
  readonly hasVisualDetail: boolean;
  /** The kinds this vertical narrows the shared set to. */
  kinds(bot: BotConfig): CapturePreset[];
  /**
   * The thinking budget this vertical's model call carries, in
   * `runCaptureOneShot`'s own vocabulary: `null` is the bot's own budget,
   * `undefined` is the shared `CAPTURE_THINKING_MAX_TOKENS` cap.
   *
   * A per-vertical seam rather than a bare `captureThinkingFor(preset)`, because
   * the two SHORT-VIDEO verticals answer it from the VERTICAL and not from the
   * kind: `src/video/short-video.ts` passes `SHORT_VIDEO_THINKING` (`null`) on
   * every kind, while their presets say `capped` — so the shared derivation
   * would have a TikTok re-run send an 8k cap where the capture it re-runs sends
   * the bot's budget. Reading the keyframes IS the reasoning in that session,
   * which is why the capture opted out; a re-run of it must not opt back in.
   */
  thinking(preset: CapturePreset): number | null | undefined;
  /** The video id a stored url names — the frames directory and the
   *  recent-ingest key. */
  videoId(url: string): string | null;
  /** Create the job in this vertical's own store. */
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

// **Why every vertical's `prompts` below passes `cadence: false`.**
// `framesPromptSection` states the frame list's spacing ("one every ~N s of the
// talk") from the MEDIAN gap between consecutive frames. That is true of a
// capture — the frames came off one sampler — and false here: a re-run's list is
// `listKeptFrames`, i.e. whatever the previous summary happened to QUOTE, so two
// survivors 30 s and 900 s apart would tell the model the talk is sampled every
// ~870 s. A number nothing measured, in a sentence the model then reasons from.
// The clause is OMITTED rather than zeroed, because the honest answer is that
// this list has no cadence at all.

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

/**
 * The language a Vimeo re-run writes in.
 *
 * The document's own `summary_lang` wins — it is the RESOLVED answer the first
 * capture reached, and re-deriving it would let the summary's language flip
 * under a reader who asked for the same settings again.
 *
 * When the field is ABSENT (every Vimeo document ingested before it existed) or
 * carries something that is not a language, this resolves it exactly as the
 * capture does: {@link resolveOutputLang} over the stored `caption_lang` and
 * the transcript text, which is the pair that made `talk` reliable in the first
 * place (Vimeo tagged a Norwegian talk's auto-captions `en-x-autogen`, measured
 * 2026-09-05, so the text — not the tag — is the deciding evidence). What this
 * replaces was `summary_lang === "nb" ? "nb" : "en"`, i.e. every kind-less
 * Norwegian talk re-summarized in English.
 */
function vimeoOutputLang(
  frontmatter: Record<string, string>,
  transcript: string,
): OutputLang {
  const stored = frontmatter.summary_lang;
  if (isOutputLang(stored)) return stored;
  return resolveOutputLang("talk", frontmatter.caption_lang ?? "", transcript);
}

const VERTICALS: readonly RerunVertical[] = [
  {
    ...requireSaveDescriptor("youtube"),
    captureSource: "youtube",
    frameSource: YOUTUBE_FRAME_SOURCE,
    hasKindPicker: true,
    hasVisualDetail: true,
    kinds: (bot) => youtubeCaptureKinds(bot),
    thinking: (preset) => captureThinkingFor(preset),
    videoId: (url) => extractYouTubeVideoId(url),
    createJob: ({ videoId, title, url }) => youtubeState.createJob(videoId, title, url),
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
        // See `RerunPromptInput.cadence`.
        cadence: false,
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
  },
  {
    ...requireSaveDescriptor("vimeo"),
    captureSource: "vimeo",
    frameSource: VIMEO_FRAME_SOURCE,
    hasKindPicker: true,
    hasVisualDetail: false,
    kinds: (bot) => resolveCapturePresets(bot.prompts, bot.connector),
    thinking: (preset) => captureThinkingFor(preset),
    videoId: (url) => extractVimeoVideoId(url)?.id ?? null,
    createJob: ({ videoId, title, url }) => vimeoState.createJob(videoId, title, url),
    store: vimeoState,
    prompts: (i) => ({
      system: buildVimeoSystemPrompt({
        preset: i.preset,
        title: i.title,
        url: i.url,
        captionKind: vimeoCaptionKind(i.frontmatter.caption_kind),
        outputLang: vimeoOutputLang(i.frontmatter, i.transcript),
      }),
      user: buildVimeoUserPrompt(i.transcript, {
        videoId: i.videoId,
        frames: i.frames,
        // See `RerunPromptInput.cadence`.
        cadence: false,
      }),
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
  },
  {
    ...requireSaveDescriptor("tiktok"),
    // `spec.id` IS the capture's trace source, which is what keeps this entry
    // and the job it re-runs under one span name without a second literal.
    captureSource: TIKTOK_SPEC.id,
    hasKindPicker: true,
    hasVisualDetail: false,
    // The SHORT-VIDEO set, through the module both capture routes resolve
    // theirs from — `requireThinkingControl: true` is what makes it that set
    // rather than the shared one, and a re-run offering a kind the capture
    // route refuses is a menu item whose only outcome is a 400.
    kinds: (bot) => shortVideoCaptureKinds(bot),
    // The VERTICAL's answer, not the kind's — see `RerunVertical.thinking`.
    thinking: () => SHORT_VIDEO_THINKING,
    // This vertical keeps no frames on disk (its keyframes are read out of a
    // temp dir and never quoted by address), so nothing needs a video id but
    // the recent-ingest key, which it does not maintain either.
    videoId: () => null,
    createJob: ({ videoId, title, url }) => tiktokState.createJob(videoId || url, title, url),
    store: tiktokState,
    prompts: (i) => ({
      system: buildShortVideoSystemPrompt(TIKTOK_SPEC, {
        preset: i.preset,
        title: i.title,
        url: i.url,
        author: i.frontmatter.author ?? "unknown",
        // NO frames: this vertical's keyframes lived in a temp dir the capture
        // removed, so a re-run summarizes from the transcript alone. The
        // zero-frame form of the system prompt is the one that ships here —
        // the frames-present form orders the model to read images the user
        // prompt lists none of, and tells it not to narrate them.
        frames: false,
      }),
      user: buildShortVideoUserPrompt({ transcript: i.transcript, frames: [] }),
    }),
    finish: async (i) =>
      finishShortVideoSummary(TIKTOK_SPEC, {
        raw: i.raw,
        jobId: i.jobId,
        videoId: i.videoId,
        // Zero, truthfully: nothing was shown, so the degraded-frame-Reads warn
        // must not fire on a re-run that never had frames to read.
        frameCount: 0,
        onCategory: i.onCategory,
      }),
  },
  {
    ...requireSaveDescriptor("x-article"),
    // The X VIDEO capture (`src/x-article/video.ts`) traces `capture:x-video`,
    // and that is the run a re-run of one of these documents is compared with.
    // Read off the spec, so the shelf id and the trace source cannot drift.
    captureSource: X_VIDEO_SPEC.id,
    hasKindPicker: true,
    hasVisualDetail: false,
    kinds: (bot) => shortVideoCaptureKinds(bot),
    thinking: () => SHORT_VIDEO_THINKING,
    videoId: () => null,
    createJob: ({ videoId, title, url, author }) => xState.createJob(videoId || url, title, url, author),
    store: xState,
    prompts: (i) => ({
      system: buildShortVideoSystemPrompt(X_VIDEO_SPEC, {
        preset: i.preset,
        title: i.title,
        url: i.url,
        author: i.frontmatter.author ?? "unknown",
        frames: false,
      }),
      user: buildShortVideoUserPrompt({ transcript: i.transcript, frames: [] }),
    }),
    // The SPEC's own tail, so the two entries cannot drift apart. `visualWarning`
    // is false on X and true on TikTok, but with `frameCount: 0` the warn is
    // gated off on both (`short-video-finish.ts`), exactly as the TikTok entry
    // says: a transcript-only re-run read no frames and must not claim to.
    finish: async (i) =>
      finishShortVideoSummary(X_VIDEO_SPEC, {
        raw: i.raw,
        jobId: i.jobId,
        videoId: i.videoId,
        frameCount: 0,
        onCategory: i.onCategory,
      }),
  },
];

function verticalFor(sourceId: string): RerunVertical | undefined {
  return VERTICALS.find((v) => v.id === sourceId);
}

// ---------------------------------------------------------------------------
// Reading the stored document
// ---------------------------------------------------------------------------

/**
 * Every kept frame of one video, as a COMPLETE `CaptureFrame[]`.
 *
 * Complete is the contract: `finishYouTubeSummary` removes every quote of a
 * frame absent from the list it is handed, so a listing that missed one would
 * silently delete that slide from the re-summary. Seconds come from the file
 * names, matched by the seam's own {@link FRAME_FILE_RE} rather than by a
 * second spelling of it here — the frames ROUTE serves exactly that shape, so a
 * name this accepted and the route does not would put an address in the prompt
 * that 404s for the reader.
 *
 * There are no selection notes to recover, so every frame carries `note: ""`.
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
    if (!FRAME_FILE_RE.test(name)) continue;
    frames.push({
      path: join(dir, name),
      // The pattern is anchored and the extension is fixed, so the digits are
      // everything before the last four characters.
      tSeconds: Number(name.slice(0, -".jpg".length)),
      note: "",
    });
  }
  return frames.sort((a, b) => a.tSeconds - b.tSeconds);
}

/**
 * Does the stored summary carry a `## Visual reference` appendix?
 *
 * The CANONICAL heading pattern (`VISUAL_REFERENCE_HEADING_RE`, the one the
 * visual-detail pass itself matches on), walked over PROSE lines only. Both
 * halves are load-bearing and each was wrong before:
 *
 *  - A stricter local re-spelling read `## Visual References`,
 *    `## **Visual reference**` and an indented heading as "no appendix", i.e.
 *    `selected` — so "Same settings again" silently DOWNGRADED a `detailed`
 *    document from 20 visuals to 8 and cut the appendix. That is the exact
 *    both-directions failure the shared pattern was written for; a second
 *    spelling of it here is the way that fix comes undone.
 *  - Without the fence walk, a summary QUOTING the heading inside a code block
 *    (an export's own markdown, a talk about this feature) reads as `detailed`.
 */
function storedVisualDetail(body: string): VisualDetail {
  let found = false;
  mapProseLines(body, (line) => {
    if (VISUAL_REFERENCE_HEADING_RE.test(line)) found = true;
    return line;
  });
  return found ? "detailed" : DEFAULT_VISUAL_DETAIL;
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
  /** The claim the route took before the model call; the save requires it. */
  readonly claim: SummarySaveClaim;
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
    const thinking = vertical.thinking(preset);

    store.updateStatus(jobId, "summarizing");
    const result = await deps.oneShot({
      // The CAPTURE's own trace source, not the `/summaries` source id — the two
      // differ for X video (`capture:x-video` vs the `x-article` shelf), and
      // this attribute exists to be compared with the capture it re-runs.
      source: vertical.captureSource,
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
    // The shared save (`src/summaries/summary-save.ts`): the claim this route
    // took before the model call, the stored fields re-sent, the new kind
    // stamped, and a BLOCKING ingest whose answer decides the job's outcome.
    const saved = await saveSummaryBody({
      descriptor: vertical,
      stored,
      docId: input.docId,
      summary: finished.summary,
      summaryKind: preset.id,
      claim: input.claim,
      knowledgeApiUrl: input.config.knowledgeApiUrl,
      ingest: deps.ingest,
    });
    if (!saved.ok) {
      // A fork still put a document in the collection: the sibling. The
      // reindex-window memory has to see it, or a paste of the same video right
      // after captures it again.
      if (saved.code === "forked" && saved.siblingDocId && videoId) {
        notifyCaptureIngest(vertical.id, videoId, saved.siblingDocId, url);
      }
      log.warn("Re-run {jobId} of {docId} was not saved ({code}): {error}", {
        jobId,
        docId: input.docId,
        code: saved.code,
        error: saved.error,
      });
      store.failJob(jobId, saved.error);
      return;
    }
    if (saved.similar.length > 0) store.setSimilar(jobId, saved.similar);

    // The vertical's reindex-window memory. Without it a paste of the same
    // video right after a re-run is captured a SECOND time, and on YouTube that
    // forks a shadow copy rather than only doubling the spend.
    if (videoId) notifyCaptureIngest(vertical.id, videoId, saved.filePath, url);

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
 * stored url — is blocked in the ordinary case: every one of those four routes
 * answers `duplicate` for a document already in the collection, which a re-run's
 * target always is. Not BY CONSTRUCTION, though, and the distinction is the
 * reason this is prose and not a claim: each of those routes DEGRADES a failed
 * listing read to not-a-duplicate (`findExistingByVideoId` returns null from its
 * catch), so a huginn hiccup at the wrong moment lets the capture run. That is
 * an unreliable escape hatch, not a feature.
 *
 * Calling the vertical's summarizer FUNCTION directly gets past the dedup on
 * purpose, and past something else too: it pins neither `title` nor `category`,
 * so a model that re-picked a different category writes a SECOND file under a
 * second path — the exact fork rule 2 above exists to prevent.
 */
export const FULL_RERUN_UNSUPPORTED =
  "A full re-fetch is not available yet: the capture routes answer \"already captured\" for a " +
  "document that exists, and re-running the downloader directly would not pin the title and " +
  "category, so a re-picked category writes a second file instead of replacing this one.";

/**
 * How long past the model call's own budget a re-run keeps OTHER writers out
 * of its document before the claim lapses.
 *
 * Not a deadline for the run: work after the model call (the closing-takeaway
 * check, frame copies) and a connector's own retry loop can outlast it while
 * staying inside their own timeouts. A lapsed claim still saves when nobody
 * else took the key (`pinForWrite` in `summary-save.ts`), and the save pins the
 * claim for the length of its POST. What the number decides is how long a run
 * that never settles keeps the document at `409 in_flight` for everyone else.
 */
export const RERUN_LATCH_SLACK_MS = 120_000;

/**
 * The budget the claim's timer is sized to: whatever this run's model call will
 * actually be given, plus {@link RERUN_LATCH_SLACK_MS}.
 *
 * `summarizeTimeoutFor` is the value passed as `timeoutMs`, so it is what the
 * connector enforces — but a bot whose OWN `timeoutMs` is longer is a
 * configuration this cannot rule out, and a claim that lapses mid-call lets a
 * second POST start a run of its own. The max of the two is the closer reading;
 * a run that still outlives it saves anyway unless that second run claimed.
 */
export function rerunLatchBudgetMs(frameCount: number, bot: BotConfig): number {
  const callBudget = Math.max(
    summarizeTimeoutFor(frameCount, CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS),
    bot.timeoutMs ?? 0,
  );
  return callBudget + RERUN_LATCH_SLACK_MS;
}

export function registerSummariesRerunRoutes(
  app: Hono,
  config: Config,
  deps: SummariesRerunDeps = defaultSummariesRerunDeps(config.knowledgeApiUrl),
): void {
  /**
   * One writer per document — the shared claim registry
   * (`SummarySaveClaims`, `src/summaries/summary-save.ts`), so a re-run and the
   * other summary write routes exclude EACH OTHER, not only themselves.
   *
   * Without it two clicks — a double-click on "Same settings again", two open
   * tabs on one document — spend two model calls and then race each other's
   * ingest for one FILE: huginn rewrites the whole document from the request
   * body, so the loser's summary is simply gone. The second POST is
   * `409 in_flight` instead.
   *
   * Claimed before the model call and released in a `finally` on the job,
   * which is the only place that can know it is over — `runRerunJob` catches
   * its own failures. The claim's timer is sized to the budget that run
   * actually sends ({@link rerunLatchBudgetMs}), so a call that never settles
   * does not pin the document until a restart.
   */
  const claims = deps.claims ?? summarySaveClaims;

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
    // NULL, not the default, for a document written before kinds existed. The
    // ingest still STAMPS `defaultKind` (it is what runs), but the menu has to
    // be able to say so — "Same settings again" over a `standard` the document
    // never asked for is a claim about a decision nobody made.
    const storedKind = stored.frontmatter.summary_kind || null;

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
      // The kind a run with no `kind` will actually use — what `storedKind: null`
      // resolves to. Sent so the menu can NAME it without spelling a constant of
      // its own.
      defaultKind: DEFAULT_CAPTURE_KIND,
      // The title round trip, checked here too so the menu can disable the run
      // items with the reason rather than offering a click that 409s.
      titleRoundTrip: (() => {
        const reason = titleRoundTripRefusal(titleFromDocId(docId));
        return { ok: reason === null, reason };
      })(),
      // NOT stored anywhere: `visual_detail` is a request axis, not a document
      // field. A `## Visual reference` appendix is the one piece of evidence the
      // file carries, and it only ever appears under `detailed` — so the answer
      // is DERIVED from the body (`storedVisualDetail`), never read off it.
      ...(vertical.hasVisualDetail
        ? {
            storedVisualDetail: storedVisualDetail(stored.body),
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
    // **`application/json` is REQUIRED** (the `jira-routes.ts` / `youtube-routes.ts`
    // precedent). Hono parses any body whatever the header says, and `text/plain`
    // is a CORS *simple* request — no preflight at all — so without this gate a
    // cross-origin page could spend a model call AND rewrite a stored document,
    // with the browser never asking permission. This route carries no CORS
    // headers, which stops such a page reading the RESPONSE and does nothing
    // about the write. A `charset` parameter is fine.
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;

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

    // Before any model spend: the shared save's fork refusals (`no_url`,
    // `no_category`, `title_not_round_trippable`) — each a document the ingest
    // would DUPLICATE rather than replace.
    const pre = preflightSummarySave(stored, docId);
    if (!pre.ok) return c.json({ error: pre.error, code: pre.code }, pre.status);
    const { url, category, title } = pre;
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

    // The claim is taken LAST, after every refusal above: a 409 has to mean "a
    // run is under way", and claiming earlier would let a request that then 400s
    // hold the slot until its own return path released it.
    const claim = claims.claim(vertical.id, docId, deps.latchBudgetMs ?? rerunLatchBudgetMs(frames.length, bot));
    if (!claim) {
      return c.json(
        {
          error: "This document is being re-run or saved already. Wait for that to finish.",
          code: "in_flight",
        },
        409,
      );
    }

    let jobId: string;
    try {
      jobId = vertical.createJob({
        videoId,
        title,
        url,
        author: stored.frontmatter.author ?? "unknown",
      });
    } catch (err) {
      // Nothing is running, so the slot must not stay held. `createJob` does not
      // throw today; a claim released only on the happy path is how it comes to
      // matter later.
      claims.release(claim);
      throw err;
    }

    // Fire and forget: the job streams over the vertical's own SSE seam, and the
    // route answers with the id the client attaches to. `runRerunJob` catches its
    // own failures, so the `finally` runs on every path.
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
      claim,
    }).finally(() => {
      claims.release(claim);
    });

    log.info("Re-run started for {docId} as {kind} (job {jobId})", { docId, kind: preset.id, jobId });
    return c.json({
      job_id: jobId,
      dashboard_url: `/summaries?source=${encodeURIComponent(vertical.id)}&job=${jobId}`,
    });
  });
}

/**
 * Module-load assertion, so the two lists that must agree cannot drift: the
 * verticals here are EXACTLY the summary sources flagged `rerun` in the
 * registry, which is what the doc panel renders its control from.
 *
 * At load rather than in a test alone: the registry's flag is what decides
 * whether the reader is offered a control at all, and an id flagged there and
 * missing here is a dead menu, while one here and unflagged there is a feature
 * nobody can reach.
 */
{
  const flagged = SUMMARY_SOURCES.filter((s) => s.rerun).map((s) => s.id).sort();
  const declared = VERTICALS.map((v) => v.id).sort();
  if (flagged.join(",") !== declared.join(",")) {
    throw new Error(
      `The re-run vertical table (${declared.join(", ")}) and the sources flagged rerun ` +
        `(${flagged.join(", ")}) disagree`,
    );
  }
}

/**
 * The short-video pair's ingest path is the SPEC's; the save descriptor states
 * it again as a literal so the shared module needs no capture graph. Asserted
 * at load so the two cannot drift.
 */
for (const [id, spec] of [["tiktok", TIKTOK_SPEC], ["x-article", X_VIDEO_SPEC]] as const) {
  if (requireSaveDescriptor(id).ingestPath !== spec.ingestPath) {
    throw new Error(`The ${id} save descriptor's ingest path disagrees with its capture spec (${spec.ingestPath})`);
  }
}
