import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAME_BUDGET_MAX, frameBudgetFor } from "../video/media.ts";
import {
  FRAME_FILE_RE,
  FrameIdError,
  MAX_INLINE_SLIDES,
  VIMEO_FRAME_SOURCE,
  YOUTUBE_FRAME_SOURCE,
  cadenceTimes,
  decideFramesRootMigration,
  extractCadenceFramesFromFile,
  ffmpegFrameArgs,
  formatHms,
  frameSourceByName,
  frameUrlPath,
  framesPromptSection,
  framesRootHasEntries,
  framesTimeoutFor,
  isFrameId,
  keepReferencedFrames,
  migrateLegacyVimeoFramesRoot,
  referencedFrameSeconds,
  removeKeptFrames,
  removeKeptFramesForDocument,
  type CaptureFrame,
  type FrameSource,
} from "./frames.ts";

const dir = (prefix = "capture-frames-") => mkdtempSync(join(tmpdir(), prefix));

/** An id outside BOTH sources' charsets that is also a live regex pattern. */
const META_ID = "a.b|c(d)+ef"; // 11 chars, so length alone cannot be what refuses it
/**
 * The same, chosen so the PRE-SEAM raw interpolation demonstrably answers
 * WRONG rather than merely oddly: `\(/api/vimeo/frames/123456789|0/(\d{1,6})\.jpg\)`
 * is an alternation whose right branch is `0/(\d{1,6})\.jpg\)`, which matches
 * inside ANOTHER video's path — measured against origin/main, which answers
 * `[5]` for the summary below.
 */
const ALT_META_ID = "123456789|0";
/** A real YouTube id carrying the two non-alphanumeric characters the charset allows. */
const YT_ID = "dQw4-9W_gXQ";

describe("the sources", () => {
  test("vimeo is digits, youtube is 11 URL-safe base64 characters, and the metacharacter id fails BOTH", () => {
    expect(META_ID.length).toBe(11); // youtube's length gate alone would pass it
    expect(isFrameId(VIMEO_FRAME_SOURCE, "1223642971")).toBe(true);
    expect(isFrameId(VIMEO_FRAME_SOURCE, META_ID)).toBe(false);
    expect(isFrameId(YOUTUBE_FRAME_SOURCE, YT_ID)).toBe(true);
    expect(isFrameId(YOUTUBE_FRAME_SOURCE, META_ID)).toBe(false);
    for (const bad of ["..", ".", "", "../1223642971", "1223642971/..", "12a", " 123"]) {
      expect(isFrameId(VIMEO_FRAME_SOURCE, bad)).toBe(false);
    }
    // A leading zero is a second dedup key for one Vimeo video, but it IS digits —
    // the charset is about paths, `src/vimeo/url.ts` owns the identity rule.
    expect(isFrameId(VIMEO_FRAME_SOURCE, "0123")).toBe(true);
    expect(isFrameId(YOUTUBE_FRAME_SOURCE, "aircAruvnK")).toBe(false); // 10
    expect(isFrameId(YOUTUBE_FRAME_SOURCE, "aircAruvnKkX")).toBe(false); // 12
    expect(frameSourceByName("vimeo")).toBe(VIMEO_FRAME_SOURCE);
    expect(frameSourceByName("youtube")).toBe(YOUTUBE_FRAME_SOURCE);
    expect(frameSourceByName("tiktok")).toBeUndefined();
  });
});

describe("cadenceTimes", () => {
  test("frameBudgetFor frames at slice MIDPOINTS, whole seconds, never t=0", () => {
    const t = cadenceTimes(3220);
    expect(t.length).toBe(frameBudgetFor(3220));
    expect(t.length).toBe(FRAME_BUDGET_MAX);
    expect(t[0]).toBe(Math.floor((0.5 * 3220) / 60)); // 26, not 0
    expect(t[t.length - 1]).toBeLessThan(3220);
    for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThan(t[i - 1]!);
    expect(t.every((x: number) => Number.isInteger(x))).toBe(true);
    expect(t[1]! - t[0]!).toBeGreaterThanOrEqual(53);
  });

  test("a 10-min lightning talk gets 30 frames ~20 s apart; a 3 h talk 60 frames 180 s apart", () => {
    expect(cadenceTimes(600).length).toBe(30);
    expect(cadenceTimes(600)[1]! - cadenceTimes(600)[0]!).toBe(20);
    const long = cadenceTimes(10_800);
    expect(long.length).toBe(FRAME_BUDGET_MAX);
    expect(long[1]! - long[0]!).toBe(180);
  });

  test("a duration that is not a positive number yields nothing", () => {
    expect(cadenceTimes(0)).toEqual([]);
    expect(cadenceTimes(-1)).toEqual([]);
    expect(cadenceTimes(Number.NaN)).toEqual([]);
  });
});

