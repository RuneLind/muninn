/**
 * What every capture combination actually sends the model — sources down, kinds
 * across, one cell each.
 *
 * This module builds the `/summaries/prompts` page's whole payload and renders
 * none of it, so the answer is testable without a DOM. Three rules it lives by,
 * and all three are the point rather than style:
 *
 * **Every string comes from the builder the RUN calls.** Nothing here spells a
 * prompt. A second copy of a prompt on an inspection page is worse than no page:
 * it would keep agreeing with itself long after the capture changed, which is
 * exactly the drift the page exists to make visible.
 *
 * **The tint is built, never parsed.** A cell carries the system prompt's
 * {@link PromptPiece} spans, so the page colours each line by the piece that
 * produced it. A regex over the finished text would be a second, weaker parser
 * that goes wrong on the first reworded rider — and silently, since a mis-tinted
 * line still reads correctly.
 *
 * **One FIXED placeholder input, for every cell.** The user-prompt skeleton is
 * the run's own builder over invented text — two transcript windows, two frames,
 * one of them carrying a selection note. Fixed rather than per-source, so two
 * cells differ only where the PROMPTS differ; invented rather than real, because
 * this repo is public and a live transcript is not ours to ship.
 *
 * It calls no model, writes nothing, and reads no database. The one thing it
 * reads about the world is the bot: its resolved kinds and whether a
 * `prompts/captureSummary.<id>.md` override file is on disk.
 */

import type { BotConfig } from "../bots/config.ts";
import { join } from "node:path";
import { buildTakeawayCheckPrompt } from "./takeaway-check.ts";
import {
  CAPTURE_DEEP_MODEL,
  CAPTURE_THINKING_MAX_TOKENS,
  TALK_NOTES_STRUCTURE_BULLETS,
  captureVariantIsPresent,
  resolveCapturePresets,
  type CaptureRunOptions,
  type CapturePreset,
} from "./presets.ts";
import type { CaptureFrame } from "./frames.ts";
import { DEFAULT_VISUAL_DETAIL, VISUAL_DETAIL_LABELS } from "./visual-detail.ts";
import { joinPromptPieces, type PromptPiece } from "./prompt-pieces.ts";
import type { Keyframe } from "../video/media.ts";

import { buildYouTubeUserPrompt, youTubeSystemPromptPieces } from "../youtube/prompt.ts";
import { buildVimeoUserPrompt, vimeoSystemPromptPieces } from "../vimeo/prompt.ts";
import {
  TIKTOK_PROMPT_SPEC,
  X_VIDEO_PROMPT_SPEC,
  buildShortVideoUserPrompt,
  shortVideoSystemPromptPieces,
} from "../video/short-video-prompt.ts";
import { SHORT_VIDEO_RUN_OVERRIDE } from "../video/short-video-kinds.ts";
import { xArticleSystemPromptPieces } from "../x-article/prompt.ts";
import { articleSystemPromptPieces } from "../article/prompt.ts";
import { anthropicSystemPromptPieces } from "../anthropic/prompt.ts";

// ---------------------------------------------------------------------------
// The fixed placeholder input
// ---------------------------------------------------------------------------

/**
 * The windowed transcript every video cell's skeleton is built from: two
 * `### [HH:MM:SS]` windows, two minutes apart, with one invented line each.
 *
 * Two windows rather than one because the windowed-transcript rider is about
 * headings being POSITIONS, and a single heading shows no position. The text is
 * invented — this repo is public, and a real capture's transcript is not ours to
 * publish.
 */
export const PLACEHOLDER_WINDOWED_TRANSCRIPT =
  "### [00:00:00]\n\nThe speaker states the problem and says which measurement the talk turns on.\n\n" +
  "### [00:02:00]\n\nThe same measurement is shown on a chart and the number is read out.";

/** The flat form, for the verticals whose transcript is whisper's plain text. */
export const PLACEHOLDER_FLAT_TRANSCRIPT =
  "The speaker states the problem, then reads the number off the chart on screen.";

/** The stand-in for a pasted or fetched body — the text verticals' user prompt. */
export const PLACEHOLDER_ARTICLE_TEXT =
  "A placeholder article body. It states the problem, gives one measurement, and ends.";

export const PLACEHOLDER_TITLE = "A placeholder capture";
export const PLACEHOLDER_AUTHOR = "placeholder-author";

/**
 * The three text verticals' placeholder URLs. Exported rather than left inline
 * because the tests compare each cell against its OWN vertical's builder, and a
 * second spelling of the url on the test side would make that comparison agree
 * with itself.
 */
