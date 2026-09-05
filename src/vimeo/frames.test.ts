import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAME_BUDGET_MAX, frameBudgetFor } from "../video/media.ts";
import { parseVimeoManifest, VIMEO_MEDIA_HOST, type VimeoManifest } from "./media.ts";
import {
  MAX_INLINE_SLIDES,
  VIMEO_FRAME_HEIGHT,
  cadenceTimes,
  extractCadenceFrames,
  formatHms,
  frameUrlPath,
  framesPromptSection,
  framesTimeoutFor,
  keepReferencedFrames,
  referencedFrameSeconds,
  type VimeoFrame,
} from "./frames.ts";

const FIXTURE_RAW = JSON.parse(
  readFileSync(new URL("./fixtures/manifest-placeholder.json", import.meta.url).pathname, "utf8"),
);
const MANIFEST_URL = `https://${VIMEO_MEDIA_HOST}/exp=0~acl=p~hmac=p/0/psid=p/v2/playlist/av/primary/prot/p/playlist.json`;

function fixture(): VimeoManifest {
  return parseVimeoManifest(FIXTURE_RAW);
}

/**
 * The fixture with every 720p segment DECLARING 7 bytes, so the 8-byte stub
 * body below is the live shape (declared + 1) and passes `downloadRendition`'s
 * short-segment check rather than being refused against a 371 KB declaration.
 */
function smallFixture(): VimeoManifest {
  const m = fixture();
  return {
    ...m,
    video: m.video.map((r) => (r.height === 720 ? { ...r, segments: r.segments.map((seg) => ({ ...seg, size: 7 })) } : r)),
  };
}
const dir = () => mkdtempSync(join(tmpdir(), "vimeo-frames-"));

describe("cadenceTimes", () => {
  test("frameBudgetFor frames at slice MIDPOINTS, whole seconds, never t=0", () => {
    const t = cadenceTimes(3220);
    expect(t.length).toBe(frameBudgetFor(3220));
    expect(t.length).toBe(FRAME_BUDGET_MAX);
    expect(t[0]).toBe(Math.floor((0.5 * 3220) / 60)); // 26, not 0
    expect(t[t.length - 1]).toBeLessThan(3220);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]!);
    // ~54 s spacing at 53 min (the ceiling binds), all integers.
    expect(t.every((x) => Number.isInteger(x))).toBe(true);
    expect(t[1]! - t[0]!).toBeGreaterThanOrEqual(53);
  });

  test("a 10-min lightning talk gets 30 frames ~20 s apart; a 3 h talk 60 frames 180 s apart", () => {
    expect(cadenceTimes(600).length).toBe(30);
    expect(cadenceTimes(600)[1]! - cadenceTimes(600)[0]!).toBe(20);
    const long = cadenceTimes(10_800);
    expect(long.length).toBe(60);
    expect(long[1]! - long[0]!).toBe(180);
  });

  test("degenerate durations", () => {
    expect(cadenceTimes(0)).toEqual([]);
    expect(cadenceTimes(-5)).toEqual([]);
    expect(cadenceTimes(Number.NaN)).toEqual([]);
    // 15 frames in 3 s collapse onto 3 distinct whole seconds: no duplicates.
    const tiny = cadenceTimes(3);
    expect(new Set(tiny).size).toBe(tiny.length);
  });
});

describe("formatHms / frameUrlPath", () => {
  test("HH:MM:SS with hours, and the served path shape", () => {
    expect(formatHms(0)).toBe("00:00:00");
    expect(formatHms(1390)).toBe("00:23:10");
    expect(formatHms(3661.9)).toBe("01:01:01");
    expect(frameUrlPath("1223642971", 1390)).toBe("/api/vimeo/frames/1223642971/1390.jpg");
    expect(frameUrlPath("1", 12.7)).toBe("/api/vimeo/frames/1/12.jpg");
  });
});

describe("framesPromptSection", () => {
  const frames: VimeoFrame[] = [
    { path: "/work/26.jpg", tSeconds: 26 },
    { path: "/work/1390.jpg", tSeconds: 1390 },
  ];

  test("lists every frame as t=HH:MM:SS <path> and states the exact quote shape for THIS video", () => {
    const s = framesPromptSection("1223642971", frames);
    expect(s).toContain("t=00:00:26 /work/26.jpg");
    expect(s).toContain("t=00:23:10 /work/1390.jpg");
    expect(s).toContain("![Slide at HH:MM:SS](/api/vimeo/frames/1223642971/<sec>.jpg)");
    expect(s).toContain(`At most ${MAX_INLINE_SLIDES} slides`);
    expect(s).toContain("Read tool FIRST");
    expect(s).toContain("t=00:23:10 is the file 1390.jpg");
  });

  test("no frames ⇒ nothing appended", () => {
    expect(framesPromptSection("1", [])).toBe("");
  });
});

