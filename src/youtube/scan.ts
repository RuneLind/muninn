/**
 * Dense visual scan — the PURE half of the YouTube two-pass slides path.
 *
 * The cadence path (`extractCadenceFramesFromFile`) lays `frameBudgetFor`
 * ticks over a video: 30 frames over a 29-minute talk is one frame every ~59 s,
 * and a chart that is on screen for four seconds falls between two of them. The
 * dense path samples the whole video every {@link YOUTUBE_SCAN_INTERVAL_SEC}
 * seconds instead, throws away what did not change, hands the survivors to the
 * model as CONTACT SHEETS, and re-grabs only the frames it picked at full
 * height. Nothing else about the vertical moves: the re-grabbed frames are
 * ordinary {@link CaptureFrame}s and `framesPromptSection`, the visual-detail
 * policy, the enforcement pass and `keepReferencedFrames` all run unchanged.
 *
 * **Why a uniform grid rather than scene detection.** Measured on the reference
 * video (1767 s, an article walkthrough with an inset presenter), plain
 * `select='gt(scene,0.25)'` returns 27 candidates over the whole video and only
 * two in the 120–190 s window, missing two of the three named charts — the
 * presenter inset moves constantly and swamps a whole-frame scene score. A 10 s
 * grid catches two of the three; the third is on screen ~166–170 s and the 10 s
 * grid's 170 s cell already shows the next page. A 5 s grid catches all three,
 * and one sequential decode pass over the whole file costs 6.7 s wall
 * (353 samples, 5.3 MB of 320 px thumbnails). The change-aware detector — a
 * stabilization window, region comparison — stays an experiment.
 *
 * **Nothing here does I/O and nothing here spawns ffmpeg**, so the whole
 * decision surface (the grid, the dedup, the cap, the sheet arithmetic, the
 * manifest parse and the budget split) is unit-tested with no video. The pass
 * that runs it is `src/youtube/scan-run.ts`.
 *
 * **The signature is decoded by ffmpeg, not by Bun.** The scan asks one ffmpeg
 * process for two outputs off ONE decode — the 320 px thumbnails and a
 * {@link SCAN_SIGNATURE_WIDTH}×{@link SCAN_SIGNATURE_HEIGHT} grayscale plane per
 * sample, written as raw bytes — so the dedup compares small byte arrays and
 * never opens a JPEG. One ffmpeg process per sample would be 353 spawns and 353
 * seeks for the same work.
 */

import { formatHms } from "../summaries/frames.ts";

/**
 * Seconds between scan samples.
 *
 * 5, measured rather than chosen: on the reference video the three charts the
 * summary has to be able to show sit at ~130 s, ~150 s and ~166–170 s, and only
 * a 5 s grid lands inside all three windows (a 10 s grid's 170 s cell is already
 * the next page). It is also what makes the whole scan one decode: at 1 frame
 * per 5 s a 3-hour video is 2160 samples, which is 2160 JPEG writes and ~32 s of
 * decode, against the same single sequential read of the file.
 */
export const YOUTUBE_SCAN_INTERVAL_SEC = 5;

/**
 * The most candidates the selection pass is shown, after the dedup.
 *
 * 120 is ten {@link CONTACT_SHEET}s, which is ten images the selection pass
 * reads — well inside {@link YOUTUBE_FULL_READ_CAP} — while a full 3 h video's
 * 2160 samples would be 180 sheets. Past the cap, coverage is RESERVED before
 * change is ranked ({@link capScanCandidates}): a video whose second half is one
 * long screen-share must not lose its second half to a busy opening.
 */
export const YOUTUBE_CANDIDATE_CAP = 120;

/**
 * The most individual images either pass may be asked to read.
 *
 * The arithmetic, once: the selection pass reads
 * ceil(120 / 12) = **10** contact sheets, and the synthesis pass reads the
 * re-grabbed frames, which the selection manifest caps at 2 × `maxTotal` — 16
 * under `selected`, **40** under `detailed`. Both are under 60, which is where a
 * multi-turn image-reading session stops being one turn's worth of blocks
 * (`FRAME_BUDGET_MAX` in `src/video/media.ts` is the same number for the same
 * reason). The manifest cap is what enforces it; this constant is what that cap
 * is checked against.
 */
