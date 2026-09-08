/**
 * The dense scan against a REAL ffmpeg, on a video this file generates.
 *
 * The pure half (`scan.test.ts`) can assert the dedup over arrays it built; it
 * cannot assert that the filtergraph emits one thumbnail and one signature plane
 * per sample, in the same order, at the geometry the reader assumes — which is
 * the one thing that turns the whole dedup into noise when it is wrong. So this
 * builds a 30 s fixture with `ffmpeg -f lavfi` (a static colour, a cut to
 * another colour, then a moving pattern), runs the shipped pass over it, and
 * checks the counts and the two properties the calibration is about: the cut
 * survives, the static run does not.
 *
 * The fixture is SYNTHETIC and generated in-test — muninn is a public repo and
 * no capture material belongs in it.
 *
 * `ffmpeg` is not a test dependency of this repo (CI has no media binaries), so
 * every case skips itself and SAYS SO when it is missing — a silent skip reads
 * as a pass.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderLabelStrip, toPgm } from "./label.ts";
import {
  CONTACT_SHEET,
  CONTACT_SHEET_LABEL,
  SCAN_SIGNATURE_BYTES,
  cellLabelText,
  dedupeScanSamples,
  type ScanCandidate,
} from "./scan.ts";
import {
  buildContactSheets,
  contactSheetArgs,
  denseScanArgs,
  regrabFrames,
  runDenseScan,
} from "./scan-run.ts";

// BOTH binaries: `probeSize` below shells out to ffprobe, so a host with ffmpeg
// and no ffprobe would run the ffmpeg-gated cases and fail inside one of them.
// The skip line is PRINTED — a silent skip reads as a pass, and CI has no media
// binaries, so this is the only signal that these cases did not run there.
const media = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;
if (!media) {
  console.log(
    "scan-run.test.ts: SKIPPED — `ffmpeg` and `ffprobe` are not both on PATH " +
      "(the dense scan cannot be driven here).",
  );
}

const roots: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "yt-scan-run-"));
  roots.push(d);
  return d;
}
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/** 30 s at 320×180: 10 s solid red, 10 s solid blue, 10 s of a moving pattern. */
async function makeFixture(dir: string): Promise<string> {
  const out = join(dir, "fixture.mp4");
  const proc = Bun.spawn(
    [
      "ffmpeg", "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=320x180:r=10:d=10",
      "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=10:d=10",
      "-f", "lavfi", "-i", "testsrc=s=320x180:r=10:d=10",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1[v]",
      "-map", "[v]", "-pix_fmt", "yuv420p", out,
    ],
    { stdout: "ignore", stderr: "pipe", stdin: "ignore" },
  );
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`fixture build failed: ${err}`);
  return out;
}

/**
 * A 40 s CLOCK clip: the whole frame is one flat gray whose value encodes
 * `floor(t)`, with a hard CUT at 11.5 s — a non-multiple of the 5 s grid.
 *
 * The point of encoding the second in the picture is that it makes a sampling
 * SKEW visible. A fixture that only changes at multiples of the interval cannot
 * show one: a sample taken 2.5 s late still lands inside the same solid block,
 * so the counts and the dedup both agree with themselves while every file name
 * is a lie. Here the value moves every second, so the frame named `<t>.jpg`
 * either decodes back to `t` or it does not.
 *
 * Two slopes rather than one, because the cut is what a bucket cannot hide:
 * frames before 11.5 s are `20 + floor(t)·4` and after it `100 + floor(t)·3`,
 * two ranges that never meet, so a sample that crossed the cut is wrong by a
 * whole band and not by a step.
 */
async function makeClockFixture(dir: string): Promise<string> {
  const out = join(dir, "clock.mp4");
  const proc = Bun.spawn(
    [
      "ffmpeg", "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=160x90:r=30:d=40",
      "-vf", "geq=lum='if(lt(T,11.5),20+floor(T)*4,100+floor(T)*3)':cb=128:cr=128",
      "-pix_fmt", "yuv420p", out,
    ],
    { stdout: "ignore", stderr: "pipe", stdin: "ignore" },
  );
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`clock fixture build failed: ${err}`);
  return out;
}

/** The mean gray value of an image file, from one ffmpeg decode to raw gray. */
async function meanLuma(file: string): Promise<number> {
  const proc = Bun.spawn(
    ["ffmpeg", "-v", "error", "-i", file, "-vf", "format=gray", "-f", "rawvideo", "-"],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
  );
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  if ((await proc.exited) !== 0 || bytes.length === 0) throw new Error(`could not read ${file}`);
  let sum = 0;
  for (const b of bytes) sum += b;
  return sum / bytes.length;
}