describe("referencedFrameSeconds", () => {
  test("the seconds this video's quoted frames name, deduped and sorted; other videos' paths ignored", () => {
    const summary =
      "Intro.\n\n![Slide at 00:23:10](/api/vimeo/frames/1223642971/1390.jpg)\n\n" +
      "![Slide at 00:00:26](/api/vimeo/frames/1223642971/26.jpg) and again " +
      "![x](/api/vimeo/frames/1223642971/1390.jpg)\n" +
      "![other](/api/vimeo/frames/999/26.jpg)\n" +
      "![abs](https://muninn.example/api/vimeo/frames/1223642971/50.jpg)";
    expect(referencedFrameSeconds(summary, "1223642971")).toEqual([26, 1390]);
    expect(referencedFrameSeconds(summary, "999")).toEqual([26]);
    expect(referencedFrameSeconds("no images here", "1223642971")).toEqual([]);
  });
});

describe("keepReferencedFrames", () => {
  test("copies ONLY the quoted frames into <root>/<videoId>/<sec>.jpg; an invented path is skipped", async () => {
    const work = dir();
    const root = dir();
    writeFileSync(join(work, "26.jpg"), "A");
    writeFileSync(join(work, "1390.jpg"), "B");
    writeFileSync(join(work, "2000.jpg"), "C");
    const frames: VimeoFrame[] = [26, 1390, 2000].map((t) => ({ path: join(work, `${t}.jpg`), tSeconds: t }));
    const summary =
      "![Slide at 00:23:10](/api/vimeo/frames/42/1390.jpg) ![Slide](/api/vimeo/frames/42/26.jpg) " +
      "![invented](/api/vimeo/frames/42/777.jpg)";
    const kept = await keepReferencedFrames(summary, "42", frames, root);
    expect(kept).toEqual([26, 1390]);
    expect(readdirSync(join(root, "42")).sort()).toEqual(["1390.jpg", "26.jpg"]);
    expect(readFileSync(join(root, "42", "1390.jpg"), "utf8")).toBe("B");
    expect(existsSync(join(root, "42", "2000.jpg"))).toBe(false);
    expect(existsSync(join(root, "42", "777.jpg"))).toBe(false);
  });

  test("a summary quoting nothing creates no directory", async () => {
    const root = dir();
    expect(await keepReferencedFrames("plain text", "42", [], root)).toEqual([]);
    expect(existsSync(join(root, "42"))).toBe(false);
  });
});

describe("framesTimeoutFor", () => {
  test("30 s + 3 s per frame", () => {
    expect(framesTimeoutFor(0)).toBe(30_000);
    expect(framesTimeoutFor(60)).toBe(210_000);
  });
});