export const YOUTUBE_FULL_READ_CAP = 60;

/** Width of the grayscale signature plane ffmpeg writes per sample. */
export const SCAN_SIGNATURE_WIDTH = 32;
/** Height of that plane. 32×18 keeps a 16:9 frame's shape at 576 bytes. */
export const SCAN_SIGNATURE_HEIGHT = 18;
/** Bytes per sample in the raw signature stream — one gray byte per pixel. */
export const SCAN_SIGNATURE_BYTES = SCAN_SIGNATURE_WIDTH * SCAN_SIGNATURE_HEIGHT;

/**
 * The signature is compared in BLOCKS, not as a whole-frame mean.
 *
 * A whole-frame mean absolute difference cannot tell "the presenter's head moved
 * in the corner inset" from "the slide changed": both are a small average over
 * 576 pixels. Splitting the plane into {@link SCAN_BLOCK_COLS} ×
 * {@link SCAN_BLOCK_ROWS} blocks and counting how many blocks moved separates
 * them by construction — a talking head is one or two blocks of 48, a page turn
 * is most of them. No region POSITION is hardcoded anywhere: which blocks moved
 * is never asked, only how many.
 */
export const SCAN_BLOCK_COLS = 8;
export const SCAN_BLOCK_ROWS = 6;

/**
 * How far a block's mean gray value must move to count as changed, 0–255.
 *
 * 12 is above JPEG/scaling noise on a static frame (measured: a static run of
 * the reference video's title card moves 0–3 per block) and well below a page
 * turn.
 */
export const SCAN_BLOCK_DELTA = 12;

/**
 * The fraction of blocks that must have changed for a sample to be a new
 * candidate.
 *
 * Calibrated on the reference video, 353 samples over 1767 s (the table is in
 * the PR body): 0.15 brings them down to 110 candidates and keeps a frame inside
 * all three of the windows the summary has to be able to show. 0.10 keeps 158,
 * mostly the presenter inset moving; 0.20 already drops the second chart's whole
 * window, and 0.40 keeps only the third.
 */
export const SCAN_CHANGE_THRESHOLD = 0.15;

/**
 * The contact sheet's geometry — the NAMED benchmark variable this PR's
 * selection quality is read against.
 *
 * 4×3 at 320 px per cell is a 1280-wide sheet of twelve 320×180 cells; a slide's
 * heading and a chart's shape are legible there and a body-text paragraph is
 * not, which is the trade the selection pass is making (it is choosing which
 * frames to look at properly, not reading them). Twelve cells also makes
 * {@link YOUTUBE_CANDIDATE_CAP} exactly ten sheets.
 */
export const CONTACT_SHEET = { cols: 4, rows: 3, cellWidth: 320 } as const;

/** Cells per sheet — the one place the product of the geometry is spelled. */
export const CONTACT_SHEET_CELLS = CONTACT_SHEET.cols * CONTACT_SHEET.rows;

/**
 * Whole-scan ffmpeg budget, from the video's own duration.
 *
 * Measured decode-bound at ~0.18 s per source minute on this laptop (1767 s of
 * 720p H.264 in 6.7 s wall). 2 s per source minute is a generous multiple of
 * that — an order of magnitude — and the 60 s floor covers a short video whose
 * cost is dominated by process start and the JPEG writes rather than the decode.
 * At the 3 h frames cap this gives 360 s against a ~32 s expected pass.
 *
 * It bounds a HANG. Every scan failure, this timeout included, degrades to the
 * cadence path with a warn — never a failed capture.
 */
