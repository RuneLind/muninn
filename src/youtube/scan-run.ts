/**
 * Dense visual scan — the half that spawns ffmpeg.
 *
 * Three steps, each its own function so the summarizer reads as a sequence and
 * each one can fail on its own: {@link runDenseScan} (one decode pass over the
 * whole video), {@link buildContactSheets} (the tiled JPEGs the selection pass
 * reads) and {@link regrabFrames} (the chosen seconds at full height). Every
 * decision they act on — the grid, the dedup, the cap, the sheet layout — is
 * `src/youtube/scan.ts` and is pure.
 *
 * **The scan is ONE ffmpeg process, not one per sample.** A 3-hour video is 2160
 * samples; 2160 spawns, each seeking into the file, is not the same work done
 * slowly, it is different work. One `-filter_complex` with a `split` produces the
 * thumbnails and the dedup signatures off the SAME decode, so the signature
 * costs nothing beyond a second scaler.
 *
 * **Every cell carries a burned-in label, and it is FONT-FREE.** `drawtext`
 * needs a libfreetype build that this machine's ffmpeg and the container images
 * do not have (`ffmpeg -filters | grep drawtext` finds nothing), so the caption
 * is rendered in TypeScript instead — `src/youtube/label.ts` draws
 * `#<cell> HH:MM:SS` from a 5×7 glyph table into a raw PGM strip, and ffmpeg
 * stacks that strip under the cell like any other input. The prose list in
 * `selectionPrompt` stays as a second channel; it was the ONLY channel until fix
 * round 2, and the model could not apply it (four cells of one sheet named
 * wrong, measured on both `detailed` runs).
 */

import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { getLog } from "../logging.ts";
import {
  ffmpegGrabFrame,
  framesTimeoutFor,
  runFfmpegQuiet,
  type CaptureFrame,
  type GrabFrame,
} from "../summaries/frames.ts";
import { renderLabelStrip, toPgm } from "./label.ts";
import {
  CONTACT_SHEET,
  CONTACT_SHEET_CELLS,
  CONTACT_SHEET_LABEL,
  SCAN_SIGNATURE_BYTES,
  SCAN_SIGNATURE_HEIGHT,
  SCAN_SIGNATURE_WIDTH,
  YOUTUBE_SCAN_INTERVAL_SEC,
  cellLabelText,
  contactSheetPlans,
  scanSampleTimes,
  splitScanSignatures,
  type ContactSheetPlan,
  type ScanCandidate,
} from "./scan.ts";

const log = getLog("youtube", "scan");

/** One sampled frame: where its 320 px thumbnail is, and when it is. */
export interface ScanSample {
  readonly path: string;
  readonly tSeconds: number;
}

export interface DenseScanResult {
  readonly samples: ScanSample[];
  /** One {@link SCAN_SIGNATURE_BYTES}-byte plane per sample, in the same order. */
  readonly signatures: Uint8Array[];
}

/** The file the raw signature planes are written to, inside the scan dir. */
const SIGNATURE_FILE = "signatures.gray";
/** ffmpeg's own numbering for the emitted thumbnails, before they are renamed by second. */
const RAW_THUMB_PATTERN = "%06d.jpg";

/**
 * The argv for the one scan pass. Pure and exported so the filtergraph is
 * asserted rather than an ffmpeg run.
 *
 * **`round=up:start_time=0` is what makes the i-th sample second `i × N`, and a
 * bare `fps=1/N` does not.** The filter's default rounding is `near`: an input
 * frame at time t is assigned to output slot round(t/N) and the slot emits the
 * LAST frame that landed in it, so slot i carries the picture from just under
 * `i × N + N/2`. Measured two ways — a synthetic clock clip whose luma encodes
 * floor(t) returned seconds 2, 7, 12 … under slots 0, 5, 10 (`scan-run.test.ts`
 * drives exactly that), and on the 1767 s reference rendition 59 of the 110
 * candidates disagreed with an `-ss <t>` re-grab of their own second by more
 * than {@link SCAN_CHANGE_THRESHOLD}. Every consumer reads the number as exact:
 * the file name, the cell the prompt labels, the second the selection pass
 * answers with, the seek the re-grab performs and the URL the reader loads.
 *
 * `round=up` puts the frame at exactly `i × N` in slot i (the slot spans
 * `((i-1)·N, i·N]`), and `start_time=0` anchors the grid to absolute zero rather
 * than to the first frame's own timestamp, so a rendition that starts late does
 * not shift every name by a slot. With the same fixture both go from 51/110 to
 * 111/111 matching re-grabs. The alternative — `select` on source pts with
 * `-fps_mode passthrough` — samples correctly too but drops a slot wherever the
 * source has a gap longer than N, which silently renames every later sample;
 * `fps` fills such a slot instead, so the count-based mapping stays exact.
 *
 * **What "exact" means here is CONDITIONAL on the source being CFR, and the
 * condition is the price of that count-based mapping.** On a constant-frame-rate
 * source every sample IS the video at its own name. Across a source timestamp
 * GAP longer than N, `fps` fills the slot by REPEATING the last frame it decoded
 * before the gap — so the name is later than the picture. Measured on a lavfi
 * clock clip (luma encodes floor(t)) with the frames between 11.5 s and 19.5 s
 * dropped and the original pts kept: the sample named 15 carries the frame from
 * second 11 in both fixtures built, and whether the dedup then hides it depends
 * on the picture and NOT on the gap — with one gray level per second (a 5-level
 * step over 4 s, under the dedup's 12-level block delta) `blockChangeFraction` scored it
 * 0.000 and `dedupeScanSamples` dropped it, so second 15 was simply
 * unrepresented; with a 40-level step the same filled slot scored 1.000 and was
 * KEPT, named 15 and showing second 11. Nothing downstream can see that: the
 * count, the label, the manifest and the re-grab all read the same name, and the
 * re-grab's own `-ss 15` then serves a picture the selection pass never saw.
 * Bounding it would mean reading each emitted sample's real pts back
 * (`showinfo`) and naming samples from that, which is a change to the sampler
 * rather than to this argv; a YouTube ≤720p rendition with a hole of that size
 * is the case it would buy.
 *
 * The `split` feeds the same decoded frame to both scalers, so the signature
 * plane costs one extra scale and no extra decode.
 */