describe("extractCadenceFrames", () => {
  /** Every segment fetch answers 8 bytes; the grab writes a marker file naming its inputs. */
  function stubs() {
    const fetched: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetched.push(url);
      return new Response(new Uint8Array(new ArrayBuffer(8)), { status: 200 });
    }) as unknown as typeof fetch;
    const grabs: { segmentFile: string; offsetSec: number; outPath: string }[] = [];
    const grabFrame = async (segmentFile: string, offsetSec: number, outPath: string) => {
      grabs.push({ segmentFile, offsetSec, outPath });
      writeFileSync(outPath, `${segmentFile}@${offsetSec}`);
    };
    return { fetchImpl, fetched, grabFrame, grabs };
  }

  test("one 720p segment per DISTINCT cadence segment, one frame per tick, offsets relative to the segment", async () => {
    // The fixture's renditions are 12 × ~6.08 s ≈ 73 s; a 73 s duration gets
    // 25 ticks (frameBudgetFor ≤ 180 s), several per segment. The fixture keeps
    // the live manifest's UNSORTED order, so 720p is found by height.
    const m = smallFixture();
    const durationSec = m.video.find((r) => r.height === 720)!.durationSec;
    const work = dir();
    const { fetchImpl, fetched, grabFrame, grabs } = stubs();
    const frames = await extractCadenceFrames({ manifestUrl: MANIFEST_URL, manifest: m, durationSec, workDir: work }, {
      fetchImpl,
      grabFrame,
    });
    const times = cadenceTimes(durationSec);
    expect(frames.map((f) => f.tSeconds)).toEqual(times);
    expect(frames.every((f) => f.path === join(work, `${f.tSeconds}.jpg`))).toBe(true);
    expect(grabs.length).toBe(times.length);
    // Distinct segments only: 25 ticks over 12 segments ⇒ ≤ 12 fetches, all 720p.
    expect(fetched.length).toBeLessThanOrEqual(12);
    expect(fetched.length).toBe(new Set(grabs.map((g) => g.segmentFile)).size);
    expect(fetched.every((u) => u.includes("rep-video-720p"))).toBe(true);
    // Every offset is t − segment.start (RELATIVE: input `-ss` on the fMP4 is
    // measured from its start_time), inside its segment — checked for every
    // tick, so a tick in segment 6 at t=40 s seeks ~3.5 s, not 40 s.
    const rep = m.video.find((r) => r.height === 720)!;
    expect(grabs.length).toBe(times.length);
    for (let k = 0; k < grabs.length; k++) {
      const g = grabs[k]!;
      const index = Number(/segment-(\d+)\.mp4$/.exec(g.segmentFile)![1]);
      const seg = rep.segments[index]!;
      expect(g.offsetSec).toBeGreaterThanOrEqual(0);
      expect(g.offsetSec).toBeLessThan(seg.end - seg.start);
      expect(g.offsetSec).toBeCloseTo(Math.max(0, Math.min(times[k]! - seg.start, seg.end - seg.start - 0.04)), 6);
    }
    expect(grabs.some((g) => !g.segmentFile.endsWith("segment-0.mp4"))).toBe(true);
    // The frame files exist in the work dir.
    expect(existsSync(frames[0]!.path)).toBe(true);
  });

  test("the offset is t − segment.start, clamped under the segment's end", async () => {
    const m = smallFixture();
    const rep = m.video.find((r) => r.height === 720)!;
    const work = dir();
    const { fetchImpl, grabFrame, grabs } = stubs();
    // Duration 3 s ⇒ ticks inside segment 0 only; t=0,1,2 → offsets 0,1,2.
    await extractCadenceFrames({ manifestUrl: MANIFEST_URL, manifest: m, durationSec: 3, workDir: work }, {
      fetchImpl,
      grabFrame,
    });
    expect(grabs.map((g) => g.offsetSec)).toEqual([0, 1, 2]);
    expect(grabs.every((g) => g.segmentFile.endsWith("segment-0.mp4"))).toBe(true);
    expect(rep.segments[0]!.start).toBe(0);
  });

  test("a manifest with no video rendition yields no frames and no fetch", async () => {
    const m: VimeoManifest = { ...smallFixture(), video: [] };
    const { fetchImpl, fetched, grabFrame } = stubs();
    const frames = await extractCadenceFrames(
      { manifestUrl: MANIFEST_URL, manifest: m, durationSec: 600, workDir: dir() },
      { fetchImpl, grabFrame },
    );
    expect(frames).toEqual([]);
    expect(fetched).toEqual([]);
  });

  test("a failing grab fails the PASS (no partial frame set), and the budget binds across frames", async () => {
    const m = smallFixture();
    const durationSec = m.video.find((r) => r.height === 720)!.durationSec;
    const { fetchImpl } = stubs();
    let calls = 0;
    const failing = async (_s: string, _o: number, out: string) => {
      calls++;
      if (calls === 3) throw new Error("ffmpeg frame grab failed (exit 1): boom");
      writeFileSync(out, "x");
    };
    await expect(
      extractCadenceFrames({ manifestUrl: MANIFEST_URL, manifest: m, durationSec, workDir: dir() }, {
        fetchImpl,
        grabFrame: failing,
      }),
    ).rejects.toThrow(/ffmpeg frame grab failed/);
    expect(calls).toBe(3);

    const slow = async (_s: string, _o: number, out: string) => {
      await new Promise((r) => setTimeout(r, 12));
      writeFileSync(out, "x");
    };
    await expect(
      extractCadenceFrames({ manifestUrl: MANIFEST_URL, manifest: m, durationSec, workDir: dir() }, {
        fetchImpl,
        grabFrame: slow,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/Frame extraction timed out after 30ms \(\d+\/\d+ frames\)/);
  });

  test("the rendition is the smallest at least VIMEO_FRAME_HEIGHT tall", () => {
    expect(VIMEO_FRAME_HEIGHT).toBe(720);
  });
});