export function scanTimeoutFor(durationSec: number): number {
  const minutes = Number.isFinite(durationSec) ? Math.max(0, durationSec) / 60 : 0;
  return Math.max(60_000, Math.ceil(minutes * 2_000));
}

/**
 * The seconds `sampleCount` emitted samples sit at: `[0, 5, 10, …]`.
 *
 * The mapping from the i-th emitted sample back to its position in the video,
 * and the ONE place it is spelled — {@link denseScanArgs}' grid is anchored at
 * absolute zero (`fps=1/N:round=up:start_time=0`), so slot i IS second i × N,
 * and `runDenseScan` renames the emitted files through exactly this function.
 *
 * It takes a COUNT rather than a duration because the count is what the pass
 * has: a duration a fraction over a tick predicts one more sample than ffmpeg
 * emits, and a caller zipping the two lists by index would then hold a phantom
 * at the tail.
 */
export function scanSampleTimes(
  sampleCount: number,
  intervalSec: number = YOUTUBE_SCAN_INTERVAL_SEC,
): number[] {
  if (!Number.isInteger(intervalSec) || intervalSec <= 0) {
    throw new Error(`Scan interval must be a positive integer, got ${intervalSec}`);
  }
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < Math.floor(sampleCount); i++) out.push(i * intervalSec);
  return out;
}

/** One sample the scan kept: where it is in the video, and how much it moved. */
export interface ScanCandidate {
  /** Index into the scan's own sample sequence. */
  readonly index: number;
  /** Whole seconds into the video — also the thumbnail's file name. */
  readonly tSeconds: number;
  /**
   * Fraction of blocks that changed against the previous KEPT sample, 0–1. The
   * first sample has no predecessor and is reported as 1.
   */
  readonly change: number;
}

/**
 * Split the raw signature stream into one plane per sample.
 *
 * The stream is exactly `SCAN_SIGNATURE_BYTES` per sample with no header, so a
 * length that is not a multiple of it means the pass and this reader disagree
 * about the geometry — which would silently shift every comparison by a few
 * bytes and turn the dedup into noise. It throws rather than truncating.
 */
export function splitScanSignatures(bytes: Uint8Array): Uint8Array[] {
  if (bytes.length % SCAN_SIGNATURE_BYTES !== 0) {
    throw new Error(
      `The scan signature stream is ${bytes.length} bytes, not a multiple of ${SCAN_SIGNATURE_BYTES}`,
    );
  }
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += SCAN_SIGNATURE_BYTES) {
    out.push(bytes.subarray(i, i + SCAN_SIGNATURE_BYTES));
  }
  return out;
}

/**
 * The fraction of blocks whose mean gray value moved by at least
 * {@link SCAN_BLOCK_DELTA} between two signatures, 0–1.
 *
 * Pure arithmetic over the two planes; no block POSITION is given meaning, so a
 * change in the corner and a change in the middle count the same. Mismatched
 * lengths throw — a caller comparing planes of different geometry is comparing
 * nothing.
 */
export function blockChangeFraction(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== SCAN_SIGNATURE_BYTES || b.length !== SCAN_SIGNATURE_BYTES) {
    throw new Error(`A scan signature is ${SCAN_SIGNATURE_BYTES} bytes; got ${a.length} and ${b.length}`);
  }
  const blockW = SCAN_SIGNATURE_WIDTH / SCAN_BLOCK_COLS;
  const blockH = SCAN_SIGNATURE_HEIGHT / SCAN_BLOCK_ROWS;
  let changed = 0;
  for (let by = 0; by < SCAN_BLOCK_ROWS; by++) {
    for (let bx = 0; bx < SCAN_BLOCK_COLS; bx++) {
      let sum = 0;
      let n = 0;
      for (let y = 0; y < blockH; y++) {
        const row = (by * blockH + y) * SCAN_SIGNATURE_WIDTH + bx * blockW;
        for (let x = 0; x < blockW; x++) {
          sum += Math.abs(a[row + x]! - b[row + x]!);
          n++;
        }
      }
      if (n > 0 && sum / n >= SCAN_BLOCK_DELTA) changed++;
    }
  }
  return changed / (SCAN_BLOCK_COLS * SCAN_BLOCK_ROWS);
}