/**
 * `second → mean gray value`, built by SEEKING into the clip rather than by
 * repeating the `geq` arithmetic here.
 *
 * The encoder scales full-range luma into video range and JPEG scales it back,
 * so the value in the file is not the value the filter wrote. Reading the truth
 * out of the same clip with the same decoder is what makes the comparison exact
 * without either side knowing that transform.
 */
async function lumaBySecond(file: string, seconds: number): Promise<number[]> {
  const dir = mkdtempSync(join(tmpdir(), "yt-clock-ref-"));
  roots.push(dir);
  const table: number[] = [];
  for (let t = 0; t < seconds; t++) {
    const out = join(dir, `${t}.jpg`);
    const proc = Bun.spawn(
      ["ffmpeg", "-v", "error", "-y", "-ss", `${t + 0.2}`, "-i", file, "-frames:v", "1",
        "-vf", "scale=320:-2", "-q:v", "4", out],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    if ((await proc.exited) !== 0) throw new Error(`reference grab failed at ${t}s`);
    table.push(await meanLuma(out));
  }
  return table;
}

/** Which second of the clock clip an image shows, by nearest reference value. */
function decodeSecond(luma: number, table: readonly number[]): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let t = 0; t < table.length; t++) {
    const d = Math.abs(table[t]! - luma);
    if (d < bestDistance) {
      bestDistance = d;
      best = t;
    }
  }
  return best;
}