describe("formatHms / frameUrlPath", () => {
  test("HH:MM:SS with hours, and the SOURCE-NEUTRAL served path shape", () => {
    expect(formatHms(0)).toBe("00:00:00");
    expect(formatHms(1390)).toBe("00:23:10");
    expect(formatHms(3661.9)).toBe("01:01:01");
    expect(frameUrlPath(VIMEO_FRAME_SOURCE, "1223642971", 1390)).toBe("/api/frames/vimeo/1223642971/1390.jpg");
    expect(frameUrlPath(VIMEO_FRAME_SOURCE, "1", 12.7)).toBe("/api/frames/vimeo/1/12.jpg");
    expect(frameUrlPath(YOUTUBE_FRAME_SOURCE, YT_ID, 47)).toBe(`/api/frames/youtube/${YT_ID}/47.jpg`);
  });

  test("an id outside the source's charset gets no address at all — a builder cannot invent one", () => {
    // The gate, not the route's: this runs before any request exists.
    expect(() => frameUrlPath(VIMEO_FRAME_SOURCE, "../../etc", 1)).toThrow(FrameIdError);
    expect(() => frameUrlPath(VIMEO_FRAME_SOURCE, META_ID, 1)).toThrow(FrameIdError);
    expect(() => frameUrlPath(YOUTUBE_FRAME_SOURCE, META_ID, 1)).toThrow(/Not a youtube video id/);
    expect(() => frameUrlPath(YOUTUBE_FRAME_SOURCE, "1223642971", 1)).toThrow(FrameIdError); // digits, wrong length
  });
});

describe("framesPromptSection", () => {
  const frames: CaptureFrame[] = [
    { path: "/work/26.jpg", tSeconds: 26 },
    { path: "/work/1390.jpg", tSeconds: 1390 },
  ];

  test("lists every frame as t=HH:MM:SS <path> and states the exact quote shape for THIS video", () => {
    const s = framesPromptSection(VIMEO_FRAME_SOURCE, "1223642971", frames);
    expect(s).toContain("t=00:00:26 /work/26.jpg");
    expect(s).toContain("t=00:23:10 /work/1390.jpg");
    expect(s).toContain("![Slide at HH:MM:SS](/api/frames/vimeo/1223642971/<sec>.jpg)");
    expect(s).toContain(`At most ${MAX_INLINE_SLIDES} slides`);
    expect(s).toContain("Read tool FIRST");
    expect(s).toContain("t=00:23:10 is the file 1390.jpg");
  });

  test("the quoted shape names the SOURCE, so a youtube prompt cannot ask for a vimeo path", () => {
    const s = framesPromptSection(YOUTUBE_FRAME_SOURCE, YT_ID, frames);
    expect(s).toContain(`![Slide at HH:MM:SS](/api/frames/youtube/${YT_ID}/<sec>.jpg)`);
    expect(s).not.toContain("/api/frames/vimeo/");
  });

  test("no frames ⇒ nothing appended; a bad id refuses even with no frames", () => {
    expect(framesPromptSection(VIMEO_FRAME_SOURCE, "1", [])).toBe("");
    expect(() => framesPromptSection(VIMEO_FRAME_SOURCE, "../x", [])).toThrow(FrameIdError);
  });
});