export const PLACEHOLDER_XARTICLE_URL = "https://x.com/placeholder/article/1234567890123456789";
export const PLACEHOLDER_ARTICLE_URL = "https://example.invalid/placeholder-article";
export const PLACEHOLDER_ANTHROPIC_URL = "https://example.invalid/placeholder-release";

/** The two short-video placeholder URLs, exported for the same reason. */
export const PLACEHOLDER_TIKTOK_URL = "https://www.tiktok.com/@placeholder/video/1234567890123456789";
export const PLACEHOLDER_XVIDEO_URL = "https://x.com/placeholder/status/1234567890123456789";

/**
 * The YouTube id is literally `placeholder` — eleven characters of the URL-safe
 * base64 alphabet, so it passes `YOUTUBE_FRAME_SOURCE.idRe` and the frames seam
 * builds real addresses from it. Vimeo ids are DIGITS (`^\d{1,20}$`), so that
 * vertical gets a numeric stand-in instead; the seam's id gate is not something
 * an inspection page may talk its way past.
 */
export const PLACEHOLDER_YOUTUBE_ID = "placeholder";
export const PLACEHOLDER_VIMEO_ID = "1234567890";

/** Where the placeholder frames pretend to live — a job work dir that never existed. */
const PLACEHOLDER_FRAME_DIR = "/tmp/muninn-capture-placeholder/frames";

/**
 * Two frames, at 60 s and 120 s. One carries a selection note and one does not,
 * because that difference is a REAL fork in the YouTube prompt: the `detailed`
 * must-quote rule names "the note above" and is stated only where a frame has
 * one.
 */
export const PLACEHOLDER_FRAMES: readonly CaptureFrame[] = [
  {
    path: `${PLACEHOLDER_FRAME_DIR}/60.jpg`,
    tSeconds: 60,
    note: "chart: the measurement the talk turns on",
  },
  { path: `${PLACEHOLDER_FRAME_DIR}/120.jpg`, tSeconds: 120 },
];

/** The short-video verticals' frame shape — a path and a time, no note channel. */
export const PLACEHOLDER_KEYFRAMES: readonly Keyframe[] = PLACEHOLDER_FRAMES.map((f) => ({
  path: f.path,
  tSeconds: f.tSeconds,
}));

/** The body the takeaway check is shown, and the closer it is asked to check. */
export const PLACEHOLDER_SUMMARY_BODY =
  "## Key takeaways\n\n- The measurement moved from 40 s to 12 s after one change.\n\n" +
  "## What was shown\n\nThe chart on screen is the same measurement over four weeks.";
export const PLACEHOLDER_TAKEAWAY =
  "One change cut the measurement from 40 s to 12 s — the biggest win of the whole project.";

// ---------------------------------------------------------------------------
// The sources
// ---------------------------------------------------------------------------

/**
 * How a source's system prompt is scaffolded — the chip a no-kind cell shows.
 *
 * No row is `hand-rolled` today: the two short-video verticals were, and the
 * merge put them on the shared envelope's `before`/`after` slots. The value
 * stays because the distinction is real and a new vertical can arrive with one.
 */
export type EnvelopeStyle = "shared" | "hand-rolled";

