/**
 * The YouTube post-model tail, driven OUTSIDE a capture job — which is exactly
 * how PR 3's re-run will call it.
 *
 * The whole point of the extraction is that a caller who is not `summarizeVideo`
 * gets the same four steps: parse, enforce, copy, repair. These cases drive real
 * files through it, because the last two steps are a filesystem copy and a
 * rewrite that depends on what the copy managed.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishYouTubeSummary } from "./finish.ts";
import type { CaptureFrame } from "../summaries/frames.ts";

const VIDEO_ID = "dQw4w9WgXcQ";
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

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