describe("referencedFrameSeconds", () => {
  test("the seconds this video's quoted frames name, deduped and sorted; other videos' paths ignored", () => {
    const summary =
      "Intro.\n\n![Slide at 00:23:10](/api/frames/vimeo/1223642971/1390.jpg)\n\n" +
      "![Slide at 00:00:26](/api/frames/vimeo/1223642971/26.jpg) and again " +
      "![x](/api/frames/vimeo/1223642971/1390.jpg)\n" +
      "![other](/api/frames/vimeo/999/26.jpg)\n" +
      "![abs](https://muninn.example/api/frames/vimeo/1223642971/50.jpg)";
    expect(referencedFrameSeconds(summary, VIMEO_FRAME_SOURCE, "1223642971")).toEqual([26, 1390]);
    expect(referencedFrameSeconds(summary, VIMEO_FRAME_SOURCE, "999")).toEqual([26]);
    expect(referencedFrameSeconds("no images here", VIMEO_FRAME_SOURCE, "1223642971")).toEqual([]);
  });

  test("a Vimeo document written BEFORE the seam quotes /api/vimeo/frames/, and a re-run must still keep those frames", () => {
    const legacy =
      "![Slide at 00:23:10](/api/vimeo/frames/1223642971/1390.jpg) " +
      "![Slide](/api/vimeo/frames/1223642971/26.jpg)";
    expect(referencedFrameSeconds(legacy, VIMEO_FRAME_SOURCE, "1223642971")).toEqual([26, 1390]);
    // Both spellings in one summary collapse into one set of seconds.
    const mixed = legacy + " ![new](/api/frames/vimeo/1223642971/26.jpg) ![new2](/api/frames/vimeo/1223642971/99.jpg)";
    expect(referencedFrameSeconds(mixed, VIMEO_FRAME_SOURCE, "1223642971")).toEqual([26, 99, 1390]);
    // The legacy prefix belongs to VIMEO only — youtube declares none.
    expect(YOUTUBE_FRAME_SOURCE.legacyUrlPrefix).toBeUndefined();
    expect(referencedFrameSeconds(`![x](/api/vimeo/frames/${YT_ID}/7.jpg)`, YOUTUBE_FRAME_SOURCE, YT_ID)).toEqual([]);
    expect(referencedFrameSeconds(`![x](/api/frames/youtube/${YT_ID}/7.jpg)`, YOUTUBE_FRAME_SOURCE, YT_ID)).toEqual([7]);
  });

  test("a ZERO-PADDED second is not a reference: the route serves 47.jpg, never 047.jpg, so counting it as kept would be a served 404", () => {
    expect(referencedFrameSeconds("![Slide](/api/frames/vimeo/42/047.jpg)", VIMEO_FRAME_SOURCE, "42")).toEqual([]);
    expect(
      referencedFrameSeconds("![zero](/api/frames/vimeo/42/0.jpg) ![ok](/api/frames/vimeo/42/47.jpg)", VIMEO_FRAME_SOURCE, "42"),
    ).toEqual([0, 47]);
    expect(referencedFrameSeconds("![padded zero](/api/frames/vimeo/42/00.jpg)", VIMEO_FRAME_SOURCE, "42")).toEqual([]);
  });

  test("an id outside the charset matches NOTHING — it is a live regex pattern, not an address", () => {
    // Interpolated raw (the pre-seam shape) an id carrying `|` is an
    // ALTERNATION whose right branch matches inside ANOTHER video's path, so
    // this summary — which names no such id anywhere — answered `[5]` on
    // origin/main. Gated, the answer is empty whatever the summary says.
    const anotherVideo = "![another video's slide](/api/frames/vimeo/1230/5.jpg)";
    expect(referencedFrameSeconds(anotherVideo, VIMEO_FRAME_SOURCE, ALT_META_ID)).toEqual([]);
    expect(referencedFrameSeconds(anotherVideo, YOUTUBE_FRAME_SOURCE, ALT_META_ID)).toEqual([]);
    expect(isFrameId(VIMEO_FRAME_SOURCE, ALT_META_ID)).toBe(false);
    expect(isFrameId(YOUTUBE_FRAME_SOURCE, ALT_META_ID)).toBe(false);
    expect(ALT_META_ID.length).toBe(11);
    // …and the id's OWN path is no more of a reference than anyone else's.
    const summary = `![x](/api/frames/vimeo/${META_ID}/5.jpg) ![y](/api/vimeo/frames/${META_ID}/7.jpg)`;
    expect(referencedFrameSeconds(summary, VIMEO_FRAME_SOURCE, META_ID)).toEqual([]);
    expect(referencedFrameSeconds(summary, YOUTUBE_FRAME_SOURCE, META_ID)).toEqual([]);
  });

  test("the id is ESCAPED as well as gated, so a permissive source cannot match a DIFFERENT video's path", () => {
    // The gate is what bounds this today; the escape is what keeps it bounded if
    // a source's charset is ever widened. Driven through a hand-built source.
    const permissive: FrameSource = { name: "youtube", idRe: /^.+$/ };
    expect(referencedFrameSeconds("![x](/api/frames/youtube/abc/5.jpg)", permissive, "a.c")).toEqual([]);
    expect(referencedFrameSeconds("![x](/api/frames/youtube/a.c/5.jpg)", permissive, "a.c")).toEqual([5]);
  });

  test("a REAL youtube id's - and _ survive escaping (they are literals in a pattern, and must stay matchable)", () => {
    expect(referencedFrameSeconds(`![x](/api/frames/youtube/${YT_ID}/12.jpg)`, YOUTUBE_FRAME_SOURCE, YT_ID)).toEqual([12]);
    // `-` is a metacharacter only inside a character class; escaping must not
    // turn the id into something that no longer matches its own path.
    expect(referencedFrameSeconds(`![x](/api/frames/youtube/${YT_ID}/12.jpg)`, YOUTUBE_FRAME_SOURCE, "dQw4x9WxgXQ")).toEqual([]);
  });
});