describe("denseScanArgs", () => {
  // Pure, so it runs with or without ffmpeg — the argv is the contract.
  test("one decode feeding both outputs, at the shipped geometry", () => {
    const argv = denseScanArgs({ file: "/v.mp4", thumbPattern: "/o/%06d.jpg", signaturePath: "/o/s.gray" });
    const graph = argv[argv.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("fps=1/5");
    expect(graph).toContain("split=2");
    expect(graph).toContain(`scale=${CONTACT_SHEET.cellWidth}:-2`);
    expect(graph).toContain("format=gray");
    expect(argv).toContain("rawvideo");
    // Both outputs come off the one `-i`, which is what makes the signature free.
    expect(argv.filter((a) => a === "-i")).toHaveLength(1);
  });

  test("a non-integer interval is refused rather than handed to ffmpeg", () => {
    expect(() =>
      denseScanArgs({ file: "/v.mp4", thumbPattern: "/o/%06d.jpg", signaturePath: "/o/s.gray", intervalSec: 0 }),
    ).toThrow(/positive integer/);
  });
});

describe("contactSheetArgs", () => {
  // Pure, so it runs with or without ffmpeg — the filtergraph is the contract.
  const args = (n: number): string[] =>
    contactSheetArgs({
      cellPaths: Array.from({ length: n }, (_, i) => `/thumbs/${i}.jpg`),
      labelPaths: Array.from({ length: n }, (_, i) => `/cells/label-${i}.pgm`),
      outPath: "/select/sheet-01.jpg",
    });

  test("each cell is stacked over its own label before the grid is tiled", () => {
    const argv = args(3);
    const graph = argv[argv.indexOf("-filter_complex") + 1]!;
    // Input i is cell i and input n+i is its label — the pairing the caller's
    // two arrays imply, spelled once. Every INPUT INDEX is pinned, per cell:
    // asserting `[c0][l0]vstack…` and a bare `[3:v]` says nothing about which
    // input feeds `[l0]`, and mutating the pairing to `[${n + ((i + 1) % n)}:v]`
    // builds a real sheet where every cell carries its neighbour's caption.
    expect(graph).toContain(`[0:v]scale=${CONTACT_SHEET.cellWidth}:-2,setsar=1,format=yuv420p[c0]`);
    expect(graph).toContain(`[1:v]scale=${CONTACT_SHEET.cellWidth}:-2,setsar=1,format=yuv420p[c1]`);
    expect(graph).toContain(`[2:v]scale=${CONTACT_SHEET.cellWidth}:-2,setsar=1,format=yuv420p[c2]`);
    expect(graph).toContain("[3:v]setsar=1,format=yuv420p[l0]");
    expect(graph).toContain("[4:v]setsar=1,format=yuv420p[l1]");
    expect(graph).toContain("[5:v]setsar=1,format=yuv420p[l2]");
    // …and no OTHER input feeds a label. A positive-only assertion passes a
    // graph that also declares `[l0]` twice, or one that shifts the whole set.
    expect(graph).not.toContain("[4:v]setsar=1,format=yuv420p[l0]");
    expect(graph).not.toContain("[5:v]setsar=1,format=yuv420p[l1]");
    expect(graph).not.toContain("[3:v]setsar=1,format=yuv420p[l2]");
    expect(graph).toContain("[c0][l0]vstack=inputs=2[t0]");
    expect(graph).toContain("[c1][l1]vstack=inputs=2[t1]");
    expect(graph).toContain("[c2][l2]vstack=inputs=2[t2]");
    // …then one stream of labelled cells, tiled into the sheet.
    expect(graph).toContain("[t0][t1][t2]concat=n=3:v=1[seq]");
    expect(graph).toContain(`[seq]tile=${CONTACT_SHEET.cols}x${CONTACT_SHEET.rows}[sheet]`);
    expect(argv).toContain("[sheet]");
    expect(argv.at(-1)).toBe("/select/sheet-01.jpg");
  });

  test("the inputs are the cells and then the labels, in order", () => {
    const argv = args(2);
    const inputs = argv.filter((a, i) => argv[i - 1] === "-i");
    expect(inputs).toEqual(["/thumbs/0.jpg", "/thumbs/1.jpg", "/cells/label-0.pgm", "/cells/label-1.pgm"]);
  });

  test("a sheet with no cells, or one label short, is refused", () => {
    // A silently short sheet would pair cell 2 with cell 1's caption, which is
    // the exact lie the labels exist to prevent.
    expect(() => contactSheetArgs({ cellPaths: [], labelPaths: [], outPath: "/o.jpg" })).toThrow(/no cells/i);
    expect(() =>
      contactSheetArgs({ cellPaths: ["/a.jpg", "/b.jpg"], labelPaths: ["/a.pgm"], outPath: "/o.jpg" }),
    ).toThrow(/2 cell\(s\) and 1 label\(s\)/);
  });

  test("more cells than the grid holds is refused rather than silently dropped", () => {
    expect(() => args(CONTACT_SHEET.cols * CONTACT_SHEET.rows + 1)).toThrow(/13 cell\(s\)/);
  });
});

/** Burn `ms` of wall clock without yielding — a deadline test needs time to pass. */
function burn(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

// These two drive the seams (`grabFrame`, `run`) rather than ffmpeg, so they run
// on CI: what they pin is that each pass has ONE budget for all of its work.

describe("regrabFrames bounds the whole pass", () => {
  test("one aggregate deadline, not one per frame", async () => {
    const root = tmpRoot();
    const grabbed: number[] = [];
    await expect(
      regrabFrames({
        file: "/v.mp4",
        seconds: [0, 5, 10, 15, 20, 25],
        outDir: join(root, "frames"),
        height: 720,
        timeoutMs: 50,
        grabFrame: async (_file, sec) => {
          grabbed.push(sec);
          burn(30);
        },
      }),
    ).rejects.toThrow(/Frame re-grab timed out after 50ms/);
    // It stopped rather than running all six: forty frames each allowed their
    // own 15 s is ten minutes the job never announced.
    expect(grabbed.length).toBeGreaterThan(0);
    expect(grabbed.length).toBeLessThan(6);
  });

  test("a budget the pass fits inside grabs every second", async () => {
    const root = tmpRoot();
    const frames = await regrabFrames({
      file: "/v.mp4",
      seconds: [10, 0, 10],
      outDir: join(root, "frames"),
      height: 720,
      timeoutMs: 60_000,
      grabFrame: async () => {},
    });
    expect(frames.map((f) => f.tSeconds)).toEqual([0, 10]);
  });
});

describe("buildContactSheets bounds the whole pass", () => {
  /** Three sheets' worth of candidates, with a real file behind every thumbnail. */
  async function threeSheets(root: string): Promise<{
    candidates: ScanCandidate[];
    thumbPathFor: (sec: number) => string;
  }> {
    const thumbs = join(root, "thumbs");
    const candidates: ScanCandidate[] = [];
    for (let i = 0; i < CONTACT_SHEET.cols * CONTACT_SHEET.rows * 2 + 1; i++) {
      candidates.push({ index: i, tSeconds: i * 5, change: 1 });
      await Bun.write(join(thumbs, `${i * 5}.jpg`), "not really a jpeg");
    }
    return { candidates, thumbPathFor: (sec) => join(thumbs, `${sec}.jpg`) };
  }

  test("ONE deadline for every sheet, not one budget each", async () => {
    const root = tmpRoot();
    const { candidates, thumbPathFor } = await threeSheets(root);
    const handed: number[] = [];
    const plans = await buildContactSheets({
      candidates,
      thumbPathFor,
      outDir: join(root, "select"),
      scratchDir: join(root, "scratch"),
      timeoutMs: 10_000,
      run: async (_argv, timeoutMs) => {
        handed.push(timeoutMs);
        burn(20);
      },
    });
    expect(plans).toHaveLength(3);
    expect(handed).toHaveLength(3);
    expect(handed[0]!).toBeLessThanOrEqual(10_000);
    // Each sheet gets what is LEFT. Handed the same number three times, the pass
    // is bounded at three times the budget it was given.
    expect(handed[1]!).toBeLessThan(handed[0]!);
    expect(handed[2]!).toBeLessThan(handed[1]!);
  });

  test("every cell is handed to ffmpeg with a label strip of its own", async () => {
    // The mapping from a grid position to a second used to live only in the
    // prose beside the sheet, and fix round 1 measured the model mis-reading it
    // for four cells of one sheet. Each cell now carries its own caption, so
    // what this pins is that the caption reaches ffmpeg: one input per cell,
    // one PGM per cell, on disk, when the run is invoked.
    const root = tmpRoot();
    const { candidates, thumbPathFor } = await threeSheets(root);
    const sheetCells = candidates.slice(0, CONTACT_SHEET.cols * CONTACT_SHEET.rows);
    const seen: { argv: string[]; labelBytes: (Uint8Array | null)[] }[] = [];
    await buildContactSheets({
      candidates: sheetCells,
      thumbPathFor,
      outDir: join(root, "select"),
      scratchDir: join(root, "scratch"),
      timeoutMs: 30_000,
      run: async (argv) => {
        // Read INSIDE the run: the scratch cells are removed behind each sheet,
        // so a check afterwards would be checking deleted files.
        const labels = argv.filter((a) => a.endsWith(".pgm"));
        const labelBytes: (Uint8Array | null)[] = [];
        for (const p of labels) {
          labelBytes.push(existsSync(p) ? new Uint8Array(await Bun.file(p).arrayBuffer()) : null);
        }
        seen.push({ argv, labelBytes });
      },
    });

    expect(seen).toHaveLength(1);
    const { argv, labelBytes } = seen[0]!;
    const cells = CONTACT_SHEET.cols * CONTACT_SHEET.rows;
    const inputs = argv.filter((a, i) => argv[i - 1] === "-i");
    // Twelve thumbnails and twelve labels, thumbnails first — which is the
    // order the filtergraph pairs them in.
    expect(inputs).toHaveLength(cells * 2);
    expect(inputs.slice(0, cells).every((p) => p.endsWith(".jpg"))).toBe(true);
    expect(inputs.slice(cells).every((p) => p.endsWith(".pgm"))).toBe(true);
    expect(labelBytes).toHaveLength(cells);
    /** The strip this test expects under cell `n`, drawn from its own knowledge. */
    const expectedStrip = (n: number, tSeconds: number): Uint8Array =>
      toPgm(
        renderLabelStrip({
          text: cellLabelText(n, tSeconds),
          width: CONTACT_SHEET.cellWidth,
          height: CONTACT_SHEET_LABEL.height,
          scale: CONTACT_SHEET_LABEL.scale,
          padX: CONTACT_SHEET_LABEL.padX,
        }),
      );
    for (let i = 0; i < cells; i++) {
      const bytes = labelBytes[i];
      expect(bytes).not.toBeNull();
      // A binary PGM of exactly the cell width and the label height: ffmpeg
      // vstacks it under the cell, so a mismatched width is a failed sheet.
      expect(new TextDecoder().decode(bytes!.subarray(0, 16))).toStartWith(
        `P5\n${CONTACT_SHEET.cellWidth} ${CONTACT_SHEET_LABEL.height}\n255\n`,
      );
      expect(bytes!.length).toBeGreaterThan(CONTACT_SHEET.cellWidth * CONTACT_SHEET_LABEL.height);
      // Not a blank strip — a label with nothing drawn on it is the old failure
      // with extra pixels.
      expect(bytes!.some((v) => v === 255)).toBe(true);
      // …and it says what THIS cell is: `#i+1` and this candidate's own second,
      // both derived here from the candidate list rather than read back out of
      // the pass. A label naming the next cell is a counting mismatch of exactly
      // the kind the labels replaced.
      expect([...bytes!]).toEqual([...expectedStrip(i + 1, sheetCells[i]!.tSeconds)]);
      expect([...bytes!]).not.toEqual([...expectedStrip(i + 2, sheetCells[i]!.tSeconds)]);
      expect([...bytes!]).not.toEqual([...expectedStrip(i + 1, sheetCells[i]!.tSeconds + 5)]);
    }
  });

  test("a spent budget stops the pass rather than starting another sheet", async () => {
    const root = tmpRoot();
    const { candidates, thumbPathFor } = await threeSheets(root);
    let runs = 0;
    await expect(
      buildContactSheets({
        candidates,
        thumbPathFor,
        outDir: join(root, "select"),
        scratchDir: join(root, "scratch"),
        timeoutMs: 40,
        run: async () => {
          runs++;
          burn(30);
        },
      }),
    ).rejects.toThrow(/Contact sheets timed out after 40ms/);
    expect(runs).toBeLessThan(3);
  });
});

describe.skipIf(!media)("the scan against real ffmpeg", () => {
  test("one thumbnail and one signature per 5 s sample, named by second", async () => {
    const root = tmpRoot();
    const file = await makeFixture(root);
    const scan = await runDenseScan({ file, scanDir: join(root, "scan"), timeoutMs: 60_000 });

    // 30 s at one sample per 5 s.
    expect(scan.samples.map((s) => s.tSeconds)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(scan.signatures).toHaveLength(scan.samples.length);
    expect(scan.signatures[0]!.length).toBe(SCAN_SIGNATURE_BYTES);
    for (const s of scan.samples) {
      expect(s.path.endsWith(`${s.tSeconds}.jpg`)).toBe(true);
      expect(existsSync(s.path)).toBe(true);
    }
    // ffmpeg's own sequence numbers are gone: the dir says what it holds.
    expect(readdirSync(join(root, "scan")).filter((f) => /^\d{6}\.jpg$/.test(f))).toEqual([]);
  }, 120_000);

  /** The clock clip's samples, decoded back to the second each one shows. */
  async function decodeClockScan(root: string): Promise<{ named: number[]; shows: number[] }> {
    const file = await makeClockFixture(root);
    const reference = await lumaBySecond(file, 40);
    const scan = await runDenseScan({ file, scanDir: join(root, "scan"), timeoutMs: 120_000 });
    const shows: number[] = [];
    for (const sample of scan.samples) shows.push(decodeSecond(await meanLuma(sample.path), reference));
    return { named: scan.samples.map((s) => s.tSeconds), shows };
  }

  test("the sample named `<t>.jpg` IS the video at second t", async () => {
    // The property every consumer of this scan assumes and none of them could
    // check: the file name, the cell the prompt labels, the second the model
    // answers with, the `-ss` the re-grab seeks to and the URL the reader loads
    // are all the same number, so they must all be the same PICTURE.
    const { named, shows } = await decodeClockScan(tmpRoot());
    expect(shows).toEqual(named);
  }, 180_000);

  test("the cut at 11.5 s falls between the samples named 10 and 15", async () => {
    // The same property with no clock to read, which is what makes it a check
    // and not a restatement: 11.5 is a NON-multiple of the 5 s grid, sitting
    // between slot 10 and where a half-interval skew puts slot 10's picture. A
    // fixture that only changed at multiples of the interval would hide that
    // skew inside a bucket and pass.
    const { named, shows } = await decodeClockScan(tmpRoot());
    const at = (sec: number): number => shows[named.indexOf(sec)]!;
    expect(at(10)).toBeLessThan(11.5);
    expect(at(15)).toBeGreaterThan(11.5);
  }, 180_000);

  test("the dedup keeps the CUT and drops the static run", async () => {
    const root = tmpRoot();
    const file = await makeFixture(root);
    const scan = await runDenseScan({ file, scanDir: join(root, "scan"), timeoutMs: 60_000 });
    const kept = dedupeScanSamples(scan.signatures, scan.samples.map((s) => s.tSeconds));
    const seconds = kept.map((c) => c.tSeconds);

    // t=0 is the first sample; t=10 is red → blue.
    expect(seconds).toContain(0);
    expect(seconds).toContain(10);
    // t=5 is the second half of the solid-red run — nothing moved.
    expect(seconds).not.toContain(5);
    // t=15 is the second half of the solid-blue run.
    expect(seconds).not.toContain(15);
  }, 120_000);

  test("the sheets tile the candidates, and a short last sheet still builds", async () => {
    const root = tmpRoot();
    const file = await makeFixture(root);
    const scan = await runDenseScan({ file, scanDir: join(root, "scan"), timeoutMs: 60_000 });
    const thumbs = new Map(scan.samples.map((s) => [s.tSeconds, s.path] as const));
    const plans = await buildContactSheets({
      candidates: scan.samples.map((s, i) => ({ index: i, tSeconds: s.tSeconds, change: 1 })),
      thumbPathFor: (sec) => thumbs.get(sec)!,
      outDir: join(root, "select"),
      scratchDir: join(root, "scratch"),
      timeoutMs: 60_000,
    });

    // Six candidates is one short sheet of a twelve-cell grid.
    expect(plans).toHaveLength(1);
    expect(plans[0]!.cells).toHaveLength(6);
    const sheet = join(root, "select", plans[0]!.fileName);
    expect(existsSync(sheet)).toBe(true);
    // The full grid's width, padded — and every ROW is a 180 px cell plus its
    // burned-in label strip. This is the one place the composition is measured
    // rather than described: an argv that names the label inputs and a
    // filtergraph that drops them look identical from the caller.
    expect(await probeSize(sheet)).toEqual({
      width: CONTACT_SHEET.cols * CONTACT_SHEET.cellWidth,
      height: CONTACT_SHEET.rows * (180 + CONTACT_SHEET_LABEL.height),
    });
    // The scratch cells are cleaned up behind each sheet.
    expect(readdirSync(join(root, "scratch"))).toEqual([]);

    // The label band under the first cell carries INK on a dark ground — the
    // strip is not merely allocated, something is drawn in it. The fixture's
    // first cell is solid red, so every bright pixel in that band is glyph.
    const rowHeight = 180 + CONTACT_SHEET_LABEL.height;
    const band = (col: number, row: number): Promise<number[]> =>
      cropGray(
        sheet,
        col * CONTACT_SHEET.cellWidth,
        row * rowHeight + 180,
        CONTACT_SHEET.cellWidth,
        CONTACT_SHEET_LABEL.height,
      );
    const first = await band(0, 0);
    expect(Math.max(...first)).toBeGreaterThan(200);
    expect(first.filter((v) => v < 64).length / first.length).toBeGreaterThan(0.5);
    // The LAST real cell too (the 6th, row 2 column 2): every cell is captioned,
    // not only the one the eye lands on first.
    expect(Math.max(...(await band(1, 1)))).toBeGreaterThan(200);
    // …while the 7th slot is padding — `tile` fills it, so it carries no
    // caption, which is what the prompt tells the model to expect.
    expect(Math.max(...(await band(2, 1)))).toBeLessThan(200);
  }, 120_000);

  test("the re-grab writes `<second>.jpg` at the asked-for height", async () => {
    const root = tmpRoot();
    const file = await makeFixture(root);
    const frames = await regrabFrames({
      file,
      seconds: [22, 12, 12],
      outDir: join(root, "frames"),
      height: 180,
    });
    expect(frames.map((f) => f.tSeconds)).toEqual([12, 22]);
    for (const f of frames) expect(existsSync(f.path)).toBe(true);
    expect(readdirSync(join(root, "frames")).sort()).toEqual(["12.jpg", "22.jpg"]);
  }, 120_000);
});

/** A rectangle of an image as raw gray bytes, from one ffmpeg decode. */
async function cropGray(
  file: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<number[]> {
  const proc = Bun.spawn(
    ["ffmpeg", "-v", "error", "-i", file, "-vf", `crop=${w}:${h}:${x}:${y},format=gray`,
      "-f", "rawvideo", "-"],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
  );
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  if ((await proc.exited) !== 0 || bytes.length === 0) throw new Error(`could not crop ${file}`);
  return [...bytes];
}

/** The pixel size of an image, from ffprobe. */
async function probeSize(file: string): Promise<{ width: number; height: number }> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  const [width, height] = out.split(",").map(Number) as [number, number];
  return { width, height };
}