export interface PromptMatrixSource {
  /** The `source` string the capture stamps on its trace (`capture:<id>`). */
  readonly id: string;
  readonly label: string;
  /** Whether this capture reads a video (frames) or text. */
  readonly medium: "video" | "text";
  /** Whether the source offers a KIND picker — false ⇒ one cell spanning the row. */
  readonly kinds: boolean;
  readonly envelope: EnvelopeStyle;
  /**
   * The run options a kind-less source always uses. Kind-ful sources take these
   * from the preset instead.
   */
  readonly run: CaptureRunOptions;
  /**
   * What this vertical decides for ITSELF, whatever the kind says — merged over
   * the preset's run options, per row.
   *
   * The two short-video rows are the case it exists for: that job sends
   * `SHORT_VIDEO_THINKING` on every kind, so reading `thinking` off the preset
   * showed "capped at 8000" on four of its six cells (the two `deep` cells already inherited) while the capture ran on
   * the bot's own budget. A page that shows the run has to show the run —
   * including the half a preset does not decide.
   */
  readonly runOverride?: Partial<CaptureRunOptions>;
  /** One clause about the frames (or the absence of them) this capture sends. */
  readonly framesNote: string;
  /**
   * Whether this vertical's USER-prompt builder takes a visual-detail policy.
   * Only YouTube's does — `buildVimeoUserPrompt` takes the frames section's
   * default rules — so a Vimeo cell claiming one would name a picker nothing in
   * its prompt reads.
   */
  readonly readsVisualDetail: boolean;
  /**
   * The axes THIS PAGE pins, in the reader's words — the choices `cellPrompts`
   * made that a real capture makes per run.
   *
   * A skeleton is only honest if it says which branch it took: the Vimeo cell
   * shows the auto-caption rider and an English summary, the Anthropic cell the
   * release framing with no linked-content rider, and a reader who is not told
   * that reads a page that quietly omits half of each vertical.
   *
   * **The list is maintained BY HAND**, from the branch points named in the
   * comment above each row. `prompt-matrix.test.ts` checks every DECLARED axis
   * against the composed prompt; it cannot find an axis a builder branches on
   * and no row declares, because nothing enumerates a builder's branch points
   * mechanically — so a builder that gains a branch has to come back here.
   * NEVER empty: the renderer has one wording, and a row with no axis renders a
   * `fixed:` line naming nothing.
   */
  readonly fixedAxes: readonly string[];
}

/**
 * Every capture source that goes through `runCaptureOneShot`, in the order the
 * page lists them: the video verticals first, then the text ones.
 *
 * `x-video` is a source here even though it is not in `SUMMARY_SOURCES` — that
 * registry is the SHELF's (an X video ingests into the `x-articles` collection),
 * while this page is about the PROMPT, and the X-video prompt is a different
 * prompt from the X-article one.
 */
export const PROMPT_MATRIX_SOURCES: readonly PromptMatrixSource[] = [
  {
    id: "youtube",
    label: "YouTube",
    medium: "video",
    kinds: true,
    envelope: "shared",
    run: { thinking: "capped", model: "bot" },
    framesNote: "slides quoted inline by address",
    // Branch points, from `src/youtube/prompt.ts`: `optionalPiece(input.windowed,
    // …)` in the system pieces; `frames.length > 0`, the `visualDetail` argument
    // and `frames.some((f) => (f.note ?? "") !== "")` in `buildYouTubeUserPrompt`.
    // The note also feeds `visualDetailPolicy`'s must-quote rule, which lives in
    // the `detailed` branch and is therefore NOT in what this row shows.
    fixedAxes: [
      "windowed transcript: yes",
      "frames: two, so the cadence clause is present",
      "one frame carries a selection note",
      "visual detail: selected",
    ],
    readsVisualDetail: true,
  },
  {
    id: "vimeo",
    label: "Vimeo",
    medium: "video",
    kinds: true,
    envelope: "shared",
    run: { thinking: "capped", model: "bot" },
    framesNote: "slides quoted inline by address",
    // Branch points, from `src/vimeo/prompt.ts`: `optionalPiece(input.captionKind
    // === "auto", …)` and `languageRider(input.outputLang)` in the system pieces;
    // `buildVimeoUserPrompt` passes the frames straight to `framesPromptSection`,
    // which returns "" on an empty list and appends `— <note>` per noted frame.
    // NO visual-detail axis: that builder takes no policy argument.
    fixedAxes: [
      "captions: auto-generated",
      "output language: English",
      "frames: two, so the cadence clause is present",
      "one frame carries a selection note",
    ],
    readsVisualDetail: false,
  },
  {
    id: "tiktok",
    label: "TikTok",
    medium: "video",
    kinds: true,
    // The SHARED envelope since the short-video merge: the frame-reading rules
    // ride its `before` slot and the no-commentary rule its `after` one, which
    // is what the hand-rolled one spelled by hand.
    envelope: "shared",
    // Vestigial on a kind-ful row (`buildCell` takes the PRESET's run options);
    // kept because `PromptMatrixSource` requires one.
    run: { thinking: "capped", model: "bot" },
    // The one thing this vertical decides for itself, on every kind.
    runOverride: SHORT_VIDEO_RUN_OVERRIDE,
    framesNote: "keyframes read first, never quoted",
    // Branch points, from `src/video/short-video-prompt.ts`. SYSTEM: the
    // `frames` axis — `false` drops the frame-reading and visual-only rules and
    // names the transcript alone in the intro, which is the form a re-run of a
    // stored capture asks for. USER: `input.transcript ? … : "No speech
    // detected — summarize from the frames."` (a music-only clip is a real
    // capture) and `input.frames.length > 0`.
    fixedAxes: [
      "system prompt: the frames-present form",
      "transcript: present",
      "keyframes: present",
    ],
    readsVisualDetail: false,
  },
  {
    id: "x-video",
    label: "X video",
    medium: "video",
    kinds: true,
    envelope: "shared",
    run: { thinking: "capped", model: "bot" },
    // The same job, so the same override.
    runOverride: SHORT_VIDEO_RUN_OVERRIDE,
    framesNote: "keyframes read first, never quoted",
    // The same three, through the same builder — the X spec differs from the
    // TikTok one in the platform noun and one clause, nothing else.
    fixedAxes: [
      "system prompt: the frames-present form",
      "transcript: present",
      "keyframes: present",
    ],
    readsVisualDetail: false,
  },
  {
    id: "x-article",
    label: "X article",
    medium: "text",
    kinds: false,
    envelope: "shared",
    run: { thinking: "capped", model: "bot" },
    framesNote: "no frames — pasted text",
    // Branch points, from `src/x-article/prompt.ts`: NONE — title, author and
    // url are required and interpolated unconditionally. The row used to
    // declare "author and url: both present", which was a statement of the
    // PLACEHOLDER rather than a pinned branch; it is gone. What is left is the
    // one thing this builder does vary on: nothing, which is itself the fact
    // worth showing. There is no user builder — the pasted text is the prompt.
    fixedAxes: ["title, author and url: all required — nothing here varies"],
    readsVisualDetail: false,
  },
  {
    id: "article",
    label: "Article",
    medium: "text",
    kinds: false,
    envelope: "shared",
    run: { thinking: "capped", model: "bot" },
    framesNote: "no frames — pasted text",
    // The same two optional context lines, in `src/article/prompt.ts`.
    fixedAxes: ["author and url: both present"],
    readsVisualDetail: false,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    medium: "text",
    kinds: false,
    envelope: "shared",
    run: { thinking: "capped", model: "bot" },
    framesNote: "no frames — fetched text",
    // Branch points, from `src/anthropic/prompt.ts`: the `framing` fork
    // (`anthropic` / `x-post`) and the enrichment rider. Both are pinned to the
    // form above; the unshown half is in "Landed as-is" on the PR.
    fixedAxes: ["framing: Anthropic release", "linked-content rider: absent"],
    readsVisualDetail: false,
  },
];