export function denseScanArgs(input: {
  file: string;
  thumbPattern: string;
  signaturePath: string;
  intervalSec?: number;
}): string[] {
  const interval = input.intervalSec ?? YOUTUBE_SCAN_INTERVAL_SEC;
  if (!Number.isInteger(interval) || interval <= 0) {
    throw new Error(`Scan interval must be a positive integer, got ${interval}`);
  }
  return [
    "ffmpeg",
    "-v",
    "error",
    "-y",
    "-i",
    input.file,
    "-filter_complex",
    `[0:v]fps=1/${interval}:round=up:start_time=0,split=2[a][b];` +
      `[a]scale=${CONTACT_SHEET.cellWidth}:-2[thumb];` +
      `[b]scale=${SCAN_SIGNATURE_WIDTH}:${SCAN_SIGNATURE_HEIGHT},format=gray[sig]`,
    "-map",
    "[thumb]",
    "-q:v",
    "4",
    input.thumbPattern,
    "-map",
    "[sig]",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    input.signaturePath,
  ];
}

/** One bounded ffmpeg run — the seam the sheet builder's tests drive in place of a spawn. */
export type RunFfmpeg = (argv: string[], timeoutMs: number, label: string) => Promise<void>;

/**
 * Sample the whole video every {@link YOUTUBE_SCAN_INTERVAL_SEC} seconds in one
 * decode, and hand back the thumbnails plus a signature plane each.
 *
 * The emitted files are RENAMED to `<second>.jpg` afterwards rather than being
 * left as ffmpeg's sequence numbers, so the scan directory says what it holds
 * and a debugging session does not have to redo the arithmetic. The seconds come
 * from the emitted COUNT, not from the duration: a duration that is a fraction
 * over a tick would predict one more sample than ffmpeg emits, and a caller that
 * zipped the two lists by index would then be off by nothing at the head and
 * hold a phantom at the tail.
 *
 * Throws on a disagreement between the two outputs — a signature stream whose
 * sample count is not the thumbnail count means the filtergraph and this reader
 * are describing different frames, which would silently compare each sample
 * against its neighbour's shadow.
 */
export async function runDenseScan(input: {
  file: string;
  scanDir: string;
  timeoutMs: number;
  intervalSec?: number;
}): Promise<DenseScanResult> {
  const interval = input.intervalSec ?? YOUTUBE_SCAN_INTERVAL_SEC;
  await mkdir(input.scanDir, { recursive: true });
  const signaturePath = join(input.scanDir, SIGNATURE_FILE);
  await runFfmpegQuiet(
    denseScanArgs({
      file: input.file,
      thumbPattern: join(input.scanDir, RAW_THUMB_PATTERN),
      signaturePath,
      intervalSec: interval,
    }),
    input.timeoutMs,
    "ffmpeg dense scan",
  );

  const emitted = (await readdir(input.scanDir))
    .filter((f) => /^\d{6}\.jpg$/.test(f))
    .sort();
  const signatures = splitScanSignatures(new Uint8Array(await Bun.file(signaturePath).arrayBuffer()));
  if (signatures.length !== emitted.length) {
    throw new Error(
      `The dense scan emitted ${emitted.length} thumbnail(s) and ${signatures.length} signature(s)`,
    );
  }
  if (emitted.length === 0) throw new Error("The dense scan emitted no frames");

  const samples: ScanSample[] = [];
  // ONE spelling of the slot → second mapping, shared with everything that reads
  // a scan sample's name back as a position in the video.
  const times = scanSampleTimes(emitted.length, interval);
  for (let i = 0; i < emitted.length; i++) {
    const tSeconds = times[i]!;
    const path = join(input.scanDir, `${tSeconds}.jpg`);
    await rename(join(input.scanDir, emitted[i]!), path);
    samples.push({ path, tSeconds });
  }
  log.info("Dense scan of {file}: {n} samples every {interval}s", {
    file: input.file,
    n: samples.length,
    interval,
  });
  return { samples, signatures };
}

