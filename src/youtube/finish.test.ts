/**
 * The YouTube post-model tail, driven OUTSIDE a capture job — which is exactly
 * how PR 3's re-run will call it.
 *
 * The whole point of the extraction is that a caller who is not `summarizeVideo`
 * gets the same four steps: parse, enforce, copy, repair. These cases drive real
 * files through it, because the last two steps are a filesystem copy and a
 * rewrite that depends on what the copy managed.
 */

import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { configure, reset as resetLogging, type LogRecord } from "@logtape/logtape";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishYouTubeSummary } from "./finish.ts";
import type { CaptureFrame } from "../summaries/frames.ts";

const VIDEO_ID = "dQw4w9WgXcQ";
const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  await resetLogging();
});

/**
 * Configured PER TEST with `reset: true`, the `src/video/short-video-finish.test.ts` shape:
 * `bun test` runs many files in one process and any of them may have configured
 * logtape first, so a once-per-file `configure` is a sink another file can take
 * away.
 */
let logs: LogRecord[] = [];
beforeEach(async () => {
  logs = [];
  await configure({
    sinks: { capture: (r: LogRecord) => logs.push(r) },
    loggers: [
      { category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "error" },
    ],
    reset: true,
  });
});

/** Every record this TAIL wrote — not the frames seam's, which has its own category. */
function tailLogs(): LogRecord[] {
  return logs.filter((r) => r.category[1] === "youtube");
}

function tmpRoot(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

/** Frames on disk, at the given seconds — `missing` names ones that are listed but absent. */
function frames(seconds: readonly number[], missing: readonly number[] = []): {
  frames: CaptureFrame[];
  dir: string;
} {
  const dir = join(tmpRoot("yt-finish-work-"), "frames");
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    frames: seconds.map((t) => {
      const path = join(dir, `${t}.jpg`);
      if (!missing.includes(t)) writeFileSync(path, `jpeg-${t}`);
      return { path, tSeconds: t };
    }),
  };
}

function quote(sec: number): string {
  return `![Slide at 00:00:${String(sec).padStart(2, "0")}](/api/frames/youtube/${VIDEO_ID}/${sec}.jpg)`;
}