/** The chip a kind-less source shows in place of a kind, spanning the row. */
export function noKindChip(envelope: EnvelopeStyle): string {
  return envelope === "hand-rolled" ? "hand-rolled envelope, no kind" : "shared envelope, no kind";
}

// ---------------------------------------------------------------------------
// The cells
// ---------------------------------------------------------------------------

export interface PromptMatrixOverride {
  /** `<botDir>/prompts/captureSummary.<id>.md` — where a per-bot kind would live. */
  readonly path: string;
  readonly present: boolean;
}

export interface PromptMatrixCell {
  readonly sourceId: string;
  /** The kind this cell is, or null for the one cell of a kind-less source. */
  readonly kindId: string | null;
  readonly kindLabel: string | null;
  /** What this combination receives, in reading order. */
  readonly chips: readonly string[];
  /** The composed system prompt's spans — what the drawer tints by. */
  readonly systemPieces: readonly PromptPiece[];
  /** The composed system prompt: `joinPromptPieces(systemPieces)`. */
  readonly systemPrompt: string;
  /** The run's own user-prompt builder over the fixed placeholder input. */
  readonly userPrompt: string;
  /** `buildTakeawayCheckPrompt` over the placeholder body and closer. */
  readonly takeawayPrompt: string;
  /** Null on a kind-less source: there is no file that could override it. */
  readonly override: PromptMatrixOverride | null;
}

export interface PromptMatrixRow {
  readonly source: PromptMatrixSource;
  /**
   * One cell per kind on a kind-ful source; exactly one on every other, which
   * the page renders spanning the kind columns.
   */
  readonly cells: readonly PromptMatrixCell[];
}

export interface PromptMatrix {
  /** The bot the kinds and the override paths were resolved against. */
  readonly botName: string;
  readonly botDir: string;
  /** Every bot the picker offers, in discovery order. */
  readonly bots: readonly { name: string; connector: string }[];
  /** The kind columns — the resolver's answer for this bot. */
  readonly kinds: readonly { id: string; label: string }[];
  readonly rows: readonly PromptMatrixRow[];
  /** The visual-detail policy the placeholder input is built under. */
  readonly visualDetail: string;
}