/**
 * Keep a sample when it differs from the previous KEPT one by at least
 * `threshold` of its blocks; drop it otherwise.
 *
 * Against the previous KEPT sample rather than the previous SAMPLE, which is the
 * whole point on a slow scroll: consecutive differences below the threshold
 * would each be dropped forever and a page that scrolls over a minute would
 * never produce a candidate, while the accumulated difference from the last
 * thing the model was shown crosses it exactly once per screenful.
 *
 * The first sample is always kept (there is nothing to compare it to). Pure and
 * deterministic — the same signatures give the same candidates.
 */
export function dedupeScanSamples(
  signatures: readonly Uint8Array[],
  times: readonly number[],
  threshold: number = SCAN_CHANGE_THRESHOLD,
): ScanCandidate[] {
  const n = Math.min(signatures.length, times.length);
  if (n === 0) return [];
  const out: ScanCandidate[] = [{ index: 0, tSeconds: times[0]!, change: 1 }];
  let previous = signatures[0]!;
  for (let i = 1; i < n; i++) {
    const change = blockChangeFraction(previous, signatures[i]!);
    if (change < threshold) continue;
    out.push({ index: i, tSeconds: times[i]!, change });
    previous = signatures[i]!;
  }
  return out;
}

/**
 * The fraction of {@link YOUTUBE_CANDIDATE_CAP} reserved for chronological
 * coverage before the rest is filled by how much a candidate moved.
 *
 * A third: ranking by change alone hands the whole cap to whichever stretch of
 * the video cuts most (an animated intro, a demo recording), so a talk whose
 * second half is one long screen-share would arrive at the selection pass with
 * nothing from its second half at all. A third of the cap spread evenly is a
 * floor on coverage, not a quota — the other two thirds still go to the most
 * distinct content wherever it is.
 */
export const SCAN_COVERAGE_RESERVE = 1 / 3;

/**
 * Thin the candidates down to `cap`, reserving chronological coverage first.
 *
 * Two steps, both deterministic: `floor(cap × SCAN_COVERAGE_RESERVE)` anchors
 * spread evenly across the candidate sequence, then the remaining slots filled
 * from the rest by descending change (ties broken by index, so the earlier
 * candidate wins). The answer is returned in TIME order — it is a list of
 * positions in a video, and every consumer reads it that way.
 */
export function capScanCandidates(
  candidates: readonly ScanCandidate[],
  cap: number = YOUTUBE_CANDIDATE_CAP,
): ScanCandidate[] {
  if (cap <= 0) return [];
  if (candidates.length <= cap) return [...candidates];
  const anchorCount = Math.min(cap, Math.max(1, Math.floor(cap * SCAN_COVERAGE_RESERVE)));
  const keep = new Set<number>();
  for (let i = 0; i < anchorCount; i++) {
    keep.add(
      anchorCount === 1 ? 0 : Math.round((i * (candidates.length - 1)) / (anchorCount - 1)),
    );
  }
  const rest = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ i }) => !keep.has(i))
    .sort((a, b) => b.c.change - a.c.change || a.i - b.i);
  for (const { i } of rest) {
    if (keep.size >= cap) break;
    keep.add(i);
  }
  return [...keep].sort((a, b) => a - b).map((i) => candidates[i]!);
}

/** One contact sheet: which sheet it is, and the candidates in its cells. */
export interface ContactSheetPlan {
  /** 1-based, matching the `sheet-NN.jpg` file name. */
  readonly number: number;
  readonly fileName: string;
  /** The cells, ROW-MAJOR — left to right, then top to bottom. */
  readonly cells: readonly ScanCandidate[];
}