describe("keepReferencedFrames", () => {
  test("copies ONLY the quoted frames into <root>/<source>/<id>/<sec>.jpg; an invented path is skipped", async () => {
    const work = dir();
    const root = dir();
    writeFileSync(join(work, "26.jpg"), "A");
    writeFileSync(join(work, "1390.jpg"), "B");
    writeFileSync(join(work, "2000.jpg"), "C");
    const frames: CaptureFrame[] = [26, 1390, 2000].map((t) => ({ path: join(work, `${t}.jpg`), tSeconds: t }));
    const summary =
      "![Slide at 00:23:10](/api/frames/vimeo/42/1390.jpg) ![Slide](/api/frames/vimeo/42/26.jpg) " +
      "![invented](/api/frames/vimeo/42/777.jpg)";
    const kept = await keepReferencedFrames(
      summary + " ![padded](/api/frames/vimeo/42/02000.jpg)",
      VIMEO_FRAME_SOURCE,
      "42",
      frames,
      root,
    );
    expect(kept).toEqual([26, 1390]);
    expect(readdirSync(join(root, "vimeo", "42")).sort()).toEqual(["1390.jpg", "26.jpg"]);
    expect(readFileSync(join(root, "vimeo", "42", "1390.jpg"), "utf8")).toBe("B");
    expect(existsSync(join(root, "vimeo", "42", "2000.jpg"))).toBe(false);
    expect(existsSync(join(root, "vimeo", "42", "777.jpg"))).toBe(false);
    // The source is a directory level, so two verticals never share an id space.
    expect(existsSync(join(root, "42"))).toBe(false);
  });

  test("a summary quoting nothing creates no directory", async () => {
    const root = dir();
    expect(await keepReferencedFrames("plain text", VIMEO_FRAME_SOURCE, "42", [], root)).toEqual([]);
    expect(existsSync(join(root, "vimeo", "42"))).toBe(false);
  });

  test("an id outside the charset keeps NOTHING and creates nothing — including a traversal that would land outside the root", async () => {
    const work = dir();
    const root = join(dir(), "root");
    mkdirSync(root);
    writeFileSync(join(work, "5.jpg"), "X");
    const frames: CaptureFrame[] = [{ path: join(work, "5.jpg"), tSeconds: 5 }];
    for (const bad of ["../escape", "..", "12a", META_ID, ALT_META_ID]) {
      const summary =
        `![x](/api/frames/vimeo/${bad}/5.jpg) ![y](/api/vimeo/frames/${bad}/5.jpg) ` +
        "![another video's](/api/frames/vimeo/1230/5.jpg)";
      expect(await keepReferencedFrames(summary, VIMEO_FRAME_SOURCE, bad, frames, root)).toEqual([]);
    }
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(join(root, "..", "escape"))).toBe(false);
  });
});