/** The chips a preset's run options contribute. */
function runChips(run: CaptureRunOptions): string[] {
  return [
    run.model === "opus" ? `model: ${CAPTURE_DEEP_MODEL}` : "model: the bot's own",
    run.thinking === "inherit"
      ? "thinking: the bot's own budget"
      : `thinking: capped at ${CAPTURE_THINKING_MAX_TOKENS}`,
  ];
}

/**
 * What to call this kind's structure piece.
 *
 * A VALUE comparison against the shipped talk-notes bullets, not a look at the
 * id and not a search of the text: an id can be renamed and a per-bot override
 * of `talk-notes` really does replace the timeline with something else, and in
 * both cases the honest chip is the one that follows the bullets actually sent.
 */
function structureChip(preset: CapturePreset): string {
  return preset.instruction === TALK_NOTES_STRUCTURE_BULLETS.join("\n")
    ? "timeline bullets"
    : "structure bullets";
}

/**
 * The chips the system prompt's own pieces contribute, minus the structure one.
 *
 * A piece whose text is only whitespace contributes NO chip: it is a separator
 * between two parts, not a part. The Vimeo intro split produces one (the `\n\n`
 * between the intro block and the envelope), and without this the cell listed
 * "intro" twice.
 */
function pieceChips(pieces: readonly PromptPiece[], preset: CapturePreset | null): string[] {
  return pieces
    .filter((p) => p.text.trim() !== "")
    .map((p) =>
      p.id === "structure" && preset !== null ? structureChip(preset) : p.label.toLowerCase(),
    );
}

/** Where a per-bot override of this kind would live, and whether it is there. */
function overrideFor(bot: BotConfig, kindId: string): PromptMatrixOverride {
  return {
    path: join(bot.dir, "prompts", `captureSummary.${kindId}.md`),
    // The SAME predicate `resolveCapturePresets` applies, not a second reading
    // of it: a variant with blank content is ignored by the resolver, so a
    // marker that called it "present" would name a file the capture does not use.
    present: (bot.prompts?.captureSummaryVariants ?? []).some(
      (v) => v.id === kindId && captureVariantIsPresent(v),
    ),
  };
}

/**
 * The system-prompt pieces and the user prompt for one (source, kind) pair.
 *
 * The switch is the whole point of the module: each vertical composes its prompt
 * differently, and the ONLY correct way to show one is to call that vertical's
 * own builder. A kind-less source ignores `preset` because its prompt has no
 * place to put one.
 */
