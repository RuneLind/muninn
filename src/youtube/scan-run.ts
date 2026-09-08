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
 * **`drawtext` is not available**, so a contact sheet carries no burned-in
 * labels: this machine's ffmpeg and the container images are built without the
 * font support (`ffmpeg -filters | grep drawtext` finds nothing), and a sheet
 * that fails to build on the hosts that matter is worse than one whose cell
 * order the prompt states. `selectionPrompt` names each sheet's cells row-major
 * instead.
 */

import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { getLog } from "../logging.ts";
import {
  ffmpegGrabFrame,
  framesTimeoutFor,
  runFfmpegQuiet,
  type CaptureFrame,
  type GrabFrame,
} from "../summaries/frames.ts";
import {
  CONTACT_SHEET,
  SCAN_SIGNATURE_BYTES,
  SCAN_SIGNATURE_HEIGHT,
  SCAN_SIGNATURE_WIDTH,
  YOUTUBE_SCAN_INTERVAL_SEC,
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
 * Tile the candidates into contact sheets, in time order.
 *
 * ffmpeg's `tile` filter reads an image SEQUENCE, so each sheet's cells are
 * copied into a scratch directory under contiguous names first. Copies rather
 * than symlinks: a link into a directory the job is about to delete is a sheet
 * that builds and then cannot be read, and a 320 px thumbnail is ~15 KB.
 *
 * A short last sheet is fine — `tile` pads the missing cells — and the prompt
 * lists only the cells that exist, so a padded cell is never a second the model
 * can name.
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
    for (let i = 0; i < plan.cells.length; i++) {
      await copyFile(
        input.thumbPathFor(plan.cells[i]!.tSeconds),
        join(cellDir, `${String(i + 1).padStart(3, "0")}.jpg`),
      );
    }
    await run(
      [
        "ffmpeg",
        "-v",
        "error",
        "-y",
        "-start_number",
        "1",
        "-i",
        join(cellDir, "%03d.jpg"),
        "-vf",
        `scale=${CONTACT_SHEET.cellWidth}:-2,tile=${CONTACT_SHEET.cols}x${CONTACT_SHEET.rows}`,
        "-frames:v",
        "1",
        "-q:v",
        "4",
        join(input.outDir, plan.fileName),
      ],
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