/**
 * The argv for ONE labelled contact sheet. Pure and exported so the filtergraph
 * is asserted rather than an ffmpeg run.
 *
 * The inputs are the cells and THEN the labels — cell `i` is input `i` and its
 * label is input `n + i` — which is what lets the graph be written as a loop
 * rather than as an interleaving the caller has to match. Each pair is stacked
 * (`vstack`, the label under the picture), the stacked cells are concatenated
 * into one stream of frames, and `tile` lays that stream out over the grid,
 * padding a short last sheet exactly as it did when the cells were read as an
 * image sequence.
 *
 * `setsar=1` and `format=yuv420p` on both halves are what give the stack ONE
 * explicit pixel format on both branches. They are not what makes it possible:
 * a JPEG arrives as `yuvj420p` with a sample aspect of its own and a PGM as
 * `gray`, and measured on ffmpeg 8.0.1 that pair stacks with no normalisation at
 * all — exit 0, a 320×210 output, auto-negotiated to `yuvj444p`. That
 * negotiation is the reason to be explicit: what the stack comes out as would
 * otherwise be ffmpeg's choice from the two inputs' formats, so a differently
 * encoded rendition could change the sheet's own pixel format. The label strip
 * is written at exactly the cell width, so nothing scales it.
 *
 * A short or empty sheet is REFUSED rather than built: silently pairing cell 2
 * with cell 1's caption is the exact lie the labels exist to prevent.
 */
export function contactSheetArgs(input: {
  cellPaths: readonly string[];
  labelPaths: readonly string[];
  outPath: string;
}): string[] {
  const n = input.cellPaths.length;
  if (n === 0) throw new Error("A contact sheet with no cells cannot be built");
  if (n !== input.labelPaths.length) {
    throw new Error(`A contact sheet has ${n} cell(s) and ${input.labelPaths.length} label(s)`);
  }
  if (n > CONTACT_SHEET_CELLS) {
    throw new Error(`A contact sheet holds ${CONTACT_SHEET_CELLS} cells; got ${n} cell(s)`);
  }
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`[${i}:v]scale=${CONTACT_SHEET.cellWidth}:-2,setsar=1,format=yuv420p[c${i}]`);
    parts.push(`[${n + i}:v]setsar=1,format=yuv420p[l${i}]`);
    parts.push(`[c${i}][l${i}]vstack=inputs=2[t${i}]`);
  }
  const stacked = Array.from({ length: n }, (_, i) => `[t${i}]`).join("");
  parts.push(`${stacked}concat=n=${n}:v=1[seq]`);
  parts.push(`[seq]tile=${CONTACT_SHEET.cols}x${CONTACT_SHEET.rows}[sheet]`);
  return [
    "ffmpeg",
    "-v",
    "error",
    "-y",
    ...input.cellPaths.flatMap((p) => ["-i", p]),
    ...input.labelPaths.flatMap((p) => ["-i", p]),
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[sheet]",
    "-frames:v",
    "1",
    "-q:v",
    "4",
    input.outPath,
  ];
}

/**
 * Tile the candidates into contact sheets, in time order, each cell captioned
 * with its own second.
 *
 * The captions are rendered here — one PGM per cell, into the scratch directory,
 * removed behind each sheet — because a caption is what the selection pass reads
 * `tSeconds` off. A LABEL failure is a sheet failure and nothing more: it throws
 * out of this pass like any ffmpeg error, and the caller degrades to the cadence
 * sampler on the video it has already downloaded.
 *
 * A short last sheet is fine — `tile` pads the missing cells — and the prompt
 * lists only the cells that exist, so a padded cell is never a second the model
 * can name. Padding carries no label either, which is what the prompt tells the
 * model to expect.
 *
 * **`timeoutMs` is the budget for the WHOLE pass, not for each sheet.** Handed
 * to every sheet in turn it was a bound of `timeoutMs × sheetCount` — ten sheets
 * of a 3 h video would have been ten times 360 s, an hour of hang budget inside
 * a job whose whole stated budget is a quarter of that. The remainder is
 * recomputed before each sheet and the pass gives up rather than starting one
 * with nothing left.
 */