/**
 * Lay the candidates out over sheets of {@link CONTACT_SHEET_CELLS} cells each,
 * in time order.
 *
 * The last sheet may be short; ffmpeg's `tile` pads the missing cells and the
 * prompt lists only the cells that exist, so a padded cell is never a second the
 * model can name.
 */
export function contactSheetPlans(candidates: readonly ScanCandidate[]): ContactSheetPlan[] {
  const out: ContactSheetPlan[] = [];
  for (let i = 0; i < candidates.length; i += CONTACT_SHEET_CELLS) {
    const number = out.length + 1;
    out.push({
      number,
      fileName: `sheet-${String(number).padStart(2, "0")}.jpg`,
      cells: candidates.slice(i, i + CONTACT_SHEET_CELLS),
    });
  }
  return out;
}

/** The categories the selection manifest may use. Anything else becomes `other`. */
export const SELECTION_CATEGORIES = [
  "chart",
  "diagram",
  "code",
  "text-excerpt",
  "screenshot",
  "other",
] as const;

export type SelectionCategory = (typeof SELECTION_CATEGORIES)[number];

/** One frame the selection pass asked for. */
export interface SelectionEntry {
  readonly tSeconds: number;
  readonly category: SelectionCategory;
  /** The model's own grouping of near-duplicates, when it offered one. */
  readonly duplicateGroup?: string;
  readonly reason: string;
}

/** What {@link parseSelectionManifest} made of the pass's answer. */
export interface SelectionManifest {
  readonly entries: SelectionEntry[];
  /** Seconds the answer named that this capture cannot serve, in the order they appeared. */
  readonly dropped: number[];
  /** Entries refused because the answer ran past `limit`. */
  readonly droppedOverCap: number;
}

/**
 * The most frames a selection manifest may ask for, given the visual-detail
 * policy's own total.
 *
 * Twice the policy's cap: the synthesis pass still applies the policy (the
 * prompt states it and `enforceVisualReferences` enforces it), so the selection
 * pass's job is to hand it a good SHORTLIST rather than the final set — and a
 * shortlist with no slack is a policy decision made by the pass that cannot see
 * the transcript. Twice 20 is 40, which is inside {@link YOUTUBE_FULL_READ_CAP}.
 */
export function selectionLimitFor(maxTotal: number): number {
  return Math.min(YOUTUBE_FULL_READ_CAP, Math.max(1, maxTotal * 2));
}

/**
 * A second in any spelling the answer may use: `137`, `137.5`, `"137"`, `"2:17"`,
 * `"00:02:17"`. NOT rounded — {@link parseSelectionManifest} snaps it to the
 * grid the sheets actually offered, which is a different question.
 */
function parseSecondsValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/s$/i, "");
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (!/^\d{1,6}(?::\d{1,6}){1,2}$/.test(raw)) return null;
  return raw.split(":").map(Number).reduce((total, part) => total * 60 + part, 0);
}

/** Every ```fenced``` block's body, in the order they appear. */
function fencedBlocks(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) out.push(match[1]!);
  return out;
}

/**
 * The index of the `]` that closes the `[` at `from`, or `-1`.
 *
 * A BALANCED walk, string-aware, because `indexOf("[")` … `lastIndexOf("]")` is
 * not a parser: one bracketed phrase in the prose around the answer — "reading
 * [sheet 1]" — makes that slice unparseable and throws away a whole paid model
 * call.
 */
function matchingBracket(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth <= 0) return depth === 0 && ch === "]" ? i : -1;
    }
  }
  return -1;
}

/** Every well-formed JSON array in `text`, outermost first, in the order they appear. */
function jsonArraysIn(text: string): unknown[][] {
  const out: unknown[][] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "[") continue;
    const end = matchingBracket(text, i);
    if (end < 0) continue;
    try {
      const parsed: unknown = JSON.parse(text.slice(i, end + 1));
      if (Array.isArray(parsed)) {
        out.push(parsed);
        i = end;
      }
    } catch {
      // Not JSON from here; the next `[` may still be.
    }
  }
  return out;
}

