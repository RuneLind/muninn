/**
 * The VIMEO half of slides: `extractCadenceFrames`, which pulls one frame per
 * cadence tick out of a DASH manifest.
 *
 * Everything source-neutral — the cadence, the URL shape, the prompt section,
 * the id gate, the kept-frame copy/removal, the ffmpeg argv, the file-based
 * extractor — lives in `src/summaries/frames.ts` and is tested in
 * `src/summaries/frames.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVimeoManifest, VIMEO_MEDIA_HOST, type VimeoManifest } from "./media.ts";
import { CAPTURE_FRAME_HEIGHT, cadenceTimes } from "../summaries/frames.ts";
import { VIMEO_FRAME_HEIGHT, extractCadenceFrames } from "./frames.ts";

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
    // fix round 2 of #524: the fetched segments do not outlive the pass — the
    // work dir is what the model is handed as --add-dir, and holds only JPEGs.
    expect(readdirSync(work).filter((f) => f.startsWith("segment-"))).toEqual([]);
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

  test("the rendition is the smallest at least VIMEO_FRAME_HEIGHT tall — 720p when present, 1080p when 720p is missing", async () => {
    expect(VIMEO_FRAME_HEIGHT).toBe(720);
    // 720p absent and TWO renditions at least that tall (1080p, and a 1440p
    // cloned from it): the smallest of them is what the frames path fetches.
    const m = smallFixture();
    const r1080 = m.video.find((r) => r.height === 1080)!;
    const r1440 = {
      ...r1080,
      id: "rep-video-1440p",
      height: 1440,
      width: 2560,
      segments: r1080.segments.map((seg) => ({ ...seg, size: 7, url: seg.url.replace("rep-video-1080p", "rep-video-1440p") })),
    };
    const no720: VimeoManifest = {
      ...m,
      video: [...m.video.filter((r) => r.height !== 720).map((r) => ({ ...r, segments: r.segments.map((seg) => ({ ...seg, size: 7 })) })), r1440],
    };
    const { fetchImpl, fetched, grabFrame } = stubs();
    await extractCadenceFrames({ manifestUrl: MANIFEST_URL, manifest: no720, durationSec: 3, workDir: dir() }, { fetchImpl, grabFrame });
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((u) => u.includes("rep-video-1080p"))).toBe(true);
    expect(fetched.some((u) => u.includes("rep-video-1440p"))).toBe(false);
  });
});

test("VIMEO_FRAME_HEIGHT is the shared capture height, not a second copy of 720", () => {
  // The two verticals pull frames at the same height for the same reason; the
  // Vimeo name survives because this module's own extractor reads it.
  expect(VIMEO_FRAME_HEIGHT).toBe(CAPTURE_FRAME_HEIGHT);
});