export async function buildContactSheets(input: {
  candidates: readonly ScanCandidate[];
  /** Where a candidate's 320 px thumbnail is, by second. */
  thumbPathFor: (tSeconds: number) => string;
  outDir: string;
  scratchDir: string;
  /** The whole pass's budget, shared by every sheet. */
  timeoutMs: number;
  /** Test seam for the ffmpeg run; production spawns. */
  run?: RunFfmpeg;
}): Promise<ContactSheetPlan[]> {
  const plans = contactSheetPlans(input.candidates);
  if (plans.length === 0) return [];
  const run = input.run ?? runFfmpegQuiet;
  const deadline = Date.now() + input.timeoutMs;
  await mkdir(input.outDir, { recursive: true });
  for (const plan of plans) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Contact sheets timed out after ${input.timeoutMs}ms ` +
          `(${plan.number - 1}/${plans.length} sheets)`,
      );
    }
    const cellDir = join(input.scratchDir, `cells-${plan.number}`);
    await rm(cellDir, { recursive: true, force: true });
    await mkdir(cellDir, { recursive: true });
    const cellPaths: string[] = [];
    const labelPaths: string[] = [];
    for (let i = 0; i < plan.cells.length; i++) {
      const cell = plan.cells[i]!;
      cellPaths.push(input.thumbPathFor(cell.tSeconds));
      const labelPath = join(cellDir, `label-${String(i + 1).padStart(3, "0")}.pgm`);
      await Bun.write(
        labelPath,
        toPgm(
          renderLabelStrip({
            // 1-based WITHIN THE SHEET, which is what the prompt's own list
            // counts — a cell's label and its line say the same `#n`.
            text: cellLabelText(i + 1, cell.tSeconds),
            width: CONTACT_SHEET.cellWidth,
            height: CONTACT_SHEET_LABEL.height,
            scale: CONTACT_SHEET_LABEL.scale,
            padX: CONTACT_SHEET_LABEL.padX,
          }),
        ),
      );
      labelPaths.push(labelPath);
    }
    await run(
      contactSheetArgs({ cellPaths, labelPaths, outPath: join(input.outDir, plan.fileName) }),
      remaining,
      `ffmpeg contact sheet ${plan.number}`,
    );
    await rm(cellDir, { recursive: true, force: true });
  }
  log.info("Built {n} contact sheet(s) of {cells} cells from {candidates} candidates", {
    n: plans.length,
    cells: CONTACT_SHEET.cols * CONTACT_SHEET.rows,
    candidates: input.candidates.length,
  });
  return plans;
}

/**
 * Re-grab the chosen seconds out of the still-present video at full frame
 * height — the frames the synthesis pass actually reads and the summary quotes.
 *
 * The scan's own thumbnails are 320 px wide and deliberately unreadable at
 * body-text size; these are the seam's ordinary {@link CaptureFrame}s, written
 * `<second>.jpg` into the work dir exactly as the cadence extractor writes them,
 * so everything downstream is unchanged.
 *
 * A failure on ONE frame fails the whole re-grab, the cadence extractor's rule:
 * the caller degrades the capture rather than shipping a summary whose manifest
 * silently lost an entry.
 *
 * **One AGGREGATE deadline for the pass**, `framesTimeoutFor` by default — the
 * same budget the cadence extractor runs under, and the same number
 * `twoPassBudgetFor` reserves for this step, so the announced budget covers it.
 * Per-frame timeouts alone bound no total: forty frames each allowed 15 s is ten
 * minutes this job never said it might spend.
 */
export async function regrabFrames(input: {
  file: string;
  seconds: readonly number[];
  outDir: string;
  height: number;
  grabFrame?: GrabFrame;
  /** Whole-pass budget; default {@link framesTimeoutFor}. */
  timeoutMs?: number;
}): Promise<CaptureFrame[]> {
  if (input.seconds.length === 0) return [];
  const grab = input.grabFrame ?? ffmpegGrabFrame;
  const seconds = [...new Set(input.seconds)].sort((a, b) => a - b);
  const timeoutMs = input.timeoutMs ?? framesTimeoutFor(seconds.length);
  const deadline = Date.now() + timeoutMs;
  await mkdir(input.outDir, { recursive: true });
  const frames: CaptureFrame[] = [];
  for (const sec of seconds) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Frame re-grab timed out after ${timeoutMs}ms (${frames.length}/${seconds.length} frames)`,
      );
    }
    const out = join(input.outDir, `${sec}.jpg`);
    await grab(input.file, sec, out, input.height);
    frames.push({ path: out, tSeconds: sec });
  }
  log.info("Re-grabbed {n} selected frame(s) from {file}", { n: frames.length, file: input.file });
  return frames;
}