/** A JSON object — the only shape a manifest ENTRY can be. */
function isManifestRow(row: unknown): boolean {
  return row !== null && typeof row === "object" && !Array.isArray(row);
}

/**
 * The JSON array inside a model answer, however it wrapped it.
 *
 * EVERY fenced block is considered and then the whole text, and the first array
 * carrying an OBJECT wins — not the first array found. Two answers made the old
 * "first fence, else first-`[`-to-last-`]`" reading throw away a paid pass: one
 * that restated the schema (or listed the sheets it read) in a fence before
 * answering, and one whose prose carried a bracketed phrase of its own.
 *
 * An array with no objects in it — `[130, 145]`, `[null, null]` — is NOT an
 * empty manifest: it is a pass that answered in the wrong shape, and reading it
 * as "looked and found nothing" ships a slides capture with no slides and no
 * signal. Only a genuinely empty array means that, and it is taken only when no
 * array of objects was found anywhere.
 */
function extractJsonArray(text: string): unknown[] | null {
  const arrays: unknown[][] = [];
  for (const candidate of [...fencedBlocks(text), text]) arrays.push(...jsonArraysIn(candidate));
  const manifest = arrays.find((rows) => rows.some(isManifestRow));
  if (manifest !== undefined) return manifest;
  return arrays.some((rows) => rows.length === 0) ? [] : null;
}

/**
 * Read the selection pass's answer, held to this capture's own candidate set.
 *
 * Returns `null` — not an empty manifest — when nothing parses at all, because
 * the two are different outcomes with different remedies: an unparseable answer
 * is a failed pass and the capture falls back to the cadence path, while an
 * empty one is a pass that looked and found nothing worth showing.
 *
 * Everything else is held rather than trusted, the enforcement pass's rule one
 * layer earlier: a second that is not one of the candidates the sheets showed is
 * a frame this capture cannot re-grab, a repeat is one slot spent twice, and
 * anything past `limit` is over the cap the prompt stated. An unknown category
 * becomes `other` rather than dropping the entry — the category is a label on
 * the reason, not a gate.
 *
 * A second that is not on the grid is SNAPPED to it before it is held to the
 * candidate set: the sheets only ever offered multiples of `intervalSec`, so a
 * decimal read off a cell names a candidate this capture can serve, and
 * rounding it to the nearest whole second and then dropping it spends a sheet
 * read for nothing. What is REPORTED as dropped is the second the answer
 * actually named, so the warn says what the model said.
 */
export function parseSelectionManifest(
  answer: string,
  available: readonly number[],
  limit: number,
  intervalSec: number = YOUTUBE_SCAN_INTERVAL_SEC,
): SelectionManifest | null {
  const rows = extractJsonArray(answer);
  if (rows === null) return null;
  const offered = new Set(available);
  const seen = new Set<number>();
  const entries: SelectionEntry[] = [];
  const dropped: number[] = [];
  let droppedOverCap = 0;
  for (const row of rows) {
    if (!isManifestRow(row)) continue;
    const rec = row as Record<string, unknown>;
    const named = parseSecondsValue(rec.tSeconds ?? rec.t ?? rec.second ?? rec.seconds);
    const snapped = named === null || intervalSec <= 0
      ? named
      : Math.round(named / intervalSec) * intervalSec;
    const sec = named !== null && offered.has(named) ? named : snapped;
    if (sec === null || !offered.has(sec)) {
      if (named !== null) dropped.push(named);
      continue;
    }
    if (seen.has(sec)) continue;
    seen.add(sec);
    if (entries.length >= limit) {
      droppedOverCap++;
      continue;
    }
    const rawCategory = typeof rec.category === "string" ? rec.category.trim().toLowerCase() : "";
    const category = (SELECTION_CATEGORIES as readonly string[]).includes(rawCategory)
      ? (rawCategory as SelectionCategory)
      : "other";
    const group = typeof rec.duplicateGroup === "string" ? rec.duplicateGroup.trim() : "";
    entries.push({
      tSeconds: sec,
      category,
      ...(group !== "" ? { duplicateGroup: group } : {}),
      reason: typeof rec.reason === "string" ? rec.reason.trim() : "",
    });
  }
  entries.sort((a, b) => a.tSeconds - b.tSeconds);
  return { entries, dropped, droppedOverCap };
}