function cellPrompts(
  source: PromptMatrixSource,
  preset: CapturePreset | null,
): { pieces: PromptPiece[]; userPrompt: string } {
  switch (source.id) {
    case "youtube":
      return {
        pieces: youTubeSystemPromptPieces(preset!, {
          windowed: true,
          title: PLACEHOLDER_TITLE,
          videoUrl: `https://www.youtube.com/watch?v=${PLACEHOLDER_YOUTUBE_ID}`,
        }),
        userPrompt: buildYouTubeUserPrompt(PLACEHOLDER_WINDOWED_TRANSCRIPT, {
          videoId: PLACEHOLDER_YOUTUBE_ID,
          frames: PLACEHOLDER_FRAMES,
          visualDetail: DEFAULT_VISUAL_DETAIL,
        }),
      };
    case "vimeo":
      return {
        pieces: vimeoSystemPromptPieces({
          preset: preset!,
          title: PLACEHOLDER_TITLE,
          url: `https://vimeo.com/${PLACEHOLDER_VIMEO_ID}`,
          // The auto-caption rider is SHOWN: it is the branch a reader cannot
          // see anywhere else, and Vimeo's own captions are machine-generated
          // far more often than not.
          captionKind: "auto",
          outputLang: "en",
        }),
        userPrompt: buildVimeoUserPrompt(PLACEHOLDER_WINDOWED_TRANSCRIPT, {
          videoId: PLACEHOLDER_VIMEO_ID,
          frames: PLACEHOLDER_FRAMES,
        }),
      };
    case "tiktok":
      return {
        pieces: shortVideoSystemPromptPieces(TIKTOK_PROMPT_SPEC, {
          preset: preset!,
          title: PLACEHOLDER_TITLE,
          url: PLACEHOLDER_TIKTOK_URL,
          author: PLACEHOLDER_AUTHOR,
        }),
        userPrompt: buildShortVideoUserPrompt({
          transcript: PLACEHOLDER_FLAT_TRANSCRIPT,
          frames: PLACEHOLDER_KEYFRAMES,
        }),
      };
    case "x-video":
      return {
        pieces: shortVideoSystemPromptPieces(X_VIDEO_PROMPT_SPEC, {
          preset: preset!,
          title: PLACEHOLDER_TITLE,
          url: PLACEHOLDER_XVIDEO_URL,
          author: PLACEHOLDER_AUTHOR,
        }),
        userPrompt: buildShortVideoUserPrompt({
          transcript: PLACEHOLDER_FLAT_TRANSCRIPT,
          frames: PLACEHOLDER_KEYFRAMES,
        }),
      };
    case "x-article":
      return {
        pieces: xArticleSystemPromptPieces({
          title: PLACEHOLDER_TITLE,
          author: PLACEHOLDER_AUTHOR,
          url: PLACEHOLDER_XARTICLE_URL,
        }),
        // The pasted article IS the user prompt — there is no builder to call,
        // so the skeleton is the placeholder body itself rather than an
        // invented wrapper around it.
        userPrompt: PLACEHOLDER_ARTICLE_TEXT,
      };
    case "article":
      return {
        pieces: articleSystemPromptPieces({
          title: PLACEHOLDER_TITLE,
          author: PLACEHOLDER_AUTHOR,
          url: PLACEHOLDER_ARTICLE_URL,
        }),
        userPrompt: PLACEHOLDER_ARTICLE_TEXT,
      };
    case "anthropic":
      return {
        pieces: anthropicSystemPromptPieces({
          framing: "anthropic",
          title: PLACEHOLDER_TITLE,
          url: PLACEHOLDER_ANTHROPIC_URL,
        }),
        userPrompt: PLACEHOLDER_ARTICLE_TEXT,
      };
    default:
      throw new Error(`No prompt builder is wired for capture source ${source.id}`);
  }
}

function buildCell(
  source: PromptMatrixSource,
  preset: CapturePreset | null,
  bot: BotConfig,
): PromptMatrixCell {
  const { pieces, userPrompt } = cellPrompts(source, preset);
  // The kind decides the run, EXCEPT where the vertical overrides it — see
  // `runOverride`. Merged rather than replaced: the short-video rows override
  // the budget and leave `deep`'s opus swap alone.
  const run = { ...(preset?.run ?? source.run), ...(source.runOverride ?? {}) };
  const chips = [
    ...(preset === null ? [noKindChip(source.envelope)] : []),
    ...pieceChips(pieces, preset),
    `frames: ${source.framesNote}`,
    ...(source.readsVisualDetail
      ? [`visual detail: ${VISUAL_DETAIL_LABELS[DEFAULT_VISUAL_DETAIL].toLowerCase()}`]
      : []),
    ...runChips(run),
  ];
  return {
    sourceId: source.id,
    kindId: preset?.id ?? null,
    kindLabel: preset?.label ?? null,
    chips,
    systemPieces: pieces,
    systemPrompt: joinPromptPieces(pieces),
    userPrompt,
    takeawayPrompt: buildTakeawayCheckPrompt(PLACEHOLDER_SUMMARY_BODY, PLACEHOLDER_TAKEAWAY),
    override: preset === null ? null : overrideFor(bot, preset.id),
  };
}

/**
 * The whole matrix for one bot.
 *
 * The kind columns are `resolveCapturePresets(bot.prompts, bot.connector)` —
 * the same resolution the Vimeo route validates a POSTed kind against, so a kind
 * this page shows is a kind that bot can actually run, and a `deep` column is
 * absent exactly where the connector cannot name the opus model.
 */
export function buildPromptMatrix(
  bot: BotConfig,
  allBots: readonly BotConfig[],
): PromptMatrix {
  const presets = resolveCapturePresets(bot.prompts, bot.connector);
  return {
    botName: bot.name,
    botDir: bot.dir,
    bots: allBots.map((b) => ({ name: b.name, connector: b.connector ?? "claude-cli" })),
    kinds: presets.map((p) => ({ id: p.id, label: p.label })),
    visualDetail: DEFAULT_VISUAL_DETAIL,
    rows: PROMPT_MATRIX_SOURCES.map((source) => ({
      source,
      cells: source.kinds
        ? presets.map((preset) => buildCell(source, preset, bot))
        : [buildCell(source, null, bot)],
    })),
  };
}