describe("finishYouTubeSummary", () => {
  test("parses the envelope and tells the caller the category once", async () => {
    const seen: string[] = [];
    const out = await finishYouTubeSummary({
      raw: "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n- point",
      jobId: "j1",
      videoId: VIDEO_ID,
      frames: [],
      visualDetail: "selected",
      framesRoot: tmpRoot("yt-finish-root-"),
      onCategory: (c) => seen.push(c),
    });
    expect(out.category).toBe("ai/rag");
    expect(out.summary).toBe("### Heading\n- point");
    expect(seen).toEqual(["ai/rag"]);
  });

  test("a quote of a second this capture never extracted is removed, not served", async () => {
    const root = tmpRoot("yt-finish-root-");
    const { frames: fs } = frames([30]);
    const out = await finishYouTubeSummary({
      raw: `CATEGORY: ai/rag\n\nSUMMARY:\n${quote(30)}\n\n${quote(99)}`,
      jobId: "j2",
      videoId: VIDEO_ID,
      frames: fs,
      visualDetail: "selected",
      framesRoot: root,
    });
    expect(out.summary).toContain(`/${VIDEO_ID}/30.jpg`);
    expect(out.summary).not.toContain(`/${VIDEO_ID}/99.jpg`);
    expect(out.referenced).toEqual([30]);
    expect(out.kept).toEqual([30]);
    expect(readdirSync(join(root, "youtube", VIDEO_ID))).toEqual(["30.jpg"]);
  });

  test("a frame the copy could NOT keep loses its reference from the stored text", async () => {
    const root = tmpRoot("yt-finish-root-");
    // Listed in the manifest, but the file was never written — the copy skips it.
    const { frames: fs } = frames([30, 60], [60]);
    const out = await finishYouTubeSummary({
      raw: `CATEGORY: ai/rag\n\nSUMMARY:\n${quote(30)}\n\n${quote(60)}`,
      jobId: "j3",
      videoId: VIDEO_ID,
      frames: fs,
      visualDetail: "selected",
      framesRoot: root,
    });
    expect(out.referenced).toEqual([30, 60]);
    expect(out.kept).toEqual([30]);
    expect(out.unserved).toEqual([60]);
    expect(out.summary).toContain(`/${VIDEO_ID}/30.jpg`);
    expect(out.summary).not.toContain(`/${VIDEO_ID}/60.jpg`);
  });

  test("the POLICY binds: `selected` caps the whole summary at eight distinct frames", async () => {
    const root = tmpRoot("yt-finish-root-");
    const seconds = Array.from({ length: 12 }, (_, i) => (i + 1) * 10);
    const { frames: fs } = frames(seconds);
    const out = await finishYouTubeSummary({
      raw: `CATEGORY: ai/rag\n\nSUMMARY:\n${seconds.map((s) => quote(s)).join("\n\n")}`,
      jobId: "j4",
      videoId: VIDEO_ID,
      frames: fs,
      visualDetail: "selected",
      framesRoot: root,
    });
    expect(out.selected).toEqual(seconds);
    expect(out.referenced).toHaveLength(8);
    expect(out.kept).toHaveLength(8);
  });

  test("the visual-detail argument is READ: an appendix survives `detailed` and is cut under `selected`", async () => {
    const inline = [10, 20, 30, 40];
    const appendix = [50, 60, 70, 80, 90, 100];
    const { frames: fs } = frames([...inline, ...appendix]);
    const raw =
      `CATEGORY: ai/rag\n\nSUMMARY:\n${inline.map((s) => quote(s)).join("\n\n")}\n\n` +
      `## Visual reference\n\n${appendix.map((s) => `${quote(s)}\nWhy this one is here.`).join("\n\n")}`;

    const selected = await finishYouTubeSummary({
      raw,
      jobId: "j5a",
      videoId: VIDEO_ID,
      frames: fs,
      visualDetail: "selected",
      framesRoot: tmpRoot("yt-finish-root-"),
    });
    const detailed = await finishYouTubeSummary({
      raw,
      jobId: "j5b",
      videoId: VIDEO_ID,
      frames: fs,
      visualDetail: "detailed",
      framesRoot: tmpRoot("yt-finish-root-"),
    });

    // `selected` has no appendix at all — the section goes whole, captions included.
    expect(selected.referenced).toEqual(inline);
    expect(selected.summary).not.toContain("## Visual reference");
    expect(selected.summary).not.toContain("Why this one is here.");
    // `detailed` keeps all ten, well under its 20-frame total.
    expect(detailed.referenced).toEqual([...inline, ...appendix]);
    expect(detailed.summary).toContain("## Visual reference");
    expect(detailed.summary).not.toBe(selected.summary);
  });

  test("the category is announced BEFORE the frame copy, not after it", async () => {
    // The ORDER is the property: the live card is told while the copies are
    // still pending, exactly as it was when this tail was inline. The injected
    // root starts empty, so what the callback sees IS the answer — a callback
    // moved below `await keepReferencedFrames` would see the copied file.
    const root = tmpRoot("yt-finish-root-");
    const { frames: fs } = frames([30]);
    // An ARRAY of snapshots, not one: it pins that the callback fired exactly
    // once as well as what it saw.
    const rootAtCategory: string[][] = [];
    const out = await finishYouTubeSummary({
      raw: `CATEGORY: ai/rag\n\nSUMMARY:\n${quote(30)}`,
      jobId: "j7",
      videoId: VIDEO_ID,
      frames: fs,
      visualDetail: "selected",
      framesRoot: root,
      onCategory: () => {
        rootAtCategory.push(readdirSync(root));
      },
    });
    expect(rootAtCategory).toEqual([[]]);
    // …and the copy really did land afterwards, so the emptiness above is an
    // ordering fact and not a run that copied nothing.
    expect(out.kept).toEqual([30]);
    expect(readdirSync(root)).toEqual(["youtube"]);
    expect(readdirSync(join(root, "youtube", VIDEO_ID))).toEqual(["30.jpg"]);
  });

  test("a copy failure does not fail the capture: the text comes back repaired, with a log line", async () => {
    // A regular FILE where the served root should be: `mkdir` inside the copy
    // fails with ENOTDIR, so the whole seam throws rather than one file failing.
    // The capture's text is already on the reader's screen at this point — a
    // throw here would turn a served-picture problem into a failed job.
    const rootFile = join(tmpRoot("yt-finish-root-"), "not-a-dir");
    writeFileSync(rootFile, "not a directory");
    const { frames: fs } = frames([30]);
    const out = await finishYouTubeSummary({
      raw: `CATEGORY: ai/rag\n\nSUMMARY:\nbefore\n\n${quote(30)}\n\nafter`,
      jobId: "j8",
      videoId: VIDEO_ID,
      frames: fs,
      visualDetail: "selected",
      framesRoot: rootFile,
    });
    expect(out.category).toBe("ai/rag");
    expect(out.kept).toEqual([]);
    expect(out.unserved).toEqual([30]);
    // The promise of a picture is removed rather than stored and then 404'd.
    expect(out.summary).not.toContain(`/${VIDEO_ID}/30.jpg`);
    expect(out.summary).toContain("before");
    expect(out.summary).toContain("after");
    expect(
      tailLogs().some(
        (r) => r.level === "error" && String(r.message).includes("keeping quoted frames failed"),
      ),
    ).toBe(true);
  });

  test("the tail logs under the VERTICAL's category, `muninn.youtube.summarizer`", async () => {
    // The searchable field, not the file name: the JSONL sink is queried by
    // category, and moving this code into `finish.ts` must not move the records
    // a saved query already selects.
    await finishYouTubeSummary({
      raw: `CATEGORY: ai/rag\n\nSUMMARY:\n${quote(30)}`,
      jobId: "j9",
      videoId: VIDEO_ID,
      // Listed but never written ⇒ the copy skips it ⇒ the repair warns.
      frames: frames([30], [30]).frames,
      visualDetail: "selected",
      framesRoot: tmpRoot("yt-finish-root-"),
    });
    const warn = tailLogs().find((r) => String(r.message).includes("were not copied"));
    expect(warn).toBeDefined();
    expect(warn!.category).toEqual(["muninn", "youtube", "summarizer"]);
  });

  test("nothing is copied for a transcript-only summary, and no directory is made", async () => {
    const root = tmpRoot("yt-finish-root-");
    const out = await finishYouTubeSummary({
      raw: "CATEGORY: ai/rag\n\nSUMMARY:\nno pictures here",
      jobId: "j6",
      videoId: VIDEO_ID,
      frames: [],
      visualDetail: "selected",
      framesRoot: root,
    });
    expect(out.kept).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });
});