/** The system prompt for the selection pass — a picker, never a writer. */
export const SELECTION_SYSTEM_PROMPT =
  "You are picking which frames of a video are worth looking at in full resolution. " +
  "You answer with a JSON array and nothing else — no summary, no prose around it.";

/**
 * The selection pass's user prompt.
 *
 * **The cell labels are in the PROSE, not burned into the image.** ffmpeg's
 * `drawtext` filter needs a font build that this machine's ffmpeg (and the
 * container images) does not have — `ffmpeg -filters | grep drawtext` finds
 * nothing — so a sheet with labels drawn on it is a sheet that fails to build on
 * exactly the hosts that matter. The cells are laid out ROW-MAJOR and each
 * sheet's line names its cells in that order, which is a mapping the model can
 * apply without reading anything off the picture.
 */
export function selectionPrompt(input: {
  title: string;
  durationSec: number;
  sheets: readonly ContactSheetPlan[];
  sheetDir: string;
  limit: number;
}): string {
  const { cols, rows } = CONTACT_SHEET;
  const sheetLines = input.sheets
    .map((sheet) => {
      const cells = sheet.cells
        .map((cell, i) => `${i + 1}. t=${formatHms(cell.tSeconds)} (${cell.tSeconds})`)
        .join("  ");
      return `${input.sheetDir}/${sheet.fileName} — ${sheet.cells.length} cell(s): ${cells}`;
    })
    .join("\n");
  return (
    `Video: ${input.title} (${formatHms(input.durationSec)} long)\n\n` +
    `Below are ${input.sheets.length} contact sheet(s). Read EVERY one with the Read tool FIRST, ` +
    `batching many Read calls into one turn — never one sheet per message.\n\n` +
    `Each sheet is a ${cols}×${rows} grid of frames in TIME order, filled ROW-MAJOR: cell 1 is top-left, ` +
    `cell ${cols} is top-right, cell ${cols + 1} starts the second row. The line after each file name gives ` +
    `that sheet's cells in the same order, with each cell's timestamp and the integer second in brackets. ` +
    `A sheet may end with blank cells; they are padding and have no second.\n\n` +
    `${sheetLines}\n\n` +
    `Pick at most ${input.limit} frames that would help a reader explain, compare, verify or revisit a ` +
    `substantive point in this video: charts, diagrams, code, tables, and legible article or documentation ` +
    `excerpts are what you are looking for. A speaker talking through a chart is a reason to pick it, not a ` +
    `reason to leave it out, and a presenter's face in the frame does not disqualify the rest of it. Do not ` +
    `pick a title card, a frame that is only a speaker, or two frames of the same thing — when several cells ` +
    `show one thing, pick the clearest and give the others' group a name in \`duplicateGroup\`.\n\n` +
    `Answer with a JSON array and nothing else. One object per frame:\n` +
    "```json\n" +
    `[{"tSeconds": 130, "category": "chart", "duplicateGroup": "research-growth", "reason": "the growth chart the narrator reads out"}]\n` +
    "```\n" +
    `\`tSeconds\` is the integer in brackets for that cell and must be one of the seconds listed above. ` +
    `\`category\` is one of: ${SELECTION_CATEGORIES.join(", ")}. \`duplicateGroup\` is optional. ` +
    `\`reason\` is one short clause. Order does not matter.`
  );
}

/**
 * How long the selection pass may take.
 *
 * The floor is the shared capture floor's half — the pass reads at most ten
 * images and writes a few hundred bytes of JSON, so it is nothing like a
 * summarize call — plus 30 s per sheet, which is the same shape
 * `summarizeTimeoutFor` uses for frames. Ten sheets get 600 s.
 */