describe("removeKeptFrames", () => {
  test("removes exactly that source's video directory; another source's same id is untouched", async () => {
    const root = dir("capture-frames-rm-");
    mkdirSync(join(root, "vimeo", "1223358361"), { recursive: true });
    writeFileSync(join(root, "vimeo", "1223358361", "1390.jpg"), "a");
    mkdirSync(join(root, "vimeo", "9999"), { recursive: true });
    writeFileSync(join(root, "vimeo", "9999", "10.jpg"), "b");
    mkdirSync(join(root, "youtube", YT_ID), { recursive: true });
    writeFileSync(join(root, "youtube", YT_ID, "10.jpg"), "c");

    expect(await removeKeptFrames(VIMEO_FRAME_SOURCE, "1223358361", root)).toBe(true);
    expect(existsSync(join(root, "vimeo", "1223358361"))).toBe(false);
    expect(readFileSync(join(root, "vimeo", "9999", "10.jpg"), "utf8")).toBe("b");
    expect(readFileSync(join(root, "youtube", YT_ID, "10.jpg"), "utf8")).toBe("c");
    expect(await removeKeptFrames(VIMEO_FRAME_SOURCE, "1223358361", root)).toBe(false);
    expect(await removeKeptFrames(VIMEO_FRAME_SOURCE, "55555", root)).toBe(false);
    expect(await removeKeptFrames(YOUTUBE_FRAME_SOURCE, YT_ID, root)).toBe(true);
  });

  test("an id outside the charset removes NOTHING, whatever path it spells", async () => {
    const root = dir("capture-frames-rm-");
    mkdirSync(join(root, "vimeo", "1223358361"), { recursive: true });
    writeFileSync(join(root, "vimeo", "1223358361", "1390.jpg"), "a");
    writeFileSync(join(root, "vimeo", "stray.txt"), "s");
    for (const bad of ["..", ".", "", "1223358361/..", "../1223358361", "stray.txt", "12a", " 1223358361", META_ID]) {
      expect(await removeKeptFrames(VIMEO_FRAME_SOURCE, bad, root)).toBe(false);
    }
    expect(existsSync(join(root, "vimeo", "1223358361", "1390.jpg"))).toBe(true);
    expect(existsSync(join(root, "vimeo", "stray.txt"))).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  test("a FILE named like a video id is not a directory and is left alone", async () => {
    const root = dir("capture-frames-rm-");
    mkdirSync(join(root, "vimeo"), { recursive: true });
    writeFileSync(join(root, "vimeo", "1223358361"), "not a directory");
    expect(await removeKeptFrames(VIMEO_FRAME_SOURCE, "1223358361", root)).toBe(false);
    expect(existsSync(join(root, "vimeo", "1223358361"))).toBe(true);
  });
});

describe("framesRootHasEntries", () => {
  test("scoped to <root>/<source>/ — another vertical's kept frames are not this one's", async () => {
    const root = dir("capture-frames-has-");
    expect(await framesRootHasEntries(VIMEO_FRAME_SOURCE, root)).toBe(false); // absent
    mkdirSync(join(root, "youtube", YT_ID), { recursive: true });
    writeFileSync(join(root, "youtube", YT_ID, "10.jpg"), "c");
    // The root now holds entries; this source's half still does not.
    expect(readdirSync(root)).toEqual(["youtube"]);
    expect(await framesRootHasEntries(VIMEO_FRAME_SOURCE, root)).toBe(false);
    expect(await framesRootHasEntries(YOUTUBE_FRAME_SOURCE, root)).toBe(true);
    mkdirSync(join(root, "vimeo", "42"), { recursive: true });
    expect(await framesRootHasEntries(VIMEO_FRAME_SOURCE, root)).toBe(true);
  });

  test("an EMPTY source dir is 'no' — an existing directory is not a kept frame", async () => {
    const root = dir("capture-frames-has-");
    mkdirSync(join(root, "vimeo"), { recursive: true });
    expect(await framesRootHasEntries(VIMEO_FRAME_SOURCE, root)).toBe(false);
  });
});

describe("removeKeptFramesForDocument", () => {
  function plant(): string {
    const root = dir("capture-frames-doc-");
    mkdirSync(join(root, "vimeo", "1223358361"), { recursive: true });
    writeFileSync(join(root, "vimeo", "1223358361", "1390.jpg"), "JPEG");
    return root;
  }

  test("the FAST PATH: a known video id removes the frames with NO resolveVideoId call", async () => {
    const root = plant();
    let resolves = 0;
    await removeKeptFramesForDocument(VIMEO_FRAME_SOURCE, "doc.md", "1223358361", {
      framesRoot: root,
      resolveVideoId: async () => {
        resolves++;
        return null;
      },
    });
    expect(resolves).toBe(0);
    expect(existsSync(join(root, "vimeo", "1223358361"))).toBe(false);
  });

  test("no known id: the source's frames dir is consulted FIRST, and an empty one costs no lookup", async () => {
    const empty = dir("capture-frames-doc-");
    let resolves = 0;
    await removeKeptFramesForDocument(VIMEO_FRAME_SOURCE, "doc.md", null, {
      framesRoot: empty,
      resolveVideoId: async () => {
        resolves++;
        return "1223358361";
      },
    });
    expect(resolves).toBe(0);

    // Another vertical's frames are not a reason to look this one up.
    const other = dir("capture-frames-doc-");
    mkdirSync(join(other, "youtube", YT_ID), { recursive: true });
    writeFileSync(join(other, "youtube", YT_ID, "1.jpg"), "x");
    await removeKeptFramesForDocument(VIMEO_FRAME_SOURCE, "doc.md", null, {
      framesRoot: other,
      resolveVideoId: async () => {
        resolves++;
        return "1223358361";
      },
    });
    expect(resolves).toBe(0);
  });

  test("no known id and kept frames present: the lookup runs and its answer is removed", async () => {
    const root = plant();
    let asked = "";
    await removeKeptFramesForDocument(VIMEO_FRAME_SOURCE, "talks/one.md", null, {
      framesRoot: root,
      resolveVideoId: async (documentId) => {
        asked = documentId;
        return "1223358361";
      },
    });
    expect(asked).toBe("talks/one.md");
    expect(existsSync(join(root, "vimeo", "1223358361"))).toBe(false);
  });

  test("an unresolvable document, and a THROWING lookup, both leave the frames in place without throwing", async () => {
    const root = plant();
    await removeKeptFramesForDocument(VIMEO_FRAME_SOURCE, "doc.md", null, {
      framesRoot: root,
      resolveVideoId: async () => null,
    });
    expect(existsSync(join(root, "vimeo", "1223358361", "1390.jpg"))).toBe(true);

    await removeKeptFramesForDocument(VIMEO_FRAME_SOURCE, "doc.md", null, {
      framesRoot: root,
      resolveVideoId: async () => {
        throw new Error("huginn is down");
      },
    });
    expect(existsSync(join(root, "vimeo", "1223358361", "1390.jpg"))).toBe(true);
  });
});

describe("framesTimeoutFor", () => {
  test("30 s + 3 s per frame", () => {
    expect(framesTimeoutFor(0)).toBe(30_000);
    expect(framesTimeoutFor(60)).toBe(210_000);
  });
});

describe("ffmpegFrameArgs", () => {
  test("a fast seek, one frame, and a scale that CANNOT upscale — the comma inside min() is escaped", () => {
    const args = ffmpegFrameArgs("/work/video.mp4", 1390, "/work/1390.jpg", 720);
    expect(args).toEqual([
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-ss",
      "1390.00",
      "-i",
      "/work/video.mp4",
      "-frames:v",
      "1",
      "-vf",
      "scale=-2:min(720\\,ih),format=yuvj420p",
      "-q:v",
      "3",
      "/work/1390.jpg",
    ]);
    // `-ss` BEFORE `-i` is the fast (index) seek; after it, ffmpeg decodes forward.
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    // A BARE comma would end the scale filter and make `ih)` a second filter.
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).toContain("min(720\\,ih)");
    expect(vf).not.toContain("min(720,ih)");
    expect(ffmpegFrameArgs("/v.mp4", 7.25, "/o.jpg", 360)).toContain("scale=-2:min(360\\,ih),format=yuvj420p");
  });
});

describe("extractCadenceFramesFromFile", () => {
  /** The grab seam: records its arguments and writes a marker file. */
  function stub() {
    const grabs: { file: string; offsetSec: number; outPath: string; height: number }[] = [];
    const grabFrame = async (file: string, offsetSec: number, outPath: string, height: number) => {
      grabs.push({ file, offsetSec, outPath, height });
      writeFileSync(outPath, `${file}@${offsetSec}`);
    };
    return { grabs, grabFrame };
  }

  test("one ABSOLUTE-seek grab per cadence tick, at the requested height, named <tick>.jpg", async () => {
    const out = dir();
    const { grabs, grabFrame } = stub();
    const frames = await extractCadenceFramesFromFile("/work/probe.mp4", 600, out, { height: 720, grabFrame });
    const times = cadenceTimes(600);
    expect(frames.map((f) => f.tSeconds)).toEqual(times);
    expect(grabs.map((g) => g.offsetSec)).toEqual(times); // absolute: the file starts at t=0
    expect(grabs.every((g) => g.file === "/work/probe.mp4" && g.height === 720)).toBe(true);
    expect(frames.every((f) => f.path === join(out, `${f.tSeconds}.jpg`))).toBe(true);
    expect(frames.every((f) => existsSync(f.path))).toBe(true);
    expect(readdirSync(out).sort()).toEqual(times.map((t) => `${t}.jpg`).sort());
  });

  test("every produced file name satisfies FRAME_FILE_RE and resolves through keepReferencedFrames", async () => {
    const out = dir();
    const root = dir();
    const { grabFrame } = stub();
    const frames = await extractCadenceFramesFromFile("/work/probe.mp4", 3220, out, { height: 720, grabFrame });
    expect(frames.length).toBe(FRAME_BUDGET_MAX);
    for (const f of frames) {
      expect(FRAME_FILE_RE.test(`${f.tSeconds}.jpg`)).toBe(true);
      expect(f.path.endsWith(`/${f.tSeconds}.jpg`)).toBe(true);
    }
    // Ticks are distinct integers by construction, so no two frames collide.
    expect(new Set(frames.map((f) => f.tSeconds)).size).toBe(frames.length);
    const summary = frames
      .slice(0, 3)
      .map((f) => `![Slide](${frameUrlPath(VIMEO_FRAME_SOURCE, "42", f.tSeconds)})`)
      .join(" ");
    const kept = await keepReferencedFrames(summary, VIMEO_FRAME_SOURCE, "42", frames, root);
    expect(kept).toEqual(frames.slice(0, 3).map((f) => f.tSeconds));
    expect(readdirSync(join(root, "vimeo", "42")).sort()).toEqual(
      frames.slice(0, 3).map((f) => `${f.tSeconds}.jpg`).sort(),
    );
  });

  test("the out dir is created, and a zero-length video grabs nothing", async () => {
    const parent = dir();
    const out = join(parent, "frames");
    const { grabs, grabFrame } = stub();
    await extractCadenceFramesFromFile("/work/probe.mp4", 60, out, { height: 720, grabFrame });
    expect(existsSync(out)).toBe(true);
    expect(grabs.length).toBe(cadenceTimes(60).length);

    const { grabs: none, grabFrame: g2 } = stub();
    expect(await extractCadenceFramesFromFile("/work/probe.mp4", 0, dir(), { height: 720, grabFrame: g2 })).toEqual([]);
    expect(none).toEqual([]);
  });

  test("a failing grab fails the PASS (no partial frame set), and the budget binds across frames", async () => {
    let calls = 0;
    const failing = async (_f: string, _o: number, outPath: string) => {
      calls++;
      if (calls === 3) throw new Error("ffmpeg frame grab failed (exit 1): boom");
      writeFileSync(outPath, "x");
    };
    await expect(
      extractCadenceFramesFromFile("/work/probe.mp4", 600, dir(), { height: 720, grabFrame: failing }),
    ).rejects.toThrow(/ffmpeg frame grab failed/);
    expect(calls).toBe(3);

    const slow = async (_f: string, _o: number, outPath: string) => {
      await new Promise((r) => setTimeout(r, 12));
      writeFileSync(outPath, "x");
    };
    await expect(
      extractCadenceFramesFromFile("/work/probe.mp4", 600, dir(), { height: 720, grabFrame: slow, timeoutMs: 30 }),
    ).rejects.toThrow(/Frame extraction timed out after 30ms \(\d+\/\d+ frames\)/);
  });
});

describe("the one-time frames-root rename", () => {
  test("the decision is over three facts, and BOTH roots existing refuses", () => {
    expect(decideFramesRootMigration({ oldExists: true, newExists: false, profile: "default" })).toBe("move");
    expect(decideFramesRootMigration({ oldExists: false, newExists: false, profile: "default" })).toBe("nothing");
    expect(decideFramesRootMigration({ oldExists: false, newExists: true, profile: "default" })).toBe("nothing");
    expect(decideFramesRootMigration({ oldExists: true, newExists: true, profile: "default" })).toBe("refuse");
    // nais registers no capture vertical, so it never writes under $HOME here.
    expect(decideFramesRootMigration({ oldExists: true, newExists: false, profile: "nais" })).toBe("refuse");
    expect(decideFramesRootMigration({ oldExists: true, newExists: true, profile: "nais" })).toBe("refuse");
  });

  test("it MOVES the old root under <framesRoot>/vimeo, and is a no-op on a second run", async () => {
    const home = dir("capture-frames-mig-");
    const legacy = join(home, "vimeo-frames");
    const framesRoot = join(home, "frames");
    mkdirSync(join(legacy, "1223358361"), { recursive: true });
    writeFileSync(join(legacy, "1223358361", "1390.jpg"), "JPEG");

    expect(await migrateLegacyVimeoFramesRoot("default", { legacyRoot: legacy, framesRoot })).toBe("move");
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(framesRoot, "vimeo", "1223358361", "1390.jpg"), "utf8")).toBe("JPEG");
    // The moved frames are exactly where the route now reads them.
    expect(await framesRootHasEntries(VIMEO_FRAME_SOURCE, framesRoot)).toBe(true);
    expect(await removeKeptFrames(VIMEO_FRAME_SOURCE, "1223358361", framesRoot)).toBe(true);

    expect(await migrateLegacyVimeoFramesRoot("default", { legacyRoot: legacy, framesRoot })).toBe("nothing");
  });

  test("a machine that never ran the vertical touches nothing", async () => {
    const home = dir("capture-frames-mig-");
    const framesRoot = join(home, "frames");
    expect(await migrateLegacyVimeoFramesRoot("default", { legacyRoot: join(home, "vimeo-frames"), framesRoot })).toBe(
      "nothing",
    );
    expect(existsSync(framesRoot)).toBe(false);
  });

  test("BOTH roots present: neither is touched — merging is a decision this has no basis for", async () => {
    const home = dir("capture-frames-mig-");
    const legacy = join(home, "vimeo-frames");
    const framesRoot = join(home, "frames");
    mkdirSync(join(legacy, "111"), { recursive: true });
    writeFileSync(join(legacy, "111", "1.jpg"), "OLD");
    mkdirSync(join(framesRoot, "vimeo", "222"), { recursive: true });
    writeFileSync(join(framesRoot, "vimeo", "222", "2.jpg"), "NEW");

    expect(await migrateLegacyVimeoFramesRoot("default", { legacyRoot: legacy, framesRoot })).toBe("refuse");
    expect(readFileSync(join(legacy, "111", "1.jpg"), "utf8")).toBe("OLD");
    expect(readFileSync(join(framesRoot, "vimeo", "222", "2.jpg"), "utf8")).toBe("NEW");
  });

  test("on nais it does not run, even with an old root present", async () => {
    const home = dir("capture-frames-mig-");
    const legacy = join(home, "vimeo-frames");
    const framesRoot = join(home, "frames");
    mkdirSync(join(legacy, "111"), { recursive: true });
    expect(await migrateLegacyVimeoFramesRoot("nais", { legacyRoot: legacy, framesRoot })).toBe("refuse");
    expect(existsSync(join(legacy, "111"))).toBe(true);
    expect(existsSync(framesRoot)).toBe(false);
  });
});
