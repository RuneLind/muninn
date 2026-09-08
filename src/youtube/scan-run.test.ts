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
import { CONTACT_SHEET, SCAN_SIGNATURE_BYTES, dedupeScanSamples } from "./scan.ts";
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