export function selectionTimeoutFor(sheetCount: number): number {
  return 300_000 + 30_000 * Math.max(0, sheetCount);
}

/**
 * The WHOLE budget a two-pass capture states up front: the selection pass's own
 * timeout plus a full synthesis call at the policy's frame cap.
 *
 * One number, decided before either call, because **nothing can abort an
 * in-flight connector call**: `executeOneShot` takes a `timeoutMs` and no
 * signal, so a deadline is arithmetic — a budget split between two calls and a
 * gate on the second — never a cancellation.
 */
export function twoPassBudgetFor(sheetCount: number, maxFrames: number, floorMs: number): number {
  return selectionTimeoutFor(sheetCount) + synthesisFloorFor(maxFrames, floorMs);
}

/**
 * The synthesis call's floor for a capture that may end up reading `maxFrames`
 * images — `summarizeTimeoutFor`'s answer, spelled through one helper so the
 * budget and the gate cannot use two different numbers.
 */
function synthesisFloorFor(maxFrames: number, floorMs: number): number {
  return Math.max(floorMs, 600_000 + Math.max(0, maxFrames - 30) * 24_000);
}

/** What the launch gate decided about the second pass. */
export interface TwoPassSplit {
  /** Whether the synthesis pass may start at all. */
  readonly launch: boolean;
  /** Its timeout, when it may. */
  readonly synthesisTimeoutMs: number;
  /** What was left of the whole budget when the gate ran. */
  readonly remainingMs: number;
}

/**
 * Split what is LEFT of the whole budget between the two passes, and refuse to
 * launch the second when there is not enough left for it to finish.
 *
 * The gate is the point: with no way to abort a running call, a synthesis pass
 * launched with 40 s of budget left does not stop at 40 s — it runs its own
 * timeout and the job overruns the number it stated. Refusing is a visible
 * failure with the stage named; launching is an invisible one.
 */
export function splitTwoPassBudget(input: {
  wholeMs: number;
  selectionElapsedMs: number;
  frameCount: number;
  floorMs: number;
}): TwoPassSplit {
  const remainingMs = Math.max(0, input.wholeMs - Math.max(0, input.selectionElapsedMs));
  const floor = synthesisFloorFor(input.frameCount, input.floorMs);
  return {
    launch: remainingMs >= floor,
    synthesisTimeoutMs: Math.max(floor, remainingMs),
    remainingMs,
  };
}

/** Which sampler a capture's slides run through. */
export type YouTubeFrameScanMode = "cadence" | "dense";

/** The env name the switch is spelled by — one string, shared with the parser's message. */
export const YOUTUBE_FRAME_SCAN_ENV = "YOUTUBE_FRAME_SCAN";

/**
 * `YOUTUBE_FRAME_SCAN` — the kill switch for this path.
 *
 * Unset ⇒ `dense`, the new default. A recognised value wins. **An UNRECOGNISED
 * value is `cadence`**, which is the opposite of `resolveServingProfile`'s
 * refuse-to-start rule and of `optionalEnvFlag`'s treat-as-off rule, for a
 * reason specific to what this variable is FOR: it exists so an operator can
 * turn the dense path off in one line and restart. A typo (`cadance`) that kept
 * the dense path running would be the switch failing at the one job it has, and
 * throwing at boot would take the whole process down over a capture-path
 * preference. So an unknown value degrades to the OLD behaviour and warns.
 */
export function resolveFrameScanMode(
  env: Record<string, string | undefined> = process.env,
): { mode: YouTubeFrameScanMode; unrecognized: string | null } {
  const raw = (env[YOUTUBE_FRAME_SCAN_ENV] ?? "").trim().toLowerCase();
  if (raw === "") return { mode: "dense", unrecognized: null };
  if (raw === "dense" || raw === "cadence") return { mode: raw, unrecognized: null };
  return { mode: "cadence", unrecognized: raw };
}
