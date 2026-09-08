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
import { CONTACT_SHEET, SCAN_SIGNATURE_BYTES, dedupeScanSamples, type ScanCandidate } from "./scan.ts";
import { buildContactSheets, denseScanArgs, regrabFrames, runDenseScan } from "./scan-run.ts";

const ffmpeg = Bun.which("ffmpeg");
if (ffmpeg === null) {
  console.log("scan-run.test.ts: SKIPPED — no `ffmpeg` on PATH (the dense scan cannot be driven here).");
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

describe.skipIf(ffmpeg === null)("the scan against real ffmpeg", () => {
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
    // The full grid's width, padded — the geometry the prompt describes.
    expect(await probeSize(sheet)).toEqual({
      width: CONTACT_SHEET.cols * CONTACT_SHEET.cellWidth,
      height: CONTACT_SHEET.rows * 180,
    });
    // The scratch cells are cleaned up behind each sheet.
    expect(readdirSync(join(root, "scratch"))).toEqual([]);
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
